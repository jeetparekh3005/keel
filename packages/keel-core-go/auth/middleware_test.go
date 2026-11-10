package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"
)

type stubAuth struct{ principals map[string]*Principal }

func (s stubAuth) Authenticate(_ context.Context, credential string) (*Principal, error) {
	if p, ok := s.principals[credential]; ok {
		return p, nil
	}
	return nil, domain.New(domain.Unauthenticated, "invalid token")
}

func scopeSet(scopes ...string) map[string]struct{} {
	m := make(map[string]struct{}, len(scopes))
	for _, s := range scopes {
		m[s] = struct{}{}
	}
	return m
}

func protectedApp() http.Handler {
	a := stubAuth{principals: map[string]*Principal{
		"tok": {Subject: "u", Scopes: scopeSet("items:read")},
	}}
	r := chi.NewRouter()
	r.Use(Middleware(a))
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

func call(t *testing.T, path, authHeader string) int {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	rec := httptest.NewRecorder()
	protectedApp().ServeHTTP(rec, req)
	return rec.Code
}

func TestDenyByDefaultAndScopeEnforcement(t *testing.T) {
	if got := call(t, "/protected", ""); got != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", got)
	}
	if got := call(t, "/protected", "Bearer bogus"); got != http.StatusUnauthorized {
		t.Errorf("bad token = %d, want 401", got)
	}
	if got := call(t, "/protected", "Bearer tok"); got != http.StatusOK {
		t.Errorf("valid token with scope = %d, want 200", got)
	}
	if got := call(t, "/needs-write", "Bearer tok"); got != http.StatusForbidden {
		t.Errorf("insufficient scope = %d, want 403", got)
	}
	// RFC 7235: the scheme is case-insensitive.
	if got := call(t, "/protected", "bearer tok"); got != http.StatusOK {
		t.Errorf("lowercase bearer = %d, want 200", got)
	}
}
