package adapters

// Live OpenBaoSecretProvider check against a real openbao:2.7.2 dev server (ADR-0023, epic
// #420). Runs only when KEEL_VAULT_ADDR is set (CI starts the dev container); skipped
// otherwise, matching the NATS/Keycloak integration tests' honest gating. It writes a KV v2
// secret with the server's own HTTP API, then reads each field back through the adapter,
// proving the end-to-end token-auth + KV v2 read path. No long-lived state is relied upon.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestOpenBaoLiveReadThroughAdapter(t *testing.T) {
	addr := os.Getenv(envAddr)
	if addr == "" {
		t.Skip("KEEL_VAULT_ADDR not set; skipping live OpenBao integration test")
	}
	token := os.Getenv(envToken)
	if token == "" {
		t.Fatal("KEEL_VAULT_ADDR is set but KEEL_VAULT_TOKEN is not; cannot write the fixture secret")
	}
	mount := getenvDefault(envMount, defaultMount)
	path := os.Getenv(envPath)
	if path == "" {
		t.Fatal("KEEL_VAULT_ADDR is set but KEEL_VAULT_PATH is not")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	want := map[string]string{
		"api_key":     "live-integration-key",
		"db_password": "s3cr3t-p@ss",
	}

	// Write the fixture via the server's KV v2 write API: PUT <mount>/data/<path> {data:{...}}.
	writeURL := addr + "/v1/" + mount + "/data/" + path
	body, _ := json.Marshal(map[string]any{"data": want})
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, writeURL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Vault-Token", token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("write fixture secret to %s: %v", writeURL, err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		t.Fatalf("write fixture secret: status %d: %s", resp.StatusCode, respBody)
	}

	// Read it back through the adapter (it reads KEEL_VAULT_* from the environment).
	p, err := NewOpenBaoSecretProvider(ctx)
	if err != nil {
		t.Fatalf("construct adapter against live OpenBao: %v", err)
	}
	defer func() { _ = p.Close() }()

	for k, v := range want {
		got, ok := p.Get(k)
		if !ok || got != v {
			t.Errorf("Get(%q) = %q,%v through live adapter; want %q,true", k, got, ok, v)
		}
	}
	if _, ok := p.Get("definitely-absent-field"); ok {
		t.Error("an absent field must report ok=false")
	}
}
