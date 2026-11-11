package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/conformance"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/persistence"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/testkit"
)

type fakeRepo struct{ << aggregate_plural >> map[string]<< aggregate_pascal >> }

func newFakeRepo() *fakeRepo { return &fakeRepo{<< aggregate_plural >>: map[string]<< aggregate_pascal >>{}} }

func (f *fakeRepo) Create(_ context.Context, << aggregate >> << aggregate_pascal >>) error {
	f.<< aggregate_plural >>[<< aggregate >>.ID] = << aggregate >>
	return nil
}

func (f *fakeRepo) Get(_ context.Context, id string) (<< aggregate_pascal >>, error) {
	if it, ok := f.<< aggregate_plural >>[id]; ok {
		return it, nil
	}
	return << aggregate_pascal >>{}, domain.New(domain.NotFound, "<< aggregate >> not found")
}

func (f *fakeRepo) List(_ context.Context, _, _ int) ([]<< aggregate_pascal >>, error) {
	out := make([]<< aggregate_pascal >>, 0, len(f.<< aggregate_plural >>))
	for _, it := range f.<< aggregate_plural >> {
		out = append(out, it)
	}
	return out, nil
}

func stub(scopes ...string) testkit.StubAuthenticator {
	return testkit.StubAuthenticator{Principals: map[string]*auth.Principal{
		"tok": testkit.Principal("u", scopes...),
	}}
}

func req(t *testing.T, h http.Handler, method, target, body, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// crudRoundTrip exercises create -> get -> list against a composed app holding both scopes.
func crudRoundTrip(t *testing.T, h http.Handler) {
	t.Helper()
	created := req(t, h, "POST", "/v1/<< aggregate_plural >>", `{"name":"widget"}`, "tok")
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (%s)", created.Code, created.Body)
	}
	var << aggregate >> << aggregate >>Out
	if err := json.Unmarshal(created.Body.Bytes(), &<< aggregate >>); err != nil {
		t.Fatal(err)
	}
	if << aggregate >>.Name != "widget" || << aggregate >>.ID == "" {
		t.Fatalf("created << aggregate >> = %+v", << aggregate >>)
	}

	got := req(t, h, "GET", "/v1/<< aggregate_plural >>/"+<< aggregate >>.ID, "", "tok")
	if got.Code != http.StatusOK {
		t.Fatalf("get = %d, want 200", got.Code)
	}

	listed := req(t, h, "GET", "/v1/<< aggregate_plural >>", "", "tok")
	if listed.Code != http.StatusOK {
		t.Fatalf("list = %d, want 200", listed.Code)
	}
	var list << aggregate >>ListOut
	if err := json.Unmarshal(listed.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.Count != 1 {
		t.Fatalf("list count = %d, want 1", list.Count)
	}
}

func TestConformanceSuitePasses(t *testing.T) {
	h := BuildApp(newFakeRepo(), func(context.Context) bool { return true }, stub(), httpx.AppConfig{})
	conformance.AssertHealth(t, h)
	conformance.AssertSecurityHeaders(t, h)
	conformance.AssertCORSDenyByDefault(t, h)
	conformance.AssertDeniesAnonymous(t, h, "POST", "/v1/<< aggregate_plural >>", `{"name":"x"}`)
	conformance.AssertDeniesAnonymous(t, h, "GET", "/v1/<< aggregate_plural >>", "")
	conformance.AssertDeniesAnonymous(t, h, "GET", "/v1/<< aggregate_plural >>/anything", "")
	// "tok" authenticates but holds no scopes, so a write is forbidden.
	conformance.AssertRequiresScope(t, h, "POST", "/v1/<< aggregate_plural >>", "tok", `{"name":"x"}`)
}

func Test<< aggregate_pascal_plural >>CRUDWithInMemoryRepo(t *testing.T) {
	h := BuildApp(newFakeRepo(), func(context.Context) bool { return true }, stub("<< scope_prefix >>:read", "<< scope_prefix >>:write"), httpx.AppConfig{})
	crudRoundTrip(t, h)
}

// Integration: the real pgx repository against Postgres (t.Skip reports as skipped when the
// URL is absent; fails loudly when set but unreachable).
func Test<< aggregate_pascal_plural >>CRUDAgainstPostgres(t *testing.T) {
	url := os.Getenv("KEEL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("KEEL_TEST_DATABASE_URL not set; skipping Postgres integration test")
	}
	ctx := context.Background()
	db, err := persistence.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer db.Close()
	repo := NewSql<< aggregate_pascal >>Repository(db)
	if err := repo.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `DELETE FROM << aggregate_plural >>`); err != nil {
		t.Fatal(err)
	}
	h := BuildApp(repo, func(c context.Context) bool { return db.Ping(c) }, stub("<< scope_prefix >>:read", "<< scope_prefix >>:write"), httpx.AppConfig{})
	crudRoundTrip(t, h)
}
