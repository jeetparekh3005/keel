package auth

// Live OIDCAuthenticator check against a real Keycloak (epic #419, v0.6 parity).
//
// Runs only when KEEL_KEYCLOAK_URL is set (CI imports deploy/keycloak/realm.json into a
// Keycloak container); skipped otherwise, matching the Postgres integration test's honest
// gating. It mints a real service-account token via client_credentials and verifies it
// against the live JWKS, so the go-oidc RemoteKeySet performs a real remote key fetch.
// No JWT or key material is committed.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// mintClientCredentialsToken obtains an access token from Keycloak's token endpoint using the
// client_credentials grant, exactly as a service-to-service caller would.
func mintClientCredentialsToken(ctx context.Context, t *testing.T, realmBase, clientID, clientSecret string) string {
	t.Helper()
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {clientID},
		"client_secret": {clientSecret},
	}
	tokenURL := realmBase + "/protocol/openid-connect/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatalf("build token request: %v", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", tokenURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("token endpoint returned %s", resp.Status)
	}

	var body struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode token response: %v", err)
	}
	if body.AccessToken == "" {
		t.Fatal("token endpoint returned an empty access_token")
	}
	return body.AccessToken
}

// TestAuthenticatesRealKeycloakToken exercises the full OIDC path against a live Keycloak: mint a
// client_credentials token, build the real authenticator pointed at the live issuer and JWKS URI
// (so RemoteKeySet fetches real signing keys over the network), verify the token, and assert the
// service-account subject is present.
func TestAuthenticatesRealKeycloakToken(t *testing.T) {
	kcURL := os.Getenv("KEEL_KEYCLOAK_URL")
	if kcURL == "" {
		t.Skip("KEEL_KEYCLOAK_URL not set; skipping live Keycloak integration test")
	}
	realm := envOr("KEEL_KEYCLOAK_REALM", "keel")
	clientID := envOr("KEEL_KEYCLOAK_CLIENT_ID", "keel-api")
	clientSecret := envOr("KEEL_KEYCLOAK_CLIENT_SECRET", "test-secret")
	audience := envOr("KEEL_OIDC_AUDIENCE", "keel-api")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	realmBase := strings.TrimRight(kcURL, "/") + "/realms/" + realm
	token := mintClientCredentialsToken(ctx, t, realmBase, clientID, clientSecret)

	// Point the authenticator at the live issuer and JWKS URI; RemoteKeySet fetches the real keys.
	jwksURL := realmBase + "/protocol/openid-connect/certs"
	authenticator := NewOIDCAuthenticator(ctx, realmBase, audience, jwksURL)

	principal, err := authenticator.Authenticate(ctx, token)
	if err != nil {
		t.Fatalf("authenticate real Keycloak token: %v", err)
	}
	if principal.Subject == "" {
		t.Fatal("expected a non-empty subject (service-account user id)")
	}
}
