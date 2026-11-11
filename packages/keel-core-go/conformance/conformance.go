// Package conformance is the behavioral contract suite: assertions a service runs against
// its composed http.Handler to prove it honors platform.yaml, so an over-claim or broken
// wiring fails a test rather than shipping. The Go mirror of the Rust testkit::conformance.
package conformance

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func do(h http.Handler, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// AssertHealth checks platform.yaml health: /healthz is 200 and /readyz is 200 or 503.
func AssertHealth(t *testing.T, h http.Handler) {
	t.Helper()
	if got := do(h, "GET", "/healthz", "", nil).Code; got != http.StatusOK {
		t.Errorf("/healthz = %d, want 200", got)
	}
	ready := do(h, "GET", "/readyz", "", nil).Code
	if ready != http.StatusOK && ready != http.StatusServiceUnavailable {
		t.Errorf("/readyz = %d, want 200 or 503", ready)
	}
}

// AssertSecurityHeaders checks the always-on edge headers are present.
func AssertSecurityHeaders(t *testing.T, h http.Handler) {
	t.Helper()
	rec := do(h, "GET", "/healthz", "", nil)
	for _, k := range []string{
		"Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options",
		"Referrer-Policy", "Permissions-Policy",
	} {
		if rec.Header().Get(k) == "" {
			t.Errorf("missing security header %s", k)
		}
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
}

// AssertCORSDenyByDefault checks no Access-Control-Allow-Origin is returned for a
// cross-origin request when no origins are configured.
func AssertCORSDenyByDefault(t *testing.T, h http.Handler) {
	t.Helper()
	rec := do(h, "GET", "/healthz", "", map[string]string{"Origin": "https://evil.example"})
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("CORS must be deny-by-default")
	}
}

// AssertDeniesAnonymous checks a protected route rejects an unauthenticated caller with 401.
func AssertDeniesAnonymous(t *testing.T, h http.Handler, method, path, body string) {
	t.Helper()
	if got := do(h, method, path, body, jsonHeaders(body)).Code; got != http.StatusUnauthorized {
		t.Errorf("%s %s anonymous = %d, want 401", method, path, got)
	}
}

// AssertRequiresScope checks an authenticated caller lacking the route's scope gets 403.
// bearer is a token the app's authenticator accepts but whose principal lacks the scope.
func AssertRequiresScope(t *testing.T, h http.Handler, method, path, bearer, body string) {
	t.Helper()
	headers := jsonHeaders(body)
	headers["Authorization"] = "Bearer " + bearer
	if got := do(h, method, path, body, headers).Code; got != http.StatusForbidden {
		t.Errorf("%s %s insufficient scope = %d, want 403", method, path, got)
	}
}

// AssertProblemResponse checks a response is RFC 9457 problem+json with the expected status.
func AssertProblemResponse(t *testing.T, rec *httptest.ResponseRecorder, status int) {
	t.Helper()
	if rec.Code != status {
		t.Errorf("status = %d, want %d", rec.Code, status)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/problem+json") {
		t.Errorf("content-type = %q, want problem+json", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("problem body not JSON: %v", err)
	}
	for _, f := range []string{"type", "title", "status"} {
		if _, ok := body[f]; !ok {
			t.Errorf("problem+json missing %q", f)
		}
	}
}

func jsonHeaders(body string) map[string]string {
	if body == "" {
		return map[string]string{}
	}
	return map[string]string{"Content-Type": "application/json"}
}
