package adapters

// Unit tests for the OpenBao SecretProvider adapter against an in-process httptest server
// (non-gated; no real OpenBao needed). They assert request shape (paths, headers, bodies),
// that a known secret round-trips, and the ADR-0023 behaviors: token and Kubernetes auth,
// field-map caching, TTL-driven refetch, 404-as-empty, 403 re-auth + retry, the namespace
// header, custom-CA TLS, and fail-closed construction on misconfiguration.

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

func TestOpenBaoPathIsVerbatim(t *testing.T) {
	clearVaultEnv(t)

	// A nested path with a trailing slash proves the adapter uses KEEL_VAULT_PATH verbatim in
	// the read URL (no slash trimming), matching the other verticals. The old code trimmed the
	// trailing slash, which would request /v1/secret/data/team/app instead.
	const path = "team/app/"

	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "v"}))
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envToken, "root")
	t.Setenv(envPath, path)

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	if want := "/v1/secret/data/team/app/"; gotPath != want {
		t.Errorf("read path = %q; want %q (path used verbatim, no slash trimming)", gotPath, want)
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
			t.Error("a malformed KEEL_VAULT_CACERT must fail construction")
		}
	})

	// KEEL_VAULT_CACHE_TTL_SECONDS must parse to a POSITIVE integer (ADR-0023); unparseable,
	// zero, and negative values all fail construction rather than defaulting silently.
	for _, bad := range []string{"zero", "0", "-5", "1.5"} {
		t.Run("bad ttl "+bad, func(t *testing.T) {
			clearVaultEnv(t)
			t.Setenv(envAddr, "http://127.0.0.1:1")
			t.Setenv(envToken, "root")
			t.Setenv(envPath, "keel-test")
			t.Setenv(envCacheTTL, bad)
			if _, err := NewOpenBaoSecretProvider(context.Background()); err == nil {
				t.Errorf("KEEL_VAULT_CACHE_TTL_SECONDS=%q must fail construction (positive integer required)", bad)
			}
		})
	}
}

func TestOpenBaoScalarFieldsCoerceToCanonicalString(t *testing.T) {
	clearVaultEnv(t)

	// A string round-trips exactly; a number keeps its JSON text; booleans become "true"/"false"
	// (ADR-0023 canonical coercion) so the flat-key port stays string-typed.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, kvBody(map[string]any{
			"name":     "plain",
			"replicas": 3,
			"ratio":    1.5,
			"enabled":  true,
			"disabled": false,
		}))
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

	for _, tc := range []struct{ key, want string }{
		{"name", "plain"},
		{"replicas", "3"},
		{"ratio", "1.5"},
		{"enabled", "true"},
		{"disabled", "false"},
	} {
		if v, ok := p.Get(tc.key); !ok || v != tc.want {
			t.Errorf("Get(%s) = %q,%v; want %q,true", tc.key, v, ok, tc.want)
		}
	}
}

func TestOpenBaoNonScalarFieldsAbsent(t *testing.T) {
	clearVaultEnv(t)

	// Object, array, and null have no canonical scalar string, so they must be omitted (ok=false)
	// rather than serialized to JSON. A sibling scalar confirms the map is otherwise populated.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, kvBody(map[string]any{
			"scalar": "kept",
			"obj":    map[string]any{"nested": 1},
			"arr":    []any{1, 2, 3},
			"empty":  nil,
		}))
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

	if v, ok := p.Get("scalar"); !ok || v != "kept" {
		t.Errorf("Get(scalar) = %q,%v; want kept,true", v, ok)
	}
	for _, key := range []string{"obj", "arr", "empty"} {
		if v, ok := p.Get(key); ok {
			t.Errorf("Get(%s) = %q,%v; want absent (ok=false) for a non-scalar value", key, v, ok)
		}
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

func TestOpenBaoLeaseRenewedBeforeRefresh(t *testing.T) {
	clearVaultEnv(t)

	jwtFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(jwtFile, []byte("sa-jwt"), 0o600); err != nil {
		t.Fatal(err)
	}

	// A single refresh goroutine drives these requests sequentially, so appending to events
	// under the lock records their true order. reads is polled by the test to await background
	// cycles. A lease_duration inside renewBuffer (10s) keeps the token perpetually near expiry,
	// so each refresh must re-login proactively rather than waiting for a reactive 401/403.
	var (
		mu     sync.Mutex
		events []string
		reads  atomic.Int64
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/auth/kubernetes/login":
			mu.Lock()
			events = append(events, "login")
			mu.Unlock()
			_, _ = io.WriteString(w, `{"auth":{"client_token":"k8s-token","lease_duration":1}}`)
		case "/v1/secret/data/keel-test":
			mu.Lock()
			events = append(events, "read")
			mu.Unlock()
			reads.Add(1)
			_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": "v"}))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envRole, "keel-role")
	t.Setenv(envJWTPath, jwtFile)
	t.Setenv(envPath, "keel-test")
	t.Setenv(envCacheTTL, "1")

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}

	// Await at least two background refresh reads beyond the one at construction.
	deadline := time.Now().Add(5 * time.Second)
	for reads.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	_ = p.Close() // stop the loop so events has no concurrent writer.

	mu.Lock()
	defer mu.Unlock()
	if reads.Load() < 3 {
		t.Fatalf("saw only %d reads; background refresh did not run as expected: %v", reads.Load(), events)
	}
	logins := 0
	for i, e := range events {
		if e == "read" {
			// Each read must be immediately preceded by a login: the proactive renewal fires
			// before the field-map refresh, never after it.
			if i == 0 || events[i-1] != "login" {
				t.Errorf("read at index %d not immediately preceded by a proactive login: %v", i, events)
			}
			continue
		}
		logins++
	}
	// The server never returns 401/403, so every login is proactive. More than one proves the
	// background refresh renews the lease on its own rather than waiting for a rejection.
	if logins < 2 {
		t.Errorf("logins = %d; want >= 2 (proactive lease renewal before refresh): %v", logins, events)
	}
}

func TestOpenBaoRefreshFailureDoesNotLeakSecretsOrToken(t *testing.T) {
	clearVaultEnv(t)

	const (
		secretValue = "sekret-value-must-not-be-logged"
		vaultToken  = "super-secret-token-must-not-be-logged"
	)

	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, kvBody(map[string]any{"api_key": secretValue}))
	}))
	defer srv.Close()

	t.Setenv(envAddr, srv.URL)
	t.Setenv(envToken, vaultToken)
	t.Setenv(envPath, "keel-test")
	t.Setenv(envCacheTTL, "1")

	p, err := NewOpenBaoSecretProvider(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	// Capture slog only after a clean construction, so the buffer holds the refresh-failure
	// warning. It is read after Close, when the refresh goroutine has exited (no data race).
	var buf bytes.Buffer
	prev := slog.Default()
	defer slog.SetDefault(prev)
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))

	fail.Store(true)
	time.Sleep(1500 * time.Millisecond)
	_ = p.Close()

	logged := buf.String()
	if !strings.Contains(logged, "refresh failed") {
		t.Fatalf("expected a refresh-failure warning in the logs; got %q", logged)
	}
	if strings.Contains(logged, secretValue) {
		t.Errorf("the cached secret value leaked into the logs: %q", logged)
	}
	if strings.Contains(logged, vaultToken) {
		t.Errorf("the vault token leaked into the logs: %q", logged)
	}
	// The cache must still serve the last good value after the failed refresh.
	if v, ok := p.Get("api_key"); !ok || v != secretValue {
		t.Errorf("Get(api_key) = %q,%v after a failed refresh; want the last good value", v, ok)
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
