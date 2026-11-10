package conformance_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/conformance"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/testkit"
)

// buildApp composes the edge, an authenticator, and two scope-guarded routes, exactly as a
// service would, so the conformance suite can run against it.
func buildApp() http.Handler {
	a := testkit.StubAuthenticator{Principals: map[string]*auth.Principal{
		"tok": testkit.Principal("u", "items:read"), // read scope only
	}}
	ready := func(context.Context) bool { return true }
	return httpx.NewRouter(httpx.AppConfig{}, ready, func(r chi.Router) {
		r.Group(func(pr chi.Router) {
			pr.Use(auth.Middleware(a))
			pr.Post("/v1/items", func(w http.ResponseWriter, req *http.Request) {
				if err := auth.RequireScopes(req.Context(), "items:write"); err != nil {
					httpx.WriteError(w, req, err)
					return
				}
				w.WriteHeader(http.StatusCreated)
			})
			pr.Get("/v1/items", func(w http.ResponseWriter, req *http.Request) {
				if err := auth.RequireScopes(req.Context(), "items:read"); err != nil {
					httpx.WriteError(w, req, err)
					return
				}
				w.WriteHeader(http.StatusOK)
			})
		})
	})
}

func TestConformanceSuitePasses(t *testing.T) {
	h := buildApp()
	conformance.AssertHealth(t, h)
	conformance.AssertSecurityHeaders(t, h)
	conformance.AssertCORSDenyByDefault(t, h)
	conformance.AssertDeniesAnonymous(t, h, "POST", "/v1/items", `{"name":"x"}`)
	conformance.AssertDeniesAnonymous(t, h, "GET", "/v1/items", "")
	// "tok" holds items:read but not items:write, so POST must be forbidden.
	conformance.AssertRequiresScope(t, h, "POST", "/v1/items", "tok", `{"name":"x"}`)
}
