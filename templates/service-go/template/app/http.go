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

type << aggregate >>Out struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type << aggregate >>ListOut struct {
	<< aggregate_pascal_plural >>  []<< aggregate >>Out `json:"<< aggregate_plural >>"`
	Limit  int       `json:"limit"`
	Offset int       `json:"offset"`
	Count  int       `json:"count"`
}

// << aggregate_plural >>Routes registers the << aggregate_plural >> aggregate routes. Each declares its required scope.
func << aggregate_plural >>Routes(svc *<< aggregate_pascal >>Service) func(r chi.Router) {
	return func(r chi.Router) {
		r.Post("/v1/<< aggregate_plural >>", create<< aggregate_pascal >>(svc))
		r.Get("/v1/<< aggregate_plural >>", list<< aggregate_pascal_plural >>(svc))
		r.Get("/v1/<< aggregate_plural >>/{id}", get<< aggregate_pascal >>(svc))
	}
}

func create<< aggregate_pascal >>(svc *<< aggregate_pascal >>Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.RequireScopes(r.Context(), "<< scope_prefix >>:write"); err != nil {
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
		<< aggregate >>, err := svc.Create(r.Context(), in.Name)
		if err != nil {
			writeDomainError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, << aggregate >>Out(<< aggregate >>))
	}
}

func get<< aggregate_pascal >>(svc *<< aggregate_pascal >>Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.RequireScopes(r.Context(), "<< scope_prefix >>:read"); err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		<< aggregate >>, err := svc.Get(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			writeDomainError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, << aggregate >>Out(<< aggregate >>))
	}
}

func list<< aggregate_pascal_plural >>(svc *<< aggregate_pascal >>Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := auth.RequireScopes(r.Context(), "<< scope_prefix >>:read"); err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		limit := clampInt(queryInt(r, "limit", 50), 1, 200)
		offset := maxInt(queryInt(r, "offset", 0), 0)
		<< aggregate_plural >>, err := svc.List(r.Context(), limit, offset)
		if err != nil {
			writeDomainError(w, r, err)
			return
		}
		out := << aggregate >>ListOut{<< aggregate_pascal_plural >>: make([]<< aggregate >>Out, 0, len(<< aggregate_plural >>)), Limit: limit, Offset: offset}
		for _, << aggregate >> := range << aggregate_plural >> {
			out.<< aggregate_pascal_plural >> = append(out.<< aggregate_pascal_plural >>, << aggregate >>Out(<< aggregate >>))
		}
		out.Count = len(out.<< aggregate_pascal_plural >>)
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
