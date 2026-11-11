// Package testkit ships in-memory fakes for the driven ports plus, via the conformance
// subpackage, the behavioral contract suite a service runs against its own app. Shipped so
// every vertical can test by contract (ADR-0009 Tier 1).
package testkit

import (
	"context"
	"time"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// FrozenClock is a ports.Clock frozen at a fixed instant.
type FrozenClock struct{ Instant time.Time }

// Now returns the frozen instant.
func (c FrozenClock) Now() time.Time { return c.Instant }

// InMemorySecretProvider is a map-backed ports.SecretProvider.
type InMemorySecretProvider struct{ Secrets map[string]string }

// Get returns the secret for key, if present.
func (p InMemorySecretProvider) Get(key string) (string, bool) {
	v, ok := p.Secrets[key]
	return v, ok
}

// StubAuthenticator maps known tokens to principals; anything else is rejected. For wiring
// tests without a real IdP.
type StubAuthenticator struct{ Principals map[string]*auth.Principal }

// Authenticate returns the principal mapped to credential, or an Unauthenticated error.
func (s StubAuthenticator) Authenticate(_ context.Context, credential string) (*auth.Principal, error) {
	if p, ok := s.Principals[credential]; ok {
		return p, nil
	}
	return nil, domain.New(domain.Unauthenticated, "invalid token")
}

// Principal builds a test principal with the given subject and scopes.
func Principal(subject string, scopes ...string) *auth.Principal {
	set := make(map[string]struct{}, len(scopes))
	for _, s := range scopes {
		set[s] = struct{}{}
	}
	return &auth.Principal{Subject: subject, Scopes: set, Roles: map[string]struct{}{}}
}

var (
	_ ports.Clock          = FrozenClock{}
	_ ports.SecretProvider = InMemorySecretProvider{}
	_ auth.Authenticator   = StubAuthenticator{}
)
