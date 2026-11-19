package adapters

// Live GcpSecretManagerSecretProvider check against real GCP Secret Manager (ADR-0024). GCP has
// no official emulator, so unlike the AWS LocalStack test this one cannot run in CI: it is gated
// on KEEL_GCP_SECRET and runs only where real Application Default Credentials and a pre-created
// secret exist (a developer workstation or a GCP-authenticated job). It skips otherwise, so CI -
// which never sets KEEL_GCP_SECRET - skips it. This is the one secret backend without a CI-run
// integration test (ADR-0024 Testing); its hermetic unit coverage (gcpsecrets_test.go) is
// correspondingly thorough.
//
// To run it, create a secret whose latest version is a JSON object of fields, then point the
// adapter at it with real ADC, for example:
//
//	printf '{"api_key":"live-key","db_password":"s3cr3t"}' | \
//	  gcloud secrets create keel-test --data-file=-
//	KEEL_GCP_SECRET=projects/<project>/secrets/keel-test \
//	  GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
//	  go test ./adapters -run TestGcpLiveReadThroughAdapter

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestGcpLiveReadThroughAdapter(t *testing.T) {
	if os.Getenv(envGCPSecret) == "" {
		t.Skip("KEEL_GCP_SECRET not set; skipping live GCP Secret Manager integration test (no emulator, so it never runs in CI)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Read the secret back through the adapter (it reads KEEL_GCP_* and ADC from the environment).
	// The secret's latest version (or KEEL_GCP_SECRET_VERSION) must already be a JSON object of
	// fields; this test asserts the end-to-end AccessSecretVersion + JSON-object path, not writes.
	p, err := NewGcpSecretManagerSecretProvider(ctx)
	if err != nil {
		t.Fatalf("construct adapter against live GCP Secret Manager: %v", err)
	}
	defer func() { _ = p.Close() }()

	// Fields are deployment-specific; assert the adapter honors the absent-field contract, which
	// does not depend on the secret's contents.
	if _, ok := p.Get("definitely-absent-field"); ok {
		t.Error("an absent field must report ok=false")
	}
}
