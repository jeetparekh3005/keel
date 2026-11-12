package httpx

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// TestRequestMetricsRecordedWithRouteTemplate drives a request through a parametric route and
// asserts both server request metrics were emitted carrying the chi route TEMPLATE (not the
// concrete path), the method, and - for the duration histogram - the status code. Removing the
// metrics middleware from NewRouter makes this test fail: no instruments record, so neither
// metric appears in the collected data.
func TestRequestMetricsRecordedWithRouteTemplate(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))

	prev := otel.GetMeterProvider()
	otel.SetMeterProvider(mp)
	t.Cleanup(func() { otel.SetMeterProvider(prev) })

	h := NewRouter(AppConfig{}, nil, func(r chi.Router) {
		r.Get("/items/{id}", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		})
	})

	// A concrete id that must be collapsed to the "{id}" template in the metric attributes.
	if got := serve(h, "GET", "/items/42", "", nil).Code; got != http.StatusTeapot {
		t.Fatalf("handler status = %d, want 418", got)
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatalf("collect: %v", err)
	}

	duration := findMetric(t, &rm, "http.server.request.duration")
	hist, ok := duration.Data.(metricdata.Histogram[float64])
	if !ok {
		t.Fatalf("duration is %T, want Histogram[float64]", duration.Data)
	}
	dp := onlyHistogramPoint(t, hist)
	if route := strValue(dp.Attributes, "http.route"); route != "/items/{id}" {
		t.Errorf("duration http.route = %q, want the route template /items/{id}", route)
	}
	if method := strValue(dp.Attributes, "http.request.method"); method != "GET" {
		t.Errorf("duration http.request.method = %q, want GET", method)
	}
	if code := intValue(dp.Attributes, "http.response.status_code"); code != http.StatusTeapot {
		t.Errorf("duration http.response.status_code = %d, want 418", code)
	}
	if dp.Count == 0 {
		t.Error("duration histogram recorded zero observations")
	}

	active := findMetric(t, &rm, "http.server.active_requests")
	sum, ok := active.Data.(metricdata.Sum[int64])
	if !ok {
		t.Fatalf("active_requests is %T, want Sum[int64]", active.Data)
	}
	if len(sum.DataPoints) != 1 {
		t.Fatalf("active_requests data points = %d, want 1", len(sum.DataPoints))
	}
	adp := sum.DataPoints[0]
	if route := strValue(adp.Attributes, "http.route"); route != "/items/{id}" {
		t.Errorf("active_requests http.route = %q, want /items/{id}", route)
	}
	if method := strValue(adp.Attributes, "http.request.method"); method != "GET" {
		t.Errorf("active_requests http.request.method = %q, want GET", method)
	}
	// The up/down counter must net to zero once the request completes: a +1 on entry and a
	// -1 on exit on the identical attribute set.
	if adp.Value != 0 {
		t.Errorf("active_requests value = %d after completion, want 0 (balanced)", adp.Value)
	}
}

func findMetric(t *testing.T, rm *metricdata.ResourceMetrics, name string) metricdata.Metrics {
	t.Helper()
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name == name {
				return m
			}
		}
	}
	t.Fatalf("metric %q not recorded (is the metrics middleware wired into NewRouter?)", name)
	return metricdata.Metrics{}
}

func onlyHistogramPoint(t *testing.T, h metricdata.Histogram[float64]) metricdata.HistogramDataPoint[float64] {
	t.Helper()
	if len(h.DataPoints) != 1 {
		t.Fatalf("histogram data points = %d, want 1", len(h.DataPoints))
	}
	return h.DataPoints[0]
}

func strValue(set attribute.Set, key string) string {
	v, ok := set.Value(attribute.Key(key))
	if !ok {
		return ""
	}
	return v.AsString()
}

func intValue(set attribute.Set, key string) int {
	v, ok := set.Value(attribute.Key(key))
	if !ok {
		return 0
	}
	return int(v.AsInt64())
}
