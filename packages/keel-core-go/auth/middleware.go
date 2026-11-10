package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/httpx"
)

type ctxKey int

const principalKey ctxKey = iota

// Middleware authenticates the bearer token and stores the Principal in the context.
// Applied to a route group it makes those routes deny-by-default: a missing or invalid
// token is rejected (401), a key-source outage is a 503, before the handler runs. Failures
// are rendered as RFC 9457 problem+json.
func Middleware(a Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := bearerToken(r)
			if !ok {
				httpx.WriteError(w, r, domain.New(domain.Unauthenticated, "missing bearer token"))
				return
			}
			principal, err := a.Authenticate(r.Context(), token)
			if err != nil {
				var de *domain.DomainError
				if !errors.As(err, &de) {
					de = domain.New(domain.Unauthenticated, "invalid token")
				}
				httpx.WriteError(w, r, de)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey, principal)))
		})
	}
}

// PrincipalFrom returns the authenticated principal stored on the context.
func PrincipalFrom(ctx context.Context) (*Principal, bool) {
	p, ok := ctx.Value(principalKey).(*Principal)
	return p, ok
}

// RequireScopes returns a Forbidden DomainError if the context's principal lacks any of the
// required scopes, or nil when all are present. It returns Unauthenticated if there is no
// principal on the context (a route guarded without the auth middleware).
func RequireScopes(ctx context.Context, scopes ...string) *domain.DomainError {
	p, ok := PrincipalFrom(ctx)
	if !ok {
		return domain.New(domain.Unauthenticated, "no authenticated principal")
	}
	if !p.HasScopes(scopes...) {
		return domain.New(domain.Forbidden, "insufficient scope")
	}
	return nil
}

// bearerToken extracts the token from the Authorization header. The scheme is matched
// case-insensitively per RFC 7235 (so "bearer" is accepted as well as "Bearer").
func bearerToken(r *http.Request) (string, bool) {
	scheme, token, found := strings.Cut(r.Header.Get("Authorization"), " ")
	if !found || !strings.EqualFold(scheme, "bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}
