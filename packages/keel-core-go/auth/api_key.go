package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

// HashAPIKey returns the SHA-256 hex digest used to store and look up an API key. Keys are
// stored hashed (never plaintext) so a memory disclosure does not leak usable credentials;
// the presented key is hashed and looked up. Mirrors keel-core-py hash_api_key.
func HashAPIKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// APIKeyAuthenticator verifies an opaque API key against a fixed set of SHA-256 key hashes
// and maps it to a Principal (platform.yaml auth; ADR-0006). Keys/hashes should come from
// the secret provider, not source. It satisfies the Authenticator port, so the deny-by-default
// middleware and scope checks treat an api-key caller exactly like a bearer-JWT one.
type APIKeyAuthenticator struct {
	byHash map[string]*Principal
}

// NewAPIKeyAuthenticator builds an authenticator from a mapping of SHA-256 key hex digests
// to principals (prefer this when the hashes already live in a secret store). The map is
// copied so later caller mutations do not affect the authenticator.
func NewAPIKeyAuthenticator(byHash map[string]*Principal) *APIKeyAuthenticator {
	m := make(map[string]*Principal, len(byHash))
	for h, p := range byHash {
		m[h] = p
	}
	return &APIKeyAuthenticator{byHash: m}
}

// APIKeyAuthenticatorFromKeys builds from plaintext keys, hashing each immediately so the
// authenticator never retains the plaintext. Mirrors keel-core-py ApiKeyAuthenticator.from_keys.
func APIKeyAuthenticatorFromKeys(keys map[string]*Principal) *APIKeyAuthenticator {
	byHash := make(map[string]*Principal, len(keys))
	for key, p := range keys {
		byHash[HashAPIKey(key)] = p
	}
	return &APIKeyAuthenticator{byHash: byHash}
}

// Authenticate returns the principal for credential (an API key), or an Unauthenticated
// DomainError on a miss. Lookup is by SHA-256 digest; because the key is high-entropy the
// hashed lookup is not a practical timing oracle for the key's contents. The context is
// unused (no I/O) but present to satisfy the Authenticator port.
func (a *APIKeyAuthenticator) Authenticate(_ context.Context, credential string) (*Principal, error) {
	p, ok := a.byHash[HashAPIKey(credential)]
	if !ok {
		return nil, domain.New(domain.Unauthenticated, "invalid api key")
	}
	return p, nil
}
