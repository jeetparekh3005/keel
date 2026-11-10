package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

const (
	testIssuer   = "https://issuer.example"
	testAudience = "keel-api"
	testKID      = "test-key"
)

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// signRS256 builds a signed RS256 JWT by hand, so the tests need no JWT dependency and no
// key material is committed.
func signRS256(t *testing.T, key *rsa.PrivateKey, claimsJSON map[string]any) string {
	t.Helper()
	header, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT", "kid": testKID})
	payload, _ := json.Marshal(claimsJSON)
	signingInput := b64url(header) + "." + b64url(payload)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signingInput + "." + b64url(sig)
}

func newAuthenticator(t *testing.T) (*OIDCAuthenticator, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwk := map[string]any{
		"kty": "RSA", "use": "sig", "alg": "RS256", "kid": testKID,
		"n": b64url(key.N.Bytes()),
		"e": b64url(big.NewInt(int64(key.E)).Bytes()),
	}
	body, _ := json.Marshal(map[string]any{"keys": []any{jwk}})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return NewOIDCAuthenticator(context.Background(), testIssuer, testAudience, srv.URL), key
}

func baseClaims() map[string]any {
	return map[string]any{
		"sub": "user-1",
		"iss": testIssuer,
		"aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	}
}

func TestValidTokenYieldsPrincipalWithScopesFromScopeClaim(t *testing.T) {
	a, key := newAuthenticator(t)
	c := baseClaims()
	c["scope"] = "items:read items:write"
	c["realm_access"] = map[string]any{"roles": []string{"admin"}}

	p, err := a.Authenticate(context.Background(), signRS256(t, key, c))
	if err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if p.Subject != "user-1" || !p.HasScopes("items:read", "items:write") || !p.HasRole("admin") {
		t.Fatalf("unexpected principal: %+v", p)
	}
}

func TestScpAsArrayAndAsSpaceDelimitedString(t *testing.T) {
	a, key := newAuthenticator(t)

	arr := baseClaims()
	arr["scp"] = []string{"orders:read", "orders:write"}
	p, err := a.Authenticate(context.Background(), signRS256(t, key, arr))
	if err != nil || !p.HasScopes("orders:read", "orders:write") {
		t.Fatalf("array scp failed: %v %+v", err, p)
	}

	// Microsoft Entra / Azure AD emits scp as a space-delimited string.
	str := baseClaims()
	str["scp"] = "orders:read orders:write"
	p, err = a.Authenticate(context.Background(), signRS256(t, key, str))
	if err != nil || !p.HasScopes("orders:read", "orders:write") {
		t.Fatalf("string scp failed: %v %+v", err, p)
	}
}

func TestExpiredAndWrongAudienceAreUnauthenticated(t *testing.T) {
	a, key := newAuthenticator(t)

	expired := baseClaims()
	expired["exp"] = time.Now().Add(-time.Hour).Unix()
	assertUnauthenticated(t, a, signRS256(t, key, expired))

	wrongAud := baseClaims()
	wrongAud["aud"] = "some-other-api"
	assertUnauthenticated(t, a, signRS256(t, key, wrongAud))

	wrongIss := baseClaims()
	wrongIss["iss"] = "https://evil.example"
	assertUnauthenticated(t, a, signRS256(t, key, wrongIss))
}

func assertUnauthenticated(t *testing.T, a *OIDCAuthenticator, token string) {
	t.Helper()
	_, err := a.Authenticate(context.Background(), token)
	if err == nil {
		t.Fatal("expected rejection")
	}
	de, ok := err.(*domain.DomainError)
	if !ok || de.Category != domain.Unauthenticated {
		t.Fatalf("want Unauthenticated, got %v", err)
	}
}
