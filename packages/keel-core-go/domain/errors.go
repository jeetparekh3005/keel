// Package domain holds the pure domain layer: the error taxonomy and its RFC 9457
// problem+json representation. It mirrors platform.yaml errors.taxonomy and the Python
// and Rust verticals: one category per failure, each mapping to a stable HTTP status and
// a machine-readable urn:keel:error:* type. The domain raises a DomainError; adapters
// render it as a Problem, never leaking internals.
package domain

import "fmt"

// ErrorCategory is a domain failure category; each maps to an HTTP status.
type ErrorCategory int

const (
	Validation ErrorCategory = iota
	Unauthenticated
	Forbidden
	NotFound
	Conflict
	RateLimited
	Internal
	Unavailable
)

// Status is the HTTP status code for this category (platform.yaml taxonomy).
func (c ErrorCategory) Status() int {
	switch c {
	case Validation:
		return 400
	case Unauthenticated:
		return 401
	case Forbidden:
		return 403
	case NotFound:
		return 404
	case Conflict:
		return 409
	case RateLimited:
		return 429
	case Unavailable:
		return 503
	default: // Internal and any unknown value fail closed to 500.
		return 500
	}
}

// Slug is the stable identifier used in the problem type URI and logs.
func (c ErrorCategory) Slug() string {
	switch c {
	case Validation:
		return "validation"
	case Unauthenticated:
		return "unauthenticated"
	case Forbidden:
		return "forbidden"
	case NotFound:
		return "not_found"
	case Conflict:
		return "conflict"
	case RateLimited:
		return "rate_limited"
	case Unavailable:
		return "unavailable"
	default:
		return "internal"
	}
}

// Title is a short human-readable title for the problem response.
func (c ErrorCategory) Title() string {
	switch c {
	case Validation:
		return "Bad Request"
	case Unauthenticated:
		return "Unauthorized"
	case Forbidden:
		return "Forbidden"
	case NotFound:
		return "Not Found"
	case Conflict:
		return "Conflict"
	case RateLimited:
		return "Too Many Requests"
	case Unavailable:
		return "Service Unavailable"
	default:
		return "Internal Server Error"
	}
}

// TypeURI is the machine-readable problem type for this category.
func (c ErrorCategory) TypeURI() string {
	return "urn:keel:error:" + c.Slug()
}

// IsServerFault reports whether this is a server-side fault (5xx) whose detail may embed
// internal diagnostics (SQL text, driver errors). Such detail must not reach the client;
// it is logged server-side instead.
func (c ErrorCategory) IsServerFault() bool {
	return c == Internal || c == Unavailable
}

// DomainError is a category plus a human-readable detail. It implements error.
type DomainError struct {
	Category ErrorCategory
	Detail   string
}

// New builds a DomainError in category with detail.
func New(category ErrorCategory, detail string) *DomainError {
	return &DomainError{Category: category, Detail: detail}
}

func (e *DomainError) Error() string {
	return fmt.Sprintf("%s: %s", e.Category.Slug(), e.Detail)
}

// Problem is an RFC 9457 problem+json body (application/problem+json).
type Problem struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Instance string `json:"instance,omitempty"`
}

// ToProblem renders the error as a Problem. For server-fault categories (5xx) the detail
// is dropped: it may contain internal diagnostics that must never reach a client (adapters
// log the real detail instead). Client-fault categories (4xx) keep their caller-facing
// detail. instance is an optional request URI.
func (e *DomainError) ToProblem(instance string) Problem {
	p := Problem{
		Type:     e.Category.TypeURI(),
		Title:    e.Category.Title(),
		Status:   e.Category.Status(),
		Instance: instance,
	}
	if !e.Category.IsServerFault() {
		p.Detail = e.Detail
	}
	return p
}
