package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"
)

const maxNameLen = 200

type itemOut struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type itemListOut struct {
	Items  []itemOut `json:"items"`
	Limit  int       `json:"limit"`
	Offset int       `json:"offset"`
	Count  int       `json:"count"`
}

// itemsRoutes registers the items aggregate routes. Each declares its required scope.
func itemsRoutes(svc *ItemService) func(r chi.Router) {
	return func(r chi.Router) {
		r.Post("/v1/items", createItem(svc))
		r.Get("/v1/items", listItems(svc))
		r.Get("/v1/items/{id}", getItem(svc))
	}
}

func createItem(svc *ItemService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.RequireScopes(r.Context(), "items:write"); err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		var in struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			httpx.WriteError(w, r, domain.New(domain.Validation, "invalid request body"))
			return
		}
		if in.Name == "" || len(in.Name) > maxNameLen {
			httpx.WriteError(w, r, domain.New(domain.Validation, "name must be 1..=200 characters"))
			return
		}
		item, err := svc.Create(r.Context(), in.Name)
		if err != nil {
			writeDomainError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, itemOut(item))
	}
}

func getItem(svc *ItemService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.RequireScopes(r.Context(), "items:read"); err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		item, err := svc.Get(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			writeDomainError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, itemOut(item))
	}
}

func listItems(svc *ItemService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.RequireScopes(r.Context(), "items:read"); err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		limit := clampInt(queryInt(r, "limit", 50), 1, 200)
		offset := maxInt(queryInt(r, "offset", 0), 0)
		items, err := svc.List(r.Context(), limit, offset)
		if err != nil {
			writeDomainError(w, r, err)
			return
		}
		out := itemListOut{Items: make([]itemOut, 0, len(items)), Limit: limit, Offset: offset}
		for _, item := range items {
			out.Items = append(out.Items, itemOut(item))
		}
		out.Count = len(out.Items)
		writeJSON(w, http.StatusOK, out)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// writeDomainError renders a *domain.DomainError; a non-domain error becomes a generic 500.
func writeDomainError(w http.ResponseWriter, r *http.Request, err error) {
	var de *domain.DomainError
	if !errors.As(err, &de) {
		de = domain.New(domain.Internal, err.Error())
	}
	httpx.WriteError(w, r, de)
}

func queryInt(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func clampInt(v, lo, hi int) int { return maxInt(lo, minInt(v, hi)) }
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
