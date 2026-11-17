package adapters

// Shared SecretProvider caching core (ADR-0024). Every production SecretProvider backend
// (OpenBao, AWS Secrets Manager, and a later GCP Secret Manager) loads a secret's field map
// into memory once at construction, serves Get() synchronously from that cache with no I/O,
// refreshes it in the background every KEEL_SECRET_CACHE_TTL_SECONDS, keeps serving the last
// good map on a failed refresh, and never logs a secret value or credential. That behavior
// lives here once; each backend supplies only a loader that authenticates and returns the
// raw field map (ADR-0024 decision 3: one caching engine, not three divergent copies).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// envCacheTTL is the shared cache-refresh interval for every backend (ADR-0024). OpenBao
	// migrated to this name from KEEL_VAULT_CACHE_TTL_SECONDS (unreleased, so no alias).
	envCacheTTL = "KEEL_SECRET_CACHE_TTL_SECONDS"

	defaultCacheTTL = 60 * time.Second
)

// secretLoader authenticates (as its backend requires) and returns the current secret field
// map. A missing secret returns an empty map and a nil error - "every field absent", matching
// the env adapter and Vault's 404 - so a not-found secret does not fail construction. Any
// other failure (auth, permissions, a malformed non-object payload, a transport error)
// returns an error, which fails closed at construction and is logged-and-tolerated on refresh.
type secretLoader interface {
	load(ctx context.Context) (map[string]string, error)
	// name identifies the backend in refresh-failure logs. It MUST NOT contain a secret.
	name() string
}

// cachingSecretProvider serves a secret field map from memory and refreshes it in the
// background. It is constructed with newCachingSecretProvider and is embedded by each backend
// provider, which promotes Get and Close. The zero value is not usable.
type cachingSecretProvider struct {
	loader secretLoader
	ttl    time.Duration

	mu     sync.RWMutex
	fields map[string]string

	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once
}

// newCachingSecretProvider eagerly loads the field map (which may block and fail closed) and,
// on success, starts a background refresh goroutine stopped by Close() or by cancelling ctx.
func newCachingSecretProvider(ctx context.Context, loader secretLoader, ttl time.Duration) (*cachingSecretProvider, error) {
	c := &cachingSecretProvider{loader: loader, ttl: ttl, fields: map[string]string{}}
	fields, err := loader.load(ctx)
	if err != nil {
		return nil, err
	}
	c.setFields(fields)

	loopCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	c.done = make(chan struct{})
	go c.refreshLoop(loopCtx)
	return c, nil
}

// Get returns the field value for key from the in-memory cache; ok is false when the field is
// absent (same semantics as the env adapter). It performs no I/O (ADR-0023/0024: the port's
// Get is synchronous, so the cache is loaded ahead and refreshed in the background).
func (c *cachingSecretProvider) Get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.fields[key]
	return v, ok
}

// Close stops the background refresh goroutine and waits for it to exit. It is safe to call
// more than once.
func (c *cachingSecretProvider) Close() error {
	c.closeOnce.Do(func() {
		if c.cancel != nil {
			c.cancel()
			<-c.done
		}
	})
	return nil
}

func (c *cachingSecretProvider) refreshLoop(ctx context.Context) {
	defer close(c.done)
	ticker := time.NewTicker(c.ttl)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fields, err := c.loader.load(ctx)
			if err != nil {
				// Keep serving the last good field map; a transient backend outage must not take
				// the service down (ADR-0023/0024). The error and backend name are safe to log;
				// neither a secret value nor a credential appears in them.
				slog.WarnContext(ctx, "secret field-map refresh failed; serving last good values",
					"backend", c.loader.name(), "error", err)
				continue
			}
			c.setFields(fields)
		}
	}
}

func (c *cachingSecretProvider) setFields(fields map[string]string) {
	c.mu.Lock()
	c.fields = fields
	c.mu.Unlock()
}

// parseCacheTTL reads the shared TTL env var, returning the default when unset and failing
// closed on a non-positive-integer value rather than silently defaulting (ADR-0024).
func parseCacheTTL() (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(envCacheTTL))
	if raw == "" {
		return defaultCacheTTL, nil
	}
	secs, err := strconv.Atoi(raw)
	if err != nil || secs <= 0 {
		return 0, fmt.Errorf("%s=%q is not a positive integer", envCacheTTL, raw)
	}
	return time.Duration(secs) * time.Second, nil
}

// coerceObjectFields parses a JSON object into a field map, coercing each value to its
// canonical string per ADR-0023 and omitting non-scalar values. A payload that is not a JSON
// object (a bare string, number, array, or null) is an error: a secret meant to back
// Get(name) must be an object of named fields (ADR-0024 AWS/GCP loaders).
func coerceObjectFields(raw []byte) (map[string]string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, fmt.Errorf("secret payload is not a JSON object")
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		return nil, fmt.Errorf("decode JSON object: %w", err)
	}
	fields := make(map[string]string, len(obj))
	for k, v := range obj {
		if cv, ok := coerceField(v); ok {
			fields[k] = cv
		}
	}
	return fields, nil
}

// coerceField maps one raw JSON value to its canonical string, reporting ok=false when the
// value is non-scalar (object, array, or null) and so has no canonical string. Scalars: a JSON
// string decodes to its unescaped text, a number keeps its JSON text verbatim, and a boolean
// becomes "true"/"false". Shared by the KV v2 (OpenBao) and JSON-object (AWS/GCP) loaders.
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

// getenvDefault returns the trimmed value of key, or fallback when it is unset or blank.
func getenvDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
