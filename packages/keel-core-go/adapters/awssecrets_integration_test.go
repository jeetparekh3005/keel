package adapters

// Live AwsSecretsManagerSecretProvider check against a LocalStack Secrets Manager container
// (ADR-0024). Runs only when KEEL_AWS_SECRET_ID is set (CI starts LocalStack and exports the
// AWS_* + KEEL_AWS_SECRET_ID env); skipped otherwise, matching the OpenBao/NATS/Keycloak
// integration tests' honest gating. It writes a JSON secret with the SDK (the SDK honors
// AWS_ENDPOINT_URL_SECRETS_MANAGER, pointing at LocalStack), then reads each field back
// through the adapter, proving the end-to-end GetSecretValue + JSON-object path.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	smtypes "github.com/aws/aws-sdk-go-v2/service/secretsmanager/types"
)

func TestAwsLiveReadThroughAdapter(t *testing.T) {
	secretID := os.Getenv(envAWSSecretID)
	if secretID == "" {
		t.Skip("KEEL_AWS_SECRET_ID not set; skipping live AWS Secrets Manager integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		t.Fatalf("load AWS SDK config: %v", err)
	}
	client := secretsmanager.NewFromConfig(cfg)

	want := map[string]string{
		"api_key":     "live-integration-key",
		"db_password": "s3cr3t-p@ss",
	}
	body, _ := json.Marshal(want)

	// Create the fixture secret, or overwrite its value if a prior run already created it.
	_, err = client.CreateSecret(ctx, &secretsmanager.CreateSecretInput{
		Name:         aws.String(secretID),
		SecretString: aws.String(string(body)),
	})
	if err != nil {
		var exists *smtypes.ResourceExistsException
		if !errors.As(err, &exists) {
			t.Fatalf("create fixture secret %s: %v", secretID, err)
		}
		if _, err := client.PutSecretValue(ctx, &secretsmanager.PutSecretValueInput{
			SecretId:     aws.String(secretID),
			SecretString: aws.String(string(body)),
		}); err != nil {
			t.Fatalf("put fixture secret value %s: %v", secretID, err)
		}
	}

	// Read it back through the adapter (it reads KEEL_AWS_* from the environment).
	p, err := NewAwsSecretsManagerSecretProvider(ctx)
	if err != nil {
		t.Fatalf("construct adapter against live LocalStack: %v", err)
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
