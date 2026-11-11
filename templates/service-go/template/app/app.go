package app

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"
)

// BuildApp is the composition root: it wires the << aggregate >> service to its routes behind the
// authenticator and the edge middleware. The driving adapter (the routes) never imports the
// concrete repository; the wiring lives here. ready is the readiness check (the service
// passes a DB ping; tests pass a trivial one).
func BuildApp(repo << aggregate_pascal >>Repository, ready httpx.ReadinessCheck, authenticator auth.Authenticator, cfg httpx.AppConfig) http.Handler {
	svc := New<< aggregate_pascal >>Service(repo)
	return httpx.NewRouter(cfg, ready, func(r chi.Router) {
		// All << aggregate >> routes require authentication (deny-by-default); each route also
		// enforces its scope inside the handler.
		r.Group(func(pr chi.Router) {
			pr.Use(auth.Middleware(authenticator))
			<< aggregate_plural >>Routes(svc)(pr)
		})
	})
}
