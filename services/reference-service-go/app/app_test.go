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

type fakeRepo struct{ items map[string]Item }

func newFakeRepo() *fakeRepo { return &fakeRepo{items: map[string]Item{}} }

func (f *fakeRepo) Create(_ context.Context, item Item) error {
	f.items[item.ID] = item
	return nil
}

func (f *fakeRepo) Get(_ context.Context, id string) (Item, error) {
	if it, ok := f.items[id]; ok {
		return it, nil
	}
	return Item{}, domain.New(domain.NotFound, "item not found")
}

func (f *fakeRepo) List(_ context.Context, _, _ int) ([]Item, error) {
	out := make([]Item, 0, len(f.items))
	for _, it := range f.items {
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
	created := req(t, h, "POST", "/v1/items", `{"name":"widget"}`, "tok")
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (%s)", created.Code, created.Body)
	}
	var item itemOut
	if err := json.Unmarshal(created.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if item.Name != "widget" || item.ID == "" {
		t.Fatalf("created item = %+v", item)
	}

	got := req(t, h, "GET", "/v1/items/"+item.ID, "", "tok")
	if got.Code != http.StatusOK {
		t.Fatalf("get = %d, want 200", got.Code)
	}

	listed := req(t, h, "GET", "/v1/items", "", "tok")
	if listed.Code != http.StatusOK {
		t.Fatalf("list = %d, want 200", listed.Code)
	}
	var list itemListOut
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
	conformance.AssertDeniesAnonymous(t, h, "POST", "/v1/items", `{"name":"x"}`)
	conformance.AssertDeniesAnonymous(t, h, "GET", "/v1/items", "")
	conformance.AssertDeniesAnonymous(t, h, "GET", "/v1/items/anything", "")
	// "tok" authenticates but holds no scopes, so a write is forbidden.
	conformance.AssertRequiresScope(t, h, "POST", "/v1/items", "tok", `{"name":"x"}`)
}

func TestItemsCRUDWithInMemoryRepo(t *testing.T) {
	h := BuildApp(newFakeRepo(), func(context.Context) bool { return true }, stub("items:read", "items:write"), httpx.AppConfig{})
	crudRoundTrip(t, h)
}

// Integration: the real pgx repository against Postgres (t.Skip reports as skipped when the
// URL is absent; fails loudly when set but unreachable).
func TestItemsCRUDAgainstPostgres(t *testing.T) {
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
	repo := NewSqlItemRepository(db)
	if err := repo.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool().Exec(ctx, `DELETE FROM items`); err != nil {
		t.Fatal(err)
	}
	h := BuildApp(repo, func(c context.Context) bool { return db.Ping(c) }, stub("items:read", "items:write"), httpx.AppConfig{})
	crudRoundTrip(t, h)
}
