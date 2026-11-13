package domain

import (
	"encoding/json"
	"testing"
)

func TestStatusCodesMatchTheContractTaxonomy(t *testing.T) {
	cases := map[ErrorCategory]int{
		Validation:      400,
		Unauthenticated: 401,
		Forbidden:       403,
		NotFound:        404,
		Conflict:        409,
		RateLimited:     429,
		Internal:        500,
		Unavailable:     503,
	}
	for category, want := range cases {
		if got := category.Status(); got != want {
			t.Errorf("%s.Status() = %d, want %d", category.Slug(), got, want)
		}
	}
}

func TestTypeURIIsStableAndNamespaced(t *testing.T) {
	if got := NotFound.TypeURI(); got != "urn:keel:error:not_found" {
		t.Errorf("TypeURI() = %q, want urn:keel:error:not_found", got)
	}
}

// TestSlugAndTitleForEveryCategory pins the stable machine slug and human title of every
// taxonomy category (platform.yaml errors.taxonomy), exercising every switch arm. These
// strings are part of the contract: the slug appears in the problem type URI and in logs,
// the title in the RFC 9457 body, so a silent rename would be a breaking change.
func TestSlugAndTitleForEveryCategory(t *testing.T) {
	cases := []struct {
		category    ErrorCategory
		slug, title string
	}{
		{Validation, "validation", "Bad Request"},
		{Unauthenticated, "unauthenticated", "Unauthorized"},
		{Forbidden, "forbidden", "Forbidden"},
		{NotFound, "not_found", "Not Found"},
		{Conflict, "conflict", "Conflict"},
		{RateLimited, "rate_limited", "Too Many Requests"},
		{Internal, "internal", "Internal Server Error"},
		{Unavailable, "unavailable", "Service Unavailable"},
	}
	for _, c := range cases {
		if got := c.category.Slug(); got != c.slug {
			t.Errorf("Slug() = %q, want %q", got, c.slug)
		}
		if got := c.category.Title(); got != c.title {
			t.Errorf("Title() = %q, want %q", got, c.title)
		}
	}
	// An unknown (out-of-range) category fails closed to the internal arm of every switch.
	unknown := ErrorCategory(99)
	if got := unknown.Slug(); got != "internal" {
		t.Errorf("unknown Slug() = %q, want internal", got)
	}
	if got := unknown.Title(); got != "Internal Server Error" {
		t.Errorf("unknown Title() = %q, want Internal Server Error", got)
	}
	if got := unknown.Status(); got != 500 {
		t.Errorf("unknown Status() = %d, want 500", got)
	}
}

// TestErrorStringFormat checks DomainError implements error as "<slug>: <detail>", the form
// that reaches logs and wrapped-error chains (errors.Is/As at the adapter boundary).
func TestErrorStringFormat(t *testing.T) {
	err := New(NotFound, "item not found")
	if got := err.Error(); got != "not_found: item not found" {
		t.Errorf("Error() = %q, want %q", got, "not_found: item not found")
	}
	var de error = New(Validation, "name is required")
	if de.Error() != "validation: name is required" {
		t.Errorf("Error() = %q", de.Error())
	}
}

func TestClientFaultKeepsDetail(t *testing.T) {
	p := New(Validation, "name is required").ToProblem("")
	if p.Detail != "name is required" {
		t.Errorf("Detail = %q, want %q", p.Detail, "name is required")
	}
	if p.Status != 400 || p.Type != "urn:keel:error:validation" {
		t.Errorf("unexpected problem: %+v", p)
	}
}

func TestServerFaultDropsDetail(t *testing.T) {
	for _, category := range []ErrorCategory{Internal, Unavailable} {
		p := New(category, "commit: duplicate key value violates unique constraint").ToProblem("")
		if p.Detail != "" {
			t.Errorf("%s must not expose internal detail, got %q", category.Slug(), p.Detail)
		}
	}
}

func TestProblemOmitsEmptyFields(t *testing.T) {
	// detail and instance are omitempty: a server fault with no instance serializes
	// without either key.
	b, err := json.Marshal(New(Internal, "boom").ToProblem(""))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["detail"]; ok {
		t.Errorf("detail must be omitted, got %s", b)
	}
	if _, ok := m["instance"]; ok {
		t.Errorf("instance must be omitted, got %s", b)
	}
	for _, k := range []string{"type", "title", "status"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %q in %s", k, b)
		}
	}
}
