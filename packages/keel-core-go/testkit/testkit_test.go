package testkit

import (
	"context"
	"testing"
	"time"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

func TestFrozenClock(t *testing.T) {
	at := time.Unix(42, 0)
	if (FrozenClock{Instant: at}).Now() != at {
		t.Error("frozen clock must return its instant")
	}
}

func TestInMemorySecretProvider(t *testing.T) {
	p := InMemorySecretProvider{Secrets: map[string]string{"k": "v"}}
	if v, ok := p.Get("k"); !ok || v != "v" {
		t.Errorf("Get(k) = %q,%v", v, ok)
	}
	if _, ok := p.Get("missing"); ok {
		t.Error("missing key should be ok=false")
	}
}

func TestStubAuthenticatorAcceptsKnownTokens(t *testing.T) {
	s := StubAuthenticator{Principals: map[string]*auth.Principal{
		"tok": Principal("user-1", "items:read"),
	}}
	p, err := s.Authenticate(context.Background(), "tok")
	if err != nil || p.Subject != "user-1" || !p.HasScopes("items:read") {
		t.Fatalf("known token rejected: %v %+v", err, p)
	}
	_, err = s.Authenticate(context.Background(), "nope")
	de, ok := err.(*domain.DomainError)
	if !ok || de.Category != domain.Unauthenticated {
		t.Fatalf("unknown token should be Unauthenticated, got %v", err)
	}
}
