package adapters

// Unit tests for the OpenBao SecretProvider adapter against an in-process httptest server
// (non-gated; no real OpenBao needed). They assert request shape (paths, headers, bodies),
// that a known secret round-trips, and the ADR-0023 behaviors: token and Kubernetes auth,
// field-map caching, TTL-driven refetch, 404-as-empty, 403 re-auth + retry, the namespace
// header, custom-CA TLS, and fail-closed construction on misconfiguration.

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// clearVaultEnv blanks every KEEL_VAULT_* variable so a test starts from a known state even
// when the CI integration job sets some of them globally. t.Setenv restores originals.
func clearVaultEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		envAddr, envToken, envRole, envK8sMount, envJWTPath,
		envMount, envPath, envNamespace, envCACert, envCacheTTL,
	} {
		t.Setenv(k, "")
	}
}

// kvBody is the JSON a KV v2 read returns: fields live at .data.data.
func kvBody(fields map[string]any) string {
	payload := map[string]any{"data": map[string]any{"data": fields, "metadata": map[string]any{}}}
	b, _ := json.Marshal(payload)
	return string(b)
}

func TestOpenBaoTokenAuthRead(t *testing.T) {
	clearVaultEnv(t)

	var gotPath, gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-Vault-Token")
		_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "abc123", "db_password": "p@ss"}))
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envToken, "root")
	t.Setenv(envPath, "keel-test")

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	if gotPath != "/v1/secret/data/keel-test" {
		t.Errorf("read path = %q; want /v1/secret/data/keel-test", gotPath)
	}
	if gotToken != "root" {
		t.Errorf("X-Vault-Token = %q; want root", gotToken)
	}
	if v, ok := p.Get("api_key"); !ok || v != "abc123" {
		t.Errorf("Get(api_key) = %q,%v; want abc123,true", v, ok)
	}
	if v, ok := p.Get("db_password"); !ok || v != "p@ss" {
		t.Errorf("Get(db_password) = %q,%v; want p@ss,true", v, ok)
	}
	if _, ok := p.Get("absent"); ok {
		t.Error("Get(absent) should be ok=false")
	}
}

func TestOpenBaoKubernetesLoginThenRead(t *testing.T) {
	clearVaultEnv(t)

	jwtFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(jwtFile, []byte("sa-jwt-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var loginBody struct {
		Role string `json:"role"`
		JWT  string `json:"jwt"`
	}
	var readToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/auth/kubernetes/login":
			_ = json.NewDecoder(r.Body).Decode(&loginBody)
			_, _ = io.WriteString(w, `{"auth":{"client_token":"k8s-token","lease_duration":3600}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/secret/data/keel-test":
			readToken = r.Header.Get("X-Vault-Token")
			_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "fromk8s"}))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envRole, "keel-role")
	t.Setenv(envJWTPath, jwtFile)
	t.Setenv(envPath, "keel-test")

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	if loginBody.Role != "keel-role" || loginBody.JWT != "sa-jwt-value" {
		t.Errorf("login body = %+v; want {role:keel-role jwt:sa-jwt-value}", loginBody)
	}
	if readToken != "k8s-token" {
		t.Errorf("read X-Vault-Token = %q; want k8s-token (from login)", readToken)
	}
	if v, ok := p.Get("api_key"); !ok || v != "fromk8s" {
		t.Errorf("Get(api_key) = %q,%v; want fromk8s,true", v, ok)
	}
}

func TestOpenBaoCacheHitServesWithoutUpstream(t *testing.T) {
	clearVaultEnv(t)

	var reads int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&reads, 1)
		_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "cached"}))
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envToken, "root")
	t.Setenv(envPath, "keel-test")
	t.Setenv(envCacheTTL, "3600") // far beyond the test so no background refetch intrudes

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	for i := 0; i < 5; i++ {
		if v, ok := p.Get("api_key"); !ok || v != "cached" {
			t.Fatalf("Get #%d = %q,%v; want cached,true", i, v, ok)
		}
	}
	if n := atomic.LoadInt64(&reads); n != 1 {
		t.Errorf("upstream reads = %d; want 1 (construction only; Get serves from cache)", n)
	}
}

func TestOpenBaoTTLExpiryRefetch(t *testing.T) {
	clearVaultEnv(t)

	var value atomic.Value
	value.Store("first")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": value.Load().(string)}))
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envToken, "root")
	t.Setenv(envPath, "keel-test")
	t.Setenv(envCacheTTL, "1") // smallest TTL the config accepts (whole seconds)

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	if v, _ := p.Get("api_key"); v != "first" {
		t.Fatalf("initial Get = %q; want first", v)
	}
	value.Store("second")

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if v, _ := p.Get("api_key"); v == "second" {
			return // background refresh picked up the new value
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Error("background refresh did not refetch the updated value within the TTL window")
}

func TestOpenBao404IsEmptyNotError(t *testing.T) {
	clearVaultEnv(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"errors":[]}`)
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envToken, "root")
	t.Setenv(envPath, "missing")

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("404 at the path must construct (empty field map), got error: %v", err)
	}
	defer func() { _ = p.Close() }()

	if _, ok := p.Get("api_key"); ok {
		t.Error("every field must be absent when the path 404s")
	}
}

