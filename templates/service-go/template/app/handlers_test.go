package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/persistence"
)

// problem is the subset of the RFC 9457 problem+json body the handler tests assert on.
type problem struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Detail string `json:"detail"`
}

func decodeProblem(t *testing.T, body []byte) problem {
	t.Helper()
	var p problem
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, body)
	}
	return p
}

// writerRepo is an << aggregate_pascal >>Repository whose Create fails with a plain (non-domain) error, to drive
// the writeDomainError fallback that wraps an unexpected error as an Internal 500.
type writerRepo struct{ err error }

func (r writerRepo) Create(context.Context, << aggregate_pascal >>) error        { return r.err }
func (r writerRepo) Get(context.Context, string) (<< aggregate_pascal >>, error) { return << aggregate_pascal >>{}, r.err }
func (r writerRepo) List(context.Context, int, int) ([]<< aggregate_pascal >>, error) {
	return nil, r.err
}

func writeApp() http.Handler {
	return BuildApp(newFakeRepo(), func(context.Context) bool { return true },
		stub("<< scope_prefix >>:read", "<< scope_prefix >>:write"), httpx.AppConfig{})
}

func TestCreate<< aggregate_pascal >>RejectsMalformedJSON(t *testing.T) {
	rec := req(t, writeApp(), "POST", "/v1/<< aggregate_plural >>", `{"name":`, "tok")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/problem+json") {
		t.Fatalf("content-type = %q, want problem+json", ct)
	}
	p := decodeProblem(t, rec.Body.Bytes())
	if p.Type != "urn:keel:error:validation" || p.Detail != "invalid request body" {
		t.Fatalf("problem = %+v, want validation / invalid request body", p)
	}
}

func TestCreate<< aggregate_pascal >>RejectsEmptyName(t *testing.T) {
	rec := req(t, writeApp(), "POST", "/v1/<< aggregate_plural >>", `{"name":""}`, "tok")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if p := decodeProblem(t, rec.Body.Bytes()); p.Detail != "name must be 1..=200 characters" {
		t.Fatalf("detail = %q", p.Detail)
	}
}

func TestCreate<< aggregate_pascal >>RejectsOverlongName(t *testing.T) {
	long := strings.Repeat("a", maxNameLen+1)
	rec := req(t, writeApp(), "POST", "/v1/<< aggregate_plural >>", `{"name":"`+long+`"}`, "tok")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for %d-char name", rec.Code, len(long))
	}
	// A name at the limit is accepted.
	ok := req(t, writeApp(), "POST", "/v1/<< aggregate_plural >>", `{"name":"`+strings.Repeat("a", maxNameLen)+`"}`, "tok")
	if ok.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 for %d-char name", ok.Code, maxNameLen)
	}
}

func TestGet<< aggregate_pascal >>NotFoundRendersProblem(t *testing.T) {
	rec := req(t, writeApp(), "GET", "/v1/<< aggregate_plural >>/does-not-exist", "", "tok")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	p := decodeProblem(t, rec.Body.Bytes())
	if p.Type != "urn:keel:error:not_found" || p.Status != 404 {
		t.Fatalf("problem = %+v, want not_found 404", p)
	}
	if p.Detail != "<< aggregate >> not found" {
		t.Fatalf("detail = %q, want %q", p.Detail, "<< aggregate >> not found")
	}
}

func TestList<< aggregate_pascal_plural >>ClampsAndEchoesPagination(t *testing.T) {
	h := writeApp()
	cases := []struct {
		query              string
		wantLimit, wantOff int
	}{
		{"?limit=500&offset=7", 200, 7}, // limit clamped to the 200 ceiling
		{"?limit=0", 1, 0},              // limit clamped up to the floor of 1
		{"?offset=-5", 50, 0},           // negative offset floored to 0, default limit
		{"?limit=abc", 50, 0},           // non-numeric limit falls back to the default
	}
	for _, c := range cases {
		rec := req(t, h, "GET", "/v1/<< aggregate_plural >>"+c.query, "", "tok")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", c.query, rec.Code)
		}
		var out << aggregate >>ListOut
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if out.Limit != c.wantLimit || out.Offset != c.wantOff {
			t.Errorf("%s -> limit=%d offset=%d, want limit=%d offset=%d",
				c.query, out.Limit, out.Offset, c.wantLimit, c.wantOff)
		}
	}
}

// TestRoutesRequireTheirScope checks every << aggregate >> route 403s a caller who authenticates but lacks
// the route's scope (deny-by-default, scope enforced per route). stub() accepts "tok" but its
// principal carries no scopes.
func TestRoutesRequireTheirScope(t *testing.T) {
	h := BuildApp(newFakeRepo(), func(context.Context) bool { return true }, stub(), httpx.AppConfig{})
	cases := []struct{ method, path, body string }{
		{"POST", "/v1/<< aggregate_plural >>", `{"name":"x"}`},
		{"GET", "/v1/<< aggregate_plural >>", ""},
		{"GET", "/v1/<< aggregate_plural >>/anything", ""},
	}
	for _, c := range cases {
		rec := req(t, h, c.method, c.path, c.body, "tok")
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403", c.method, c.path, rec.Code)
		}
	}
}

