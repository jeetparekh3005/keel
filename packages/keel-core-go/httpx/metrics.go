package httpx

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// meterName scopes the HTTP request instruments to this package so the emitted metrics are
// attributable to keel-core-go rather than an anonymous scope.
const meterName = "github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"

// httpMetrics holds the two server request instruments. It is built from a MeterProvider; a
// no-op provider (the default when telemetry export is off) yields no-op instruments, so the
// middleware is always safe to install.
type httpMetrics struct {
	duration metric.Float64Histogram
	active   metric.Int64UpDownCounter
}

// newHTTPMetrics constructs the request instruments on mp's meter. It returns an error only if
// the SDK rejects an instrument definition; the no-op provider never does.
func newHTTPMetrics(mp metric.MeterProvider) (*httpMetrics, error) {
	m := mp.Meter(meterName)
	duration, err := m.Float64Histogram(
		"http.server.request.duration",
		metric.WithUnit("s"),
		metric.WithDescription("Duration of inbound HTTP server requests, in seconds."),
	)
	if err != nil {
		return nil, err
	}
	active, err := m.Int64UpDownCounter(
		"http.server.active_requests",
		metric.WithUnit("{request}"),
		metric.WithDescription("Number of inbound HTTP server requests currently in flight."),
	)
	if err != nil {
		return nil, err
	}
	return &httpMetrics{duration: duration, active: active}, nil
}

// middleware returns a chi middleware that records http.server.active_requests (up/down per
// in-flight request) and http.server.request.duration (seconds, on completion). Both carry the
// route TEMPLATE (e.g. "/items/{id}") rather than the concrete path, keeping metric cardinality
// bounded. chi only resolves the matched pattern after routing, so the template is resolved up
// front with mux.Find against a throwaway RouteContext; this keeps the active-requests increment
// and decrement on an identical attribute set (a balanced up/down series), which a decrement that
// read the pattern only post-serve could not guarantee.
func (hm *httpMetrics) middleware(mux *chi.Mux) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			route := mux.Find(chi.NewRouteContext(), r.Method, r.URL.Path)

			base := []attribute.KeyValue{
				attribute.String("http.request.method", r.Method),
				attribute.String("http.route", route),
			}
			baseSet := attribute.NewSet(base...)

			ctx := r.Context()
			hm.active.Add(ctx, 1, metric.WithAttributeSet(baseSet))

			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			defer func() {
				hm.active.Add(ctx, -1, metric.WithAttributeSet(baseSet))

				status := ww.Status()
				if status == 0 {
					// A handler that returns without an explicit WriteHeader has implicitly
					// sent 200 OK.
					status = http.StatusOK
				}
				hm.duration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(
					attribute.String("http.request.method", r.Method),
					attribute.String("http.route", route),
					attribute.Int("http.response.status_code", status),
				))
			}()

			next.ServeHTTP(ww, r)
		})
	}
}
