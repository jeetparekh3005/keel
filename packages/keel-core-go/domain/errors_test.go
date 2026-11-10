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