// TestHandlerWrapsNonDomainErrorAsInternal checks the writeDomainError fallback: an unexpected
// (non *domain.DomainError) error from the service becomes a 500 problem whose internal detail
// is dropped from the body (never leaked to the client).
func TestHandlerWrapsNonDomainErrorAsInternal(t *testing.T) {
	h := BuildApp(writerRepo{err: errors.New("pool exhausted: secret dsn")},
		func(context.Context) bool { return true }, stub("<< scope_prefix >>:read", "<< scope_prefix >>:write"), httpx.AppConfig{})
	rec := req(t, h, "POST", "/v1/<< aggregate_plural >>", `{"name":"widget"}`, "tok")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	p := decodeProblem(t, rec.Body.Bytes())
	if p.Type != "urn:keel:error:internal" || p.Status != 500 {
		t.Fatalf("problem = %+v, want internal 500", p)
	}
	if p.Detail != "" {
		t.Fatalf("internal detail must not leak, got %q", p.Detail)
	}
	if strings.Contains(rec.Body.String(), "secret dsn") {
		t.Fatalf("response leaked internal error text: %s", rec.Body)
	}
}

// --- Repository error paths against the real Postgres (skip without the URL) ---

func newPostgresRepo(t *testing.T) (*Sql<< aggregate_pascal >>Repository, *persistence.Database) {
	t.Helper()
	url := os.Getenv("KEEL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("KEEL_TEST_DATABASE_URL not set; skipping Postgres integration test")
	}
	ctx := context.Background()
	db, err := persistence.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(db.Close)
	repo := NewSql<< aggregate_pascal >>Repository(db)
	if err := repo.EnsureSchema(ctx); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if _, err := db.Pool().Exec(ctx, `DELETE FROM << aggregate_plural >>`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	return repo, db
}

func TestSqlRepoGetReturnsNotFoundForMissingID(t *testing.T) {
	repo, _ := newPostgresRepo(t)
	_, err := repo.Get(context.Background(), "nonexistent")
	assertDomainCategory(t, err, "not_found")
}

func TestSqlRepoCreateRejectsDuplicateID(t *testing.T) {
	repo, _ := newPostgresRepo(t)
	ctx := context.Background()
	<< aggregate >> := << aggregate_pascal >>{ID: "dup-1", Name: "first"}
	if err := repo.Create(ctx, << aggregate >>); err != nil {
		t.Fatalf("first create: %v", err)
	}
	// A second insert with the same primary key violates the unique constraint; the repository
	// maps the driver error to an Internal DomainError (detail stays server-side).
	err := repo.Create(ctx, << aggregate_pascal >>{ID: "dup-1", Name: "second"})
	if err == nil {
		t.Fatal("duplicate insert succeeded, want an error")
	}
	assertDomainCategory(t, err, "internal")
	// The original row is unchanged.
	got, err := repo.Get(ctx, "dup-1")
	if err != nil {
		t.Fatalf("get after conflict: %v", err)
	}
	if got.Name != "first" {
		t.Fatalf("name = %q, want first (conflicting write must not overwrite)", got.Name)
	}
}

func TestSqlRepoListReturnsInsertedRows(t *testing.T) {
	repo, _ := newPostgresRepo(t)
	ctx := context.Background()
	for _, it := range []<< aggregate_pascal >>{{ID: "a", Name: "alpha"}, {ID: "b", Name: "beta"}} {
		if err := repo.Create(ctx, it); err != nil {
			t.Fatalf("create: %v", err)
		}
	}
	<< aggregate_plural >>, err := repo.List(ctx, 50, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(<< aggregate_plural >>) != 2 {
		t.Fatalf("list returned %d << aggregate_plural >>, want 2", len(<< aggregate_plural >>))
	}
	// ORDER BY id, so "a" sorts before "b".
	if << aggregate_plural >>[0].ID != "a" || << aggregate_plural >>[1].ID != "b" {
		t.Fatalf("list order = %v, want [a b]", << aggregate_plural >>)
	}
	// offset skips the first row.
	page, err := repo.List(ctx, 50, 1)
	if err != nil {
		t.Fatalf("list offset: %v", err)
	}
	if len(page) != 1 || page[0].ID != "b" {
		t.Fatalf("offset page = %v, want [b]", page)
	}
}

// assertDomainCategory checks err is a *domain.DomainError whose slug matches want. It reads the
// slug off the Error() string ("<slug>: <detail>") so the service test need not import the domain
// category constants directly.
func assertDomainCategory(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("got nil error, want a %s DomainError", want)
	}
	slug, _, found := strings.Cut(err.Error(), ": ")
	if !found || slug != want {
		t.Fatalf("error = %q, want category %q", err.Error(), want)
	}
}
