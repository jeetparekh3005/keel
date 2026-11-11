package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

// OIDCAuthenticator verifies RS256 bearer JWTs against an issuer's JWKS. The underlying
// go-oidc RemoteKeySet fetches, caches, and refreshes the JWKS natively (including on an
// unknown kid), so signing-key rotation is tolerated without a restart.
type OIDCAuthenticator struct {
	verifier *oidc.IDTokenVerifier
}

// NewOIDCAuthenticator builds an authenticator for issuer/audience that reads keys from
// jwksURL. Tokens are required to be RS256 with valid iss/aud/exp/sub.
func NewOIDCAuthenticator(ctx context.Context, issuer, audience, jwksURL string) *OIDCAuthenticator {
	keySet := oidc.NewRemoteKeySet(ctx, jwksURL)
	verifier := oidc.NewVerifier(issuer, keySet, &oidc.Config{
		ClientID:             audience,
		SupportedSigningAlgs: []string{oidc.RS256},
	})
	return &OIDCAuthenticator{verifier: verifier}
}

// claims is the subset of the token we turn into a Principal. scp is accepted as either an
// array (most IdPs) or a space-delimited string (Microsoft Entra / Azure AD).
type claims struct {
	Scope       string          `json:"scope"`
	Scp         json.RawMessage `json:"scp"`
	Roles       []string        `json:"roles"`
	RealmAccess struct {
		Roles []string `json:"roles"`
	} `json:"realm_access"`
}

func (a *OIDCAuthenticator) Authenticate(ctx context.Context, credential string) (*Principal, error) {
	token, err := a.verifier.Verify(ctx, credential)
	if err != nil {
		return nil, classifyVerifyError(err)
	}
	var c claims
	// Verify already validated signature/iss/aud/exp; Claims only decodes the payload.
	_ = token.Claims(&c)

	scopes := make(map[string]struct{})
	for _, s := range strings.Fields(c.Scope) {
		scopes[s] = struct{}{}
	}
	for _, s := range parseScp(c.Scp) {
		scopes[s] = struct{}{}
	}
	roles := make(map[string]struct{})
	for _, r := range c.Roles {
		roles[r] = struct{}{}
	}
	for _, r := range c.RealmAccess.Roles {
		roles[r] = struct{}{}
	}
	return &Principal{Subject: token.Subject, Scopes: scopes, Roles: roles}, nil
}

// parseScp accepts scp as a JSON array of strings or a single space-delimited string.
func parseScp(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		return list
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return strings.Fields(s)
	}
	return nil
}

// classifyVerifyError maps a go-oidc verification failure to the right domain category: a
// key-source outage (network/timeout fetching the JWKS) is Unavailable (503); anything else
// (bad signature, expired, wrong iss/aud, unknown kid) is Unauthenticated (401).
func classifyVerifyError(err error) *domain.DomainError {
	var urlErr *url.Error
	if errors.As(err, &urlErr) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return domain.New(domain.Unavailable, "signing-key source unavailable")
	}
	return domain.New(domain.Unauthenticated, "invalid token")
}
