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

// apiKeyHeader carries an opaque API key as an alternative to a bearer JWT (platform.yaml auth).
const apiKeyHeader = "X-API-Key"

// Middleware authenticates the bearer token and stores the Principal in the context.
// Applied to a route group it makes those routes deny-by-default: a missing or invalid
// token is rejected (401), a key-source outage is a 503, before the handler runs. Failures
// are rendered as RFC 9457 problem+json.
func Middleware(a Authenticator) func(http.Handler) http.Handler {
	return MiddlewareWithAPIKey(a, nil)
}

// MiddlewareWithAPIKey authenticates a request by EITHER an X-API-Key header (verified by
// apiKeys) OR a bearer JWT (verified by bearer), storing the resulting Principal in the
// context. An X-API-Key header, when apiKeys is configured, takes the api-key path; otherwise
// the Authorization bearer token takes the JWT path. Either way the same Principal type lands
// on the context, so the deny-by-default scope check is identical: an api-key caller lacking a
// route's required scope is still rejected (403). Passing a nil apiKeys disables the api-key
// path (plain Middleware), leaving bearer-only behaviour. Failures render as RFC 9457
// problem+json: a missing credential or bad key/token is 401, a key-source outage is 503.
func MiddlewareWithAPIKey(bearer, apiKeys Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authr, credential, ok := selectCredential(r, bearer, apiKeys)
			if !ok {
				httpx.WriteError(w, r, domain.New(domain.Unauthenticated, "missing bearer or api-key credential"))
				return
			}
			principal, err := authr.Authenticate(r.Context(), credential)
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

// selectCredential picks the credential and the authenticator that verifies it. An X-API-Key
// header (when an api-key authenticator is configured) routes to the api-key path; otherwise
// the Authorization bearer token routes to the JWT path. Returns false when neither is present.
func selectCredential(r *http.Request, bearer, apiKeys Authenticator) (Authenticator, string, bool) {
	if apiKeys != nil {
		if key := strings.TrimSpace(r.Header.Get(apiKeyHeader)); key != "" {
			return apiKeys, key, true
		}
	}
	if token, ok := bearerToken(r); ok {
		return bearer, token, true
	}
	return nil, "", false
}

// ContextWithPrincipal returns a copy of ctx carrying the authenticated principal. A
// non-HTTP transport (e.g. the gRPC auth interceptor) publishes the Principal through this
// so PrincipalFrom and RequireScopes read it identically regardless of transport, keeping a
// single principal context key across the HTTP middleware and the gRPC server factory.
func ContextWithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalKey, p)
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
