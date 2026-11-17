package adapters

// Unit tests for the AWS Secrets Manager SecretProvider adapter (ADR-0024), driven through a
// stub secretsManagerAPI so there is no network and no credentials. They cover the field-map
// round-trip and coercion, not-found-as-empty, the fail-closed cases (SecretBinary-only and a
// non-object SecretString), and the no-leak invariant (a failed refresh logs a warning that
// contains neither the secret value nor a credential).

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	smtypes "github.com/aws/aws-sdk-go-v2/service/secretsmanager/types"
)

// stubSecretsManager is a secretsManagerAPI whose behavior each test sets via get.
type stubSecretsManager struct {
	get func(ctx context.Context, in *secretsmanager.GetSecretValueInput) (*secretsmanager.GetSecretValueOutput, error)
}

func (s *stubSecretsManager) GetSecretValue(ctx context.Context, in *secretsmanager.GetSecretValueInput, _ ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error) {
	return s.get(ctx, in)
}

// secretStringOutput returns a GetSecretValue output carrying body as SecretString.
func secretStringOutput(body string) *secretsmanager.GetSecretValueOutput {
	return &secretsmanager.GetSecretValueOutput{SecretString: aws.String(body)}
}

func TestAwsFieldMapRoundTripAndCoercion(t *testing.T) {
	clearVaultEnv(t)

	var gotSecretID string
	stub := &stubSecretsManager{get: func(_ context.Context, in *secretsmanager.GetSecretValueInput) (*secretsmanager.GetSecretValueOutput, error) {
		gotSecretID = aws.ToString(in.SecretId)
		// A string round-trips exactly, a number keeps its JSON text, booleans become
		// "true"/"false"; object/array/null are non-scalar and must be absent (ADR-0023).
		return secretStringOutput(`{
			"api_key": "abc123",
			"db_password": "p@ss",
			"replicas": 3,
			"ratio": 1.5,
			"enabled": true,
			"disabled": false,
			"obj": {"nested": 1},
			"arr": [1, 2, 3],
			"empty": null
		}`), nil
	}}

	p, err := newAwsSecretsManagerProvider(context.Background(), stub, "keel-test", time.Hour)
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	if gotSecretID != "keel-test" {
		t.Errorf("GetSecretValue SecretId = %q; want keel-test", gotSecretID)
	}
	for _, tc := range []struct{ key, want string }{
		{"api_key", "abc123"},
		{"db_password", "p@ss"},
		{"replicas", "3"},
		{"ratio", "1.5"},
		{"enabled", "true"},
		{"disabled", "false"},
	} {
		if v, ok := p.Get(tc.key); !ok || v != tc.want {
			t.Errorf("Get(%s) = %q,%v; want %q,true", tc.key, v, ok, tc.want)
		}
	}
	for _, key := range []string{"obj", "arr", "empty", "absent"} {
		if v, ok := p.Get(key); ok {
			t.Errorf("Get(%s) = %q,%v; want absent (ok=false)", key, v, ok)
		}
	}
}

func TestAwsNotFoundIsEmptyNotError(t *testing.T) {
	clearVaultEnv(t)

	stub := &stubSecretsManager{get: func(context.Context, *secretsmanager.GetSecretValueInput) (*secretsmanager.GetSecretValueOutput, error) {
		// Mirrors Vault's 404-as-empty: a missing secret is "every field absent", not an error.
		return nil, &smtypes.ResourceNotFoundException{}
	}}

	p, err := newAwsSecretsManagerProvider(context.Background(), stub, "missing", time.Hour)
	if err != nil {
		t.Fatalf("ResourceNotFoundException must construct (empty field map), got error: %v", err)
	}
	defer func() { _ = p.Close() }()

	if _, ok := p.Get("api_key"); ok {
		t.Error("every field must be absent when the secret is not found")
	}
}

func TestAwsSecretBinaryOnlyFailsClosed(t *testing.T) {
	clearVaultEnv(t)

	stub := &stubSecretsManager{get: func(context.Context, *secretsmanager.GetSecretValueInput) (*secretsmanager.GetSecretValueOutput, error) {
		// A SecretBinary-only secret (no SecretString) cannot back Get(name): fail loudly.
		return &secretsmanager.GetSecretValueOutput{SecretBinary: []byte{0x01, 0x02, 0x03}}, nil
	}}

	if _, err := newAwsSecretsManagerProvider(context.Background(), stub, "binary", time.Hour); err == nil {
		t.Error("a SecretBinary-only secret must fail construction, not fall through to empty")
	}
}

func TestAwsNonObjectPayloadFailsClosed(t *testing.T) {
	clearVaultEnv(t)

	for name, body := range map[string]string{
		"bare string": `"just-a-string"`,
		"array":       `["a", "b"]`,
		"number":      `42`,
		"null":        `null`,
		"malformed":   `{not json`,
	} {
		t.Run(name, func(t *testing.T) {
			stub := &stubSecretsManager{get: func(context.Context, *secretsmanager.GetSecretValueInput) (*secretsmanager.GetSecretValueOutput, error) {
				return secretStringOutput(body), nil
			}}
			if _, err := newAwsSecretsManagerProvider(context.Background(), stub, "bad", time.Hour); err == nil {
				t.Errorf("a non-object SecretString (%s) must fail construction", name)
			}
		})
	}
}

func TestAwsRefreshFailureServesLastGoodWithoutLeaking(t *testing.T) {
	clearVaultEnv(t)

	const (
		secretValue = "sekret-value-must-not-be-logged"
		secretID    = "keel-prod/app-arn-must-not-leak-a-value"
	)

	var fail atomic.Bool
	stub := &stubSecretsManager{get: func(context.Context, *secretsmanager.GetSecretValueInput) (*secretsmanager.GetSecretValueOutput, error) {
		if fail.Load() {
			// A refresh-time failure that does NOT carry the secret value, as a real transport
			// or permission error would not. The no-leak invariant is that neither the cached
			// value nor a credential reaches the log.
			return nil, errors.New("service unavailable")
		}
		return secretStringOutput(`{"api_key": "` + secretValue + `"}`), nil
	}}

	p, err := newAwsSecretsManagerProvider(context.Background(), stub, secretID, time.Second)
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	// Capture slog only after a clean construction, so the buffer holds the refresh-failure
	// warning. It is read after Close, when the refresh goroutine has exited (no data race).
	var buf bytes.Buffer
	prev := slog.Default()
	defer slog.SetDefault(prev)
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))

	fail.Store(true)
	time.Sleep(1500 * time.Millisecond)
	_ = p.Close()

	logged := buf.String()
	if !strings.Contains(logged, "refresh failed") {
		t.Fatalf("expected a refresh-failure warning in the logs; got %q", logged)
	}
	if strings.Contains(logged, secretValue) {
		t.Errorf("the cached secret value leaked into the logs: %q", logged)
	}
	// The cache must still serve the last good value after the failed refresh.
	if v, ok := p.Get("api_key"); !ok || v != secretValue {
		t.Errorf("Get(api_key) = %q,%v after a failed refresh; want the last good value", v, ok)
	}
}

func TestAwsMissingSecretIDFailsConstruction(t *testing.T) {
	clearVaultEnv(t) // KEEL_AWS_SECRET_ID blank
	if _, err := NewAwsSecretsManagerSecretProvider(context.Background()); err == nil {
		t.Error("KEEL_AWS_SECRET_ID unset must fail construction")
	}
}
