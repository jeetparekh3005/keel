package httpx

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel"
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
	// headers (outermost) decorate every response, then request-id, metrics, CORS, body
	// limit. Metrics sit outside CORS and the body limit so a short-circuited response (e.g.
	// a 413) is still counted with its real status code.
	r.Use(securityHeaders)
	r.Use(requestID)
	// Metrics read the global MeterProvider; when telemetry export is off this is the no-op
	// provider, so the instruments are no-ops and the middleware adds negligible overhead.
	// Instrument construction only errors on an invalid definition, so a failure here is a
	// programming error rather than a runtime condition; skip the middleware if it occurs.
	if hm, err := newHTTPMetrics(otel.GetMeterProvider()); err == nil {
		r.Use(hm.middleware(r))
	}
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
