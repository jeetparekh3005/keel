package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"
)

func TestHashAPIKeyIsSHA256Hex(t *testing.T) {
	sum := sha256.Sum256([]byte("k"))
	if got, want := HashAPIKey("k"), hex.EncodeToString(sum[:]); got != want {
		t.Errorf("HashAPIKey(k) = %q, want %q", got, want)
	}
}

func TestAPIKeyAuthenticateValid(t *testing.T) {
	a := APIKeyAuthenticatorFromKeys(map[string]*Principal{
		"secret-key": {Subject: "svc", Scopes: scopeSet("items:read")},
	})
	p, err := a.Authenticate(context.Background(), "secret-key")
	if err != nil {
		t.Fatalf("Authenticate(secret-key) err = %v, want nil", err)
	}
	if p.Subject != "svc" {
		t.Errorf("subject = %q, want svc", p.Subject)
	}
	if !p.HasScopes("items:read") {
		t.Errorf("principal missing items:read scope")
	}
}

func TestAPIKeyAuthenticateInvalidIsUnauthenticated(t *testing.T) {
	a := APIKeyAuthenticatorFromKeys(map[string]*Principal{
		"secret-key": {Subject: "svc"},
	})
	_, err := a.Authenticate(context.Background(), "wrong")
	var de *domain.DomainError
	if !errors.As(err, &de) || de.Category != domain.Unauthenticated {
		t.Fatalf("Authenticate(wrong) err = %v, want Unauthenticated DomainError", err)
	}
}

func TestAPIKeyAuthenticatorFromPrehashedKeys(t *testing.T) {
	a := NewAPIKeyAuthenticator(map[string]*Principal{
		HashAPIKey("abc"): {Subject: "u"},
	})
	p, err := a.Authenticate(context.Background(), "abc")
	if err != nil {
		t.Fatalf("Authenticate(abc) err = %v, want nil", err)
	}
	if p.Subject != "u" {
		t.Errorf("subject = %q, want u", p.Subject)
	}
	if _, err := a.Authenticate(context.Background(), "missing"); err == nil {
		t.Errorf("Authenticate(missing) err = nil, want error")
	}
}

// dualAuthApp guards routes with MiddlewareWithAPIKey so a request may authenticate via either
// a bearer JWT (stubAuth) or an X-API-Key (APIKeyAuthenticator). Both feed the same scope check.
func dualAuthApp() http.Handler {
	bearer := stubAuth{principals: map[string]*Principal{
		"tok": {Subject: "u", Scopes: scopeSet("items:read")},
	}}
	apiKeys := APIKeyAuthenticatorFromKeys(map[string]*Principal{
		"secret-key": {Subject: "svc", Scopes: scopeSet("items:read")},
	})
	r := chi.NewRouter()
	r.Use(MiddlewareWithAPIKey(bearer, apiKeys))
	r.Get("/protected", func(w http.ResponseWriter, req *http.Request) {
		if err := RequireScopes(req.Context(), "items:read"); err != nil {
			httpx.WriteError(w, req, err)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	r.Get("/needs-write", func(w http.ResponseWriter, req *http.Request) {
		if err := RequireScopes(req.Context(), "items:write"); err != nil {
			httpx.WriteError(w, req, err)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	return r
}

func callWith(t *testing.T, path string, headers map[string]string) int {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	dualAuthApp().ServeHTTP(rec, req)
	return rec.Code
}

func TestAPIKeyMiddlewareRoutingAndScopes(t *testing.T) {
	// A valid X-API-Key yields its principal and passes the scope-guarded handler.
	if got := callWith(t, "/protected", map[string]string{apiKeyHeader: "secret-key"}); got != http.StatusOK {
		t.Errorf("valid api key with scope = %d, want 200", got)
	}
	// A wrong api key is rejected 401.
	if got := callWith(t, "/protected", map[string]string{apiKeyHeader: "nope"}); got != http.StatusUnauthorized {
		t.Errorf("wrong api key = %d, want 401", got)
	}
	// No credential at all is 401 (deny-by-default).
	if got := callWith(t, "/protected", nil); got != http.StatusUnauthorized {
		t.Errorf("no credential = %d, want 401", got)
	}
	// An api-key principal lacking the route's required scope is still 403.
	if got := callWith(t, "/needs-write", map[string]string{apiKeyHeader: "secret-key"}); got != http.StatusForbidden {
		t.Errorf("api key insufficient scope = %d, want 403", got)
	}
	// The bearer path still works alongside the api-key path.
	if got := callWith(t, "/protected", map[string]string{"Authorization": "Bearer tok"}); got != http.StatusOK {
		t.Errorf("bearer token with scope = %d, want 200", got)
	}
	// A bad bearer token is still 401.
	if got := callWith(t, "/protected", map[string]string{"Authorization": "Bearer bogus"}); got != http.StatusUnauthorized {
		t.Errorf("bad bearer token = %d, want 401", got)
	}
}
