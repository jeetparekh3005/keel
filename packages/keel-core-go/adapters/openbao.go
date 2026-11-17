package adapters

// OpenBaoSecretProvider is the production SecretProvider backend (ADR-0007, ADR-0023): a
// thin client over the Vault KV v2 HTTP API that serves OpenBao or HashiCorp Vault
// unchanged. It authenticates (static token or Kubernetes service-account JWT), loads the
// field map at <mount>/data/<path> into memory once at construction, and serves Get()
// synchronously from that cache with no I/O. A background goroutine re-reads the path every
// KEEL_VAULT_CACHE_TTL_SECONDS; a 401/403 during refresh triggers a single re-auth + retry,
// and a failed refresh keeps serving the last good field map (a transient outage does not
// take the service down). Scope here is static KV read only; dynamic credentials, Transit,
// and PKI are later work (ADR-0023).

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

const (
	// Config env vars (ADR-0023 Protocol table). All KEEL_VAULT_*.
	envAddr      = "KEEL_VAULT_ADDR"
	envToken     = "KEEL_VAULT_TOKEN"
	envRole      = "KEEL_VAULT_ROLE"
	envK8sMount  = "KEEL_VAULT_K8S_MOUNT"
	envJWTPath   = "KEEL_VAULT_K8S_JWT_PATH"
	envMount     = "KEEL_VAULT_MOUNT"
	envPath      = "KEEL_VAULT_PATH"
	envNamespace = "KEEL_VAULT_NAMESPACE"
	envCACert    = "KEEL_VAULT_CACERT"
	envCacheTTL  = "KEEL_VAULT_CACHE_TTL_SECONDS"

	defaultK8sMount = "kubernetes"
	defaultJWTPath  = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	defaultMount    = "secret"
	defaultCacheTTL = 60 * time.Second

	// renewBuffer re-logs in a Kubernetes lease before it fully expires, rather than waiting
	// for a 401/403 to force a reactive re-auth.
	renewBuffer = 10 * time.Second
)

// OpenBaoSecretProvider serves secrets from an in-memory cache of one KV v2 field map,
// refreshed in the background. The zero value is not usable; construct with
// NewOpenBaoSecretProvider.
type OpenBaoSecretProvider struct {
	addr      string
	mount     string
	path      string
	namespace string
	ttl       time.Duration
	client    *http.Client

	// Auth configuration (exactly one of staticToken / role is set, per the ADR order).
	staticToken string
	role        string
	k8sMount    string
	jwtPath     string

	mu          sync.RWMutex
	fields      map[string]string
	token       string
	tokenExpiry time.Time // zero for a static token (never auto-renewed)

	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once
}

// Compile-time assertions that the provider satisfies the port and is closeable, mirroring
// the env adapter's assertion.
var (
	_ ports.SecretProvider = (*OpenBaoSecretProvider)(nil)
	_ io.Closer            = (*OpenBaoSecretProvider)(nil)
)

// NewOpenBaoSecretProvider constructs the provider from the KEEL_VAULT_* environment,
// authenticates, and eagerly loads the field map (which may block). It fails loudly
// (ADR-0023 fail-closed) when KEEL_VAULT_ADDR or KEEL_VAULT_PATH is unset, when no auth is
// configured, or when the server is unreachable / auth fails on the first load. On success
// it starts a background refresh goroutine stopped by Close() or by cancelling ctx.
func NewOpenBaoSecretProvider(ctx context.Context) (*OpenBaoSecretProvider, error) {
	addr := strings.TrimSpace(os.Getenv(envAddr))
	if addr == "" {
		return nil, fmt.Errorf("%s is not set", envAddr)
	}
	path := strings.TrimSpace(os.Getenv(envPath))
	if path == "" {
		return nil, fmt.Errorf("%s is set but %s is not", envAddr, envPath)
	}

	ttl := defaultCacheTTL
	if raw := strings.TrimSpace(os.Getenv(envCacheTTL)); raw != "" {
		secs, err := strconv.Atoi(raw)
		if err != nil || secs <= 0 {
			return nil, fmt.Errorf("%s=%q is not a positive integer", envCacheTTL, raw)
		}
		ttl = time.Duration(secs) * time.Second
	}

	client, err := newVaultHTTPClient(os.Getenv(envCACert))
	if err != nil {
		return nil, err
	}

	p := &OpenBaoSecretProvider{
		addr:        strings.TrimRight(addr, "/"),
		mount:       getenvDefault(envMount, defaultMount),
		path:        path,
		namespace:   strings.TrimSpace(os.Getenv(envNamespace)),
		ttl:         ttl,
		client:      client,
		staticToken: strings.TrimSpace(os.Getenv(envToken)),
		role:        strings.TrimSpace(os.Getenv(envRole)),
		k8sMount:    getenvDefault(envK8sMount, defaultK8sMount),
		jwtPath:     getenvDefault(envJWTPath, defaultJWTPath),
		fields:      map[string]string{},
	}

	if p.staticToken == "" && p.role == "" {
		return nil, fmt.Errorf("%s is set but neither %s nor %s is configured", envAddr, envToken, envRole)
	}

	if err := p.authenticate(ctx); err != nil {
		return nil, err
	}
	fields, err := p.fetch(ctx)
	if err != nil {
		return nil, err
	}
	p.setFields(fields)

	loopCtx, cancel := context.WithCancel(ctx)
	p.cancel = cancel
	p.done = make(chan struct{})
	go p.refreshLoop(loopCtx)

	return p, nil
}

