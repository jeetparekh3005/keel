// Package httpx is the HTTP inbound adapter: a chi-based application factory, the edge
// middleware (security headers, body limit, request-id, deny-by-default CORS), the health
// probes, and RFC 9457 problem+json rendering, all matching platform.yaml and the Python
// and Rust verticals.
package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

const problemContentType = "application/problem+json"

// WriteError renders a DomainError as an RFC 9457 problem+json response. Server-fault (5xx)
// detail is dropped from the body (ToProblem) and logged server-side instead, so internals
// never reach the client.
func WriteError(w http.ResponseWriter, r *http.Request, err *domain.DomainError) {
	if err.Category.IsServerFault() {
		slog.ErrorContext(r.Context(), "request failed with a server-side fault",
			"category", err.Category.Slug(), "detail", err.Detail)
	}
	writeProblem(w, err.ToProblem(""))
}

func writeProblem(w http.ResponseWriter, p domain.Problem) {
	w.Header().Set("Content-Type", problemContentType)
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p)
}

func writePayloadTooLarge(w http.ResponseWriter) {
	writeProblem(w, domain.Problem{
		Type:   "urn:keel:error:payload_too_large",
		Title:  "Payload Too Large",
		Status: http.StatusRequestEntityTooLarge,
	})
}
