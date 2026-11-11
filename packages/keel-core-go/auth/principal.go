// Package auth is the authentication/authorization port and its OIDC adapter plus the
// deny-by-default HTTP middleware. A verified caller becomes a Principal; routes enforce
// scopes. Mirrors auth.rs + webauth.rs.
package auth

import "context"

// Principal is an authenticated caller: a subject plus the scopes and roles it holds.
type Principal struct {
	Subject string
	Scopes  map[string]struct{}
	Roles   map[string]struct{}
}

// HasScopes reports whether the principal holds every scope in required.
func (p *Principal) HasScopes(required ...string) bool {
	for _, s := range required {
		if _, ok := p.Scopes[s]; !ok {
			return false
		}
	}
	return true
}

// HasRole reports whether the principal holds role.
func (p *Principal) HasRole(role string) bool {
	_, ok := p.Roles[role]
	return ok
}

// Authenticator verifies an opaque or bearer credential and returns the Principal. It
// returns a *domain.DomainError: Unauthenticated (401) for a bad/expired token, Unavailable
// (503) when the key source cannot be reached.
type Authenticator interface {
	Authenticate(ctx context.Context, credential string) (*Principal, error)
}