// Get returns the field value for key from the in-memory cache; ok is false when the field
// is absent (same semantics as the env adapter). It performs no I/O (ADR-0023: the port's
// Get is synchronous and Node cannot do synchronous HTTP, so the cache is loaded ahead).
func (p *OpenBaoSecretProvider) Get(key string) (string, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	v, ok := p.fields[key]
	return v, ok
}

// Close stops the background refresh goroutine and waits for it to exit. It is safe to call
// more than once.
func (p *OpenBaoSecretProvider) Close() error {
	p.closeOnce.Do(func() {
		if p.cancel != nil {
			p.cancel()
			<-p.done
		}
	})
	return nil
}

func (p *OpenBaoSecretProvider) refreshLoop(ctx context.Context) {
	defer close(p.done)
	ticker := time.NewTicker(p.ttl)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fields, err := p.fetch(ctx)
			if err != nil {
				// Keep serving the last good field map; a transient OpenBao outage must not
				// take the service down (ADR-0023).
				slog.WarnContext(ctx, "openbao field-map refresh failed; serving last good values",
					"error", err, "mount", p.mount, "path", p.path)
				continue
			}
			p.setFields(fields)
		}
	}
}

// fetch reads the field map once, re-authenticating and retrying a single time on a 401/403
// (an expired/invalid token). A Kubernetes lease nearing expiry is renewed proactively
// before the read.
func (p *OpenBaoSecretProvider) fetch(ctx context.Context) (map[string]string, error) {
	if p.role != "" {
		p.mu.RLock()
		expiry := p.tokenExpiry
		p.mu.RUnlock()
		if !expiry.IsZero() && time.Now().After(expiry.Add(-renewBuffer)) {
			if err := p.authenticate(ctx); err != nil {
				return nil, err
			}
		}
	}

	fields, status, err := p.read(ctx, p.currentToken())
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		if err := p.authenticate(ctx); err != nil {
			return nil, fmt.Errorf("re-authenticate after status %d: %w", status, err)
		}
		fields, status, err = p.read(ctx, p.currentToken())
		if err != nil {
			return nil, err
		}
	}
	switch status {
	case http.StatusOK, http.StatusNotFound:
		return fields, nil
	default:
		return nil, fmt.Errorf("openbao read %s/data/%s: unexpected status %d", p.mount, p.path, status)
	}
}

// read performs one KV v2 read. It returns the field map for 200, an empty map for 404
// (no secret at the path is "every field absent", not an error), and a nil map with the
// status for 401/403 so the caller can decide to re-authenticate. Any other status yields a
// nil map with the status and no error; transport/decoding problems return an error.
func (p *OpenBaoSecretProvider) read(ctx context.Context, token string) (map[string]string, int, error) {
	url := fmt.Sprintf("%s/v1/%s/data/%s", p.addr, p.mount, p.path)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	p.setHeaders(req, token)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("openbao read %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()

	switch resp.StatusCode {
	case http.StatusOK:
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, resp.StatusCode, err
		}
		fields, err := parseFieldMap(body)
		if err != nil {
			return nil, resp.StatusCode, fmt.Errorf("openbao read %s: %w", url, err)
		}
		return fields, resp.StatusCode, nil
	case http.StatusNotFound:
		return map[string]string{}, resp.StatusCode, nil
	default:
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, resp.StatusCode, nil
	}
}