func TestOpenBao403ReauthAndRetry(t *testing.T) {
	clearVaultEnv(t)

	jwtFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(jwtFile, []byte("sa-jwt"), 0o600); err != nil {
		t.Fatal(err)
	}

	var logins, reads int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/auth/kubernetes/login":
			atomic.AddInt64(&logins, 1)
			_, _ = io.WriteString(w, `{"auth":{"client_token":"t","lease_duration":3600}}`)
		case r.URL.Path == "/v1/secret/data/keel-test":
			// First read 403s (stale token); after a re-login the retry succeeds.
			if atomic.AddInt64(&reads, 1) == 1 {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "after-reauth"}))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envRole, "keel-role")
	t.Setenv(envJWTPath, jwtFile)
	t.Setenv(envPath, "keel-test")

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	if v, ok := p.Get("api_key"); !ok || v != "after-reauth" {
		t.Errorf("Get(api_key) = %q,%v; want after-reauth,true", v, ok)
	}
	if n := atomic.LoadInt64(&logins); n != 2 {
		t.Errorf("logins = %d; want 2 (initial + re-auth on 403)", n)
	}
	if n := atomic.LoadInt64(&reads); n != 2 {
		t.Errorf("reads = %d; want 2 (403 then retry)", n)
	}
}

func TestOpenBaoNamespaceHeader(t *testing.T) {
	clearVaultEnv(t)

	var gotNS string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotNS = r.Header.Get("X-Vault-Namespace")
		_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "v"}))
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envToken, "root")
	t.Setenv(envPath, "keel-test")
	t.Setenv(envNamespace, "team-a")

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	if gotNS != "team-a" {
		t.Errorf("X-Vault-Namespace = %q; want team-a", gotNS)
	}
}

func TestOpenBaoCustomCATLS(t *testing.T) {
	clearVaultEnv(t)

	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "over-tls"}))
	}))
	defer srv.Close()

	// The httptest TLS server's own cert, handed to the adapter as the trusted root.
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})

	t.Setenv(envAddr, srv.URL) // https
	t.Setenv(envToken, "root")
	t.Setenv(envPath, "keel-test")
	t.Setenv(envCACert, string(caPEM))

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct over TLS with custom CA: %v", err)
	}
	defer func() { _ = p.Close() }()

	if v, ok := p.Get("api_key"); !ok || v != "over-tls" {
		t.Errorf("Get(api_key) = %q,%v; want over-tls,true", v, ok)
	}
}

func TestOpenBaoFailClosedOnMisconfig(t *testing.T) {
	t.Run("no auth configured", func(t *testing.T) {
		clearVaultEnv(t)
		t.Setenv(envAddr, "http://127.0.0.1:1")
		t.Setenv(envPath, "keel-test")
		if _, err := NewOpenBaoSecretProvider(context.Background()); err == nil {
			t.Error("addr set but no token/role must fail construction")
		}
	})

	t.Run("missing path", func(t *testing.T) {
		clearVaultEnv(t)
		t.Setenv(envAddr, "http://127.0.0.1:1")
		t.Setenv(envToken, "root")
		if _, err := NewOpenBaoSecretProvider(context.Background()); err == nil {
			t.Error("addr set but path unset must fail construction")
		}
	})

	t.Run("unreachable server", func(t *testing.T) {
		clearVaultEnv(t)
		t.Setenv(envAddr, "http://127.0.0.1:1")
		t.Setenv(envToken, "root")
		t.Setenv(envPath, "keel-test")
		if _, err := NewOpenBaoSecretProvider(context.Background()); err == nil {
			t.Error("unreachable server must fail construction, not fall back to env")
		}
	})

	t.Run("bad cacert", func(t *testing.T) {
		clearVaultEnv(t)
		t.Setenv(envAddr, "https://127.0.0.1:1")
		t.Setenv(envToken, "root")
		t.Setenv(envPath, "keel-test")
		t.Setenv(envCACert, "not a pem")
		if _, err := NewOpenBaoSecretProvider(context.Background()); err == nil {
			t.Error("an unparseable KEEL_VAULT_CACERT must fail construction")
		}
	})

	t.Run("bad ttl", func(t *testing.T) {
		clearVaultEnv(t)
		t.Setenv(envAddr, "http://127.0.0.1:1")
		t.Setenv(envToken, "root")
		t.Setenv(envPath, "keel-test")
		t.Setenv(envCacheTTL, "zero")
		if _, err := NewOpenBaoSecretProvider(context.Background()); err == nil {
			t.Error("a non-numeric KEEL_VAULT_CACHE_TTL_SECONDS must fail construction")
		}
	})
}

