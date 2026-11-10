package httpx

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// DefaultMaxBodyBytes caps request bodies at 1 MiB, bounding the large-payload DoS vector.
const DefaultMaxBodyBytes int64 = 1 << 20

// AppConfig is the edge configuration for the app factory.
type AppConfig struct {
	// MaxBodyBytes is the request body cap; <= 0 uses DefaultMaxBodyBytes.
	MaxBodyBytes int64
	// CORSAllowOrigins are the exact origins to allow. Empty is deny-by-default (no CORS).
	CORSAllowOrigins []string
}

func (c AppConfig) maxBody() int64 {
	if c.MaxBodyBytes <= 0 {
		return DefaultMaxBodyBytes
	}
	return c.MaxBodyBytes
}

// ReadinessCheck reports whether the service's dependencies are reachable. The composition
// root supplies one (e.g. a DB ping); /readyz returns 503 when it reports not-ready.
type ReadinessCheck func(ctx context.Context) bool

// NewRouter builds the application: the health probes plus the service routes registered by
// mount, all wrapped in the edge middleware. Security headers are applied outermost, so a
// short-circuited 413 still carries them; CORS is added only when origins are configured.
func NewRouter(cfg AppConfig, ready ReadinessCheck, mount func(r chi.Router)) http.Handler {
	r := chi.NewRouter()

	// Middleware must be registered before routes. Order is outer-to-inner: security
	// headers (outermost) decorate every response, then request-id, CORS, body limit.
	r.Use(securityHeaders)
	r.Use(requestID)
	if len(cfg.CORSAllowOrigins) > 0 {
		r.Use(cors(cfg.CORSAllowOrigins))
	}
	r.Use(bodyLimit(cfg.maxBody()))

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	r.Get("/readyz", func(w http.ResponseWriter, req *http.Request) {
		if ready != nil && !ready(req.Context()) {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	if mount != nil {
		mount(r)
	}
	return r
}
