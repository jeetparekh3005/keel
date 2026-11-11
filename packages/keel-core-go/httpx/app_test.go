package httpx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func serve(h http.Handler, method, target string, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHealthProbes(t *testing.T) {
	ok := NewRouter(AppConfig{}, func(context.Context) bool { return true }, nil)
	if got := serve(ok, "GET", "/healthz", "", nil).Code; got != 200 {
		t.Errorf("/healthz = %d, want 200", got)
	}
	if got := serve(ok, "GET", "/readyz", "", nil).Code; got != 200 {
		t.Errorf("/readyz (ready) = %d, want 200", got)
	}
	down := NewRouter(AppConfig{}, func(context.Context) bool { return false }, nil)
	if got := serve(down, "GET", "/readyz", "", nil).Code; got != 503 {
		t.Errorf("/readyz (not ready) = %d, want 503", got)
	}
}

func TestSecurityHeadersPresent(t *testing.T) {
	h := NewRouter(AppConfig{}, nil, nil)
	rec := serve(h, "GET", "/healthz", "", nil)
	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
	}
	for k, v := range want {
		if got := rec.Header().Get(k); got != v {
			t.Errorf("header %s = %q, want %q", k, got, v)
		}
	}
	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Error("missing CSP")
	}
}

func TestOversizedBodyIsRejectedAndStillCarriesEdgeHeaders(t *testing.T) {
	cfg := AppConfig{MaxBodyBytes: 8}
	h := NewRouter(cfg, nil, func(r chi.Router) {
		r.Post("/echo", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	})
	rec := serve(h, "POST", "/echo", strings.Repeat("x", 64), nil)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	// The 413 short-circuits the body-limit middleware but must still carry the outermost
	// security headers and the request id.
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("413 missing security headers")
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Error("413 missing request id")
	}
	if ct := rec.Header().Get("Content-Type"); ct != problemContentType {
		t.Errorf("413 content-type = %q, want problem+json", ct)
	}
}

func TestCORSDenyByDefault(t *testing.T) {
	h := NewRouter(AppConfig{}, nil, nil)
	rec := serve(h, "GET", "/healthz", "", map[string]string{"Origin": "https://evil.example"})
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("CORS must be deny-by-default")
	}
}

func TestCORSAllowlistAndWildcard(t *testing.T) {
	list := NewRouter(AppConfig{CORSAllowOrigins: []string{"https://app.example"}}, nil, nil)
	rec := serve(list, "GET", "/healthz", "", map[string]string{"Origin": "https://app.example"})
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Errorf("ACAO = %q, want the configured origin", got)
	}
	// An origin not on the list gets nothing.
	rec = serve(list, "GET", "/healthz", "", map[string]string{"Origin": "https://other.example"})
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("unlisted origin must not be allowed")
	}

	any := NewRouter(AppConfig{CORSAllowOrigins: []string{"*"}}, nil, nil)
	rec = serve(any, "GET", "/healthz", "", map[string]string{"Origin": "https://anywhere.example"})
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("wildcard ACAO = %q, want *", got)
	}
}

func TestRequestIDMintedAndPropagated(t *testing.T) {
	h := NewRouter(AppConfig{}, nil, nil)
	if serve(h, "GET", "/healthz", "", nil).Header().Get("X-Request-Id") == "" {
		t.Error("a request id must be minted")
	}
	rec := serve(h, "GET", "/healthz", "", map[string]string{"X-Request-Id": "client-123"})
	if got := rec.Header().Get("X-Request-Id"); got != "client-123" {
		t.Errorf("client request id not propagated: %q", got)
	}
}