func TestOpenBaoNonStringFieldRoundTrips(t *testing.T) {
	clearVaultEnv(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A numeric field exercises the non-string branch of parseFieldMap: it is kept as its
		// compact JSON text so the flat-key port still returns a string.
		_, _ = io.WriteString(w, kvBody(map[string]any{"name": "plain", "replicas": 3}))
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envToken, "root")
	t.Setenv(envPath, "keel-test")

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	if v, ok := p.Get("name"); !ok || v != "plain" {
		t.Errorf("Get(name) = %q,%v; want plain,true", v, ok)
	}
	if v, ok := p.Get("replicas"); !ok || v != "3" {
		t.Errorf("Get(replicas) = %q,%v; want 3,true", v, ok)
	}
}

func TestOpenBaoKubernetesAuthErrors(t *testing.T) {
	t.Run("missing jwt file", func(t *testing.T) {
		clearVaultEnv(t)
		t.Setenv(envAddr, "http://127.0.0.1:1")
		t.Setenv(envRole, "keel-role")
		t.Setenv(envJWTPath, filepath.Join(t.TempDir(), "does-not-exist"))
		t.Setenv(envPath, "keel-test")
		if _, err := NewOpenBaoSecretProvider(context.Background()); err == nil {
			t.Error("a missing service-account JWT file must fail construction")
		}
	})

	t.Run("login rejected", func(t *testing.T) {
		clearVaultEnv(t)
		jwtFile := filepath.Join(t.TempDir(), "token")
		if err := os.WriteFile(jwtFile, []byte("jwt"), 0o600); err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"errors":["invalid role"]}`)
		}))
		defer srv.Close()
		t.Setenv(envAddr, srv.URL)
		t.Setenv(envRole, "bad-role")
		t.Setenv(envJWTPath, jwtFile)
		t.Setenv(envPath, "keel-test")
		if _, err := NewOpenBaoSecretProvider(context.Background()); err == nil {
			t.Error("a rejected Kubernetes login must fail construction")
		}
	})
}

func TestOpenBaoRefreshFailureServesLastGood(t *testing.T) {
	clearVaultEnv(t)

	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "good"}))
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envToken, "root")
	t.Setenv(envPath, "keel-test")
	t.Setenv(envCacheTTL, "1")

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	// Start failing; the background refresh must log and keep the last good field map.
	fail.Store(true)
	time.Sleep(1500 * time.Millisecond)
	if v, ok := p.Get("api_key"); !ok || v != "good" {
		t.Errorf("Get(api_key) = %q,%v after a failed refresh; want the last good value good,true", v, ok)
	}
}

func TestSecretProviderFromEnvSelection(t *testing.T) {
	t.Run("env adapter when addr unset", func(t *testing.T) {
		clearVaultEnv(t) // KEEL_VAULT_ADDR blank
		sp, err := SecretProviderFromEnv(context.Background())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := sp.(EnvSecretProvider); !ok {
			t.Errorf("want EnvSecretProvider when %s is unset, got %T", envAddr, sp)
		}
	})

	t.Run("openbao when addr set", func(t *testing.T) {
		clearVaultEnv(t)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "x"}))
		}))
		defer srv.Close()
		t.Setenv(envAddr, srv.URL)
		t.Setenv(envToken, "root")
		t.Setenv(envPath, "keel-test")

		sp, err := SecretProviderFromEnv(context.Background())
		if err != nil {
			t.Fatalf("construct: %v", err)
		}
		p, ok := sp.(*OpenBaoSecretProvider)
		if !ok {
			t.Fatalf("want *OpenBaoSecretProvider when %s is set, got %T", envAddr, sp)
		}
		defer func() { _ = p.Close() }()
	})

	t.Run("fail-closed when addr set but misconfigured", func(t *testing.T) {
		clearVaultEnv(t)
		t.Setenv(envAddr, "http://127.0.0.1:1") // set, but no auth
		t.Setenv(envPath, "keel-test")
		if _, err := SecretProviderFromEnv(context.Background()); err == nil {
			t.Error("must fail closed, not silently return the env adapter")
		}
	})
}