// authenticate resolves a client token in the ADR order: a static token wins; otherwise a
// Kubernetes login exchanges the service-account JWT for a token. It stores the token (and,
// for Kubernetes, the lease expiry) under the lock.
func (p *OpenBaoSecretProvider) authenticate(ctx context.Context) error {
	if p.staticToken != "" {
		p.mu.Lock()
		p.token = p.staticToken
		p.tokenExpiry = time.Time{}
		p.mu.Unlock()
		return nil
	}
	if p.role == "" {
		return fmt.Errorf("%s is set but neither %s nor %s is configured", envAddr, envToken, envRole)
	}

	jwt, err := os.ReadFile(p.jwtPath)
	if err != nil {
		return fmt.Errorf("read kubernetes service-account JWT at %s: %w", p.jwtPath, err)
	}
	payload, err := json.Marshal(map[string]string{
		"role": p.role,
		"jwt":  strings.TrimSpace(string(jwt)),
	})
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/v1/auth/%s/login", p.addr, p.k8sMount)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.namespace != "" {
		req.Header.Set("X-Vault-Namespace", p.namespace)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("openbao kubernetes login %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("openbao kubernetes login %s: status %d: %s", url, resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var parsed struct {
		Auth struct {
			ClientToken   string `json:"client_token"`
			LeaseDuration int    `json:"lease_duration"`
		} `json:"auth"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("openbao kubernetes login %s: decode response: %w", url, err)
	}
	if parsed.Auth.ClientToken == "" {
		return fmt.Errorf("openbao kubernetes login %s: response had no client_token", url)
	}

	p.mu.Lock()
	p.token = parsed.Auth.ClientToken
	if parsed.Auth.LeaseDuration > 0 {
		p.tokenExpiry = time.Now().Add(time.Duration(parsed.Auth.LeaseDuration) * time.Second)
	} else {
		p.tokenExpiry = time.Time{}
	}
	p.mu.Unlock()
	return nil
}

func (p *OpenBaoSecretProvider) setHeaders(req *http.Request, token string) {
	if token != "" {
		req.Header.Set("X-Vault-Token", token)
	}
	if p.namespace != "" {
		req.Header.Set("X-Vault-Namespace", p.namespace)
	}
}

func (p *OpenBaoSecretProvider) currentToken() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.token
}

func (p *OpenBaoSecretProvider) setFields(fields map[string]string) {
	p.mu.Lock()
	p.fields = fields
	p.mu.Unlock()
}

// parseFieldMap extracts the KV v2 field map at the JSON pointer .data.data. Each value is
// coerced to a canonical string so the flat-key port stays string-typed (ADR-0023): a JSON
// string is preserved exactly, a number is its JSON text, a boolean is "true"/"false". A
// non-scalar value (object, array, or null) has no canonical string form and is therefore
// omitted, so Get() reports it absent (ok=false) rather than leaking serialized JSON.
func parseFieldMap(body []byte) (map[string]string, error) {
	var parsed struct {
		Data struct {
			Data map[string]json.RawMessage `json:"data"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode KV v2 response: %w", err)
	}
	fields := make(map[string]string, len(parsed.Data.Data))
	for k, raw := range parsed.Data.Data {
		if v, ok := coerceField(raw); ok {
			fields[k] = v
		}
	}
	return fields, nil
}

// coerceField maps one raw KV v2 field value to its canonical string, reporting ok=false when
// the value is non-scalar (object, array, or null) and so has no canonical string. Scalars:
// a JSON string decodes to its unescaped text, a number keeps its JSON text verbatim, and a
// boolean becomes "true"/"false".
func coerceField(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "", false
	}
	switch trimmed[0] {
	case '"':
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return "", false
		}
		return s, true
	case 't':
		return "true", true
	case 'f':
		return "false", true
	case '{', '[', 'n': // object, array, or null: no canonical scalar string.
		return "", false
	default: // number: the JSON text is already the canonical string.
		return string(trimmed), true
	}
}

// newVaultHTTPClient builds the HTTP client, trusting KEEL_VAULT_CACERT (a PEM literal or a
// file path) in addition to / instead of the system roots when set. An empty value uses the
// default client with the system trust store.
func newVaultHTTPClient(caCert string) (*http.Client, error) {
	caCert = strings.TrimSpace(caCert)
	if caCert == "" {
		return &http.Client{Timeout: 15 * time.Second}, nil
	}

	var pem []byte
	if strings.Contains(caCert, "-----BEGIN") {
		pem = []byte(caCert)
	} else {
		b, err := os.ReadFile(caCert)
		if err != nil {
			return nil, fmt.Errorf("read %s file %q: %w", envCACert, caCert, err)
		}
		pem = b
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("KEEL_VAULT_CACERT did not contain any valid PEM certificate")
	}
	return &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		},
	}, nil
}

func getenvDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// SecretProviderFromEnv is the composition-root factory (ADR-0023 selection): it returns the
// OpenBao provider when KEEL_VAULT_ADDR is set (failing closed on any misconfiguration rather
// than silently falling back), and the EnvSecretProvider otherwise. The OpenBao provider is
// an io.Closer; callers that manage lifecycle should type-assert and Close it on shutdown.
func SecretProviderFromEnv(ctx context.Context) (ports.SecretProvider, error) {
	if strings.TrimSpace(os.Getenv(envAddr)) == "" {
		return EnvSecretProvider{}, nil
	}
	return NewOpenBaoSecretProvider(ctx)
}
