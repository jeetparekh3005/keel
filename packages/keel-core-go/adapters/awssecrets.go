package adapters

// AwsSecretsManagerSecretProvider is a production SecretProvider backend (ADR-0024): it reads
// one AWS Secrets Manager secret whose SecretString is a JSON object of fields, and serves
// those fields through the shared caching core (secretcache.go) with the same Get semantics,
// coercion, caching, fail-closed, and no-leak behavior as the OpenBao backend. Unlike OpenBao
// it carries no token-lease logic: the AWS SDK refreshes SigV4 credentials internally and
// resolves the default provider chain (env, IRSA, instance profile, SSO), so the loader just
// calls GetSecretValue each TTL. The SDK honors AWS_ENDPOINT_URL_SECRETS_MANAGER natively
// (LocalStack), so there is no custom-endpoint config knob.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	smtypes "github.com/aws/aws-sdk-go-v2/service/secretsmanager/types"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

const (
	// Config env vars (ADR-0024 Protocol table).
	envAWSSecretID = "KEEL_AWS_SECRET_ID" // gates the backend; a secret name or ARN.
	envAWSRegion   = "KEEL_AWS_REGION"    // optional; else the SDK's region resolution.
)

// secretsManagerAPI is the single Secrets Manager call the loader makes, as an interface so a
// unit test can inject a stub client with no network (ADR-0024 testing).
type secretsManagerAPI interface {
	GetSecretValue(ctx context.Context, params *secretsmanager.GetSecretValueInput, optFns ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error)
}

// AwsSecretsManagerSecretProvider loads one Secrets Manager secret into the embedded caching
// core, which promotes Get and Close. The zero value is not usable; construct with
// NewAwsSecretsManagerSecretProvider.
type AwsSecretsManagerSecretProvider struct {
	*cachingSecretProvider

	client   secretsManagerAPI
	secretID string
}

var (
	_ ports.SecretProvider = (*AwsSecretsManagerSecretProvider)(nil)
	_ io.Closer            = (*AwsSecretsManagerSecretProvider)(nil)
	_ secretLoader         = (*AwsSecretsManagerSecretProvider)(nil)
)

// NewAwsSecretsManagerSecretProvider constructs the provider from the KEEL_AWS_* environment,
// builds a Secrets Manager client from the default credential chain, and eagerly loads the
// field map. It fails loudly (ADR-0024 fail-closed) when KEEL_AWS_SECRET_ID is unset, when SDK
// config cannot be resolved, or when the first load fails (auth, permissions, a non-object
// payload). On success it starts a background refresh goroutine stopped by Close().
func NewAwsSecretsManagerSecretProvider(ctx context.Context) (*AwsSecretsManagerSecretProvider, error) {
	secretID := strings.TrimSpace(os.Getenv(envAWSSecretID))
	if secretID == "" {
		return nil, fmt.Errorf("%s is not set", envAWSSecretID)
	}

	ttl, err := parseCacheTTL()
	if err != nil {
		return nil, err
	}

	// Bound every Secrets Manager call: a ~10s per-request HTTP timeout plus a hard retry cap so
	// a wedged or unreachable endpoint cannot hang the eager startup load (ADR-0023 hard-timeout
	// rule), mirroring the OpenBao adapter's 15s HTTP client. The HTTP timeout bounds a stuck
	// connection even when the caller's ctx has no deadline.
	opts := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRetryMaxAttempts(2),
		awsconfig.WithHTTPClient(awshttp.NewBuildableClient().WithTimeout(10 * time.Second)),
	}
	if region := strings.TrimSpace(os.Getenv(envAWSRegion)); region != "" {
		opts = append(opts, awsconfig.WithRegion(region))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("load AWS SDK config: %w", err)
	}

	return newAwsSecretsManagerProvider(ctx, secretsmanager.NewFromConfig(cfg), secretID, ttl)
}

// newAwsSecretsManagerProvider wires a provider over an already-built client. It is the seam
// the unit tests use to inject a stub client; production goes through
// NewAwsSecretsManagerSecretProvider.
func newAwsSecretsManagerProvider(ctx context.Context, client secretsManagerAPI, secretID string, ttl time.Duration) (*AwsSecretsManagerSecretProvider, error) {
	p := &AwsSecretsManagerSecretProvider{client: client, secretID: secretID}
	core, err := newCachingSecretProvider(ctx, p, ttl)
	if err != nil {
		return nil, err
	}
	p.cachingSecretProvider = core
	return p, nil
}

// name identifies the backend in refresh-failure logs (secretLoader).
func (p *AwsSecretsManagerSecretProvider) name() string { return "aws-secrets-manager" }

// load calls GetSecretValue and parses SecretString as a JSON object of fields (ADR-0024). A
// ResourceNotFoundException yields an empty map (every field absent, mirroring Vault's 404). A
// SecretBinary-only secret or a non-object SecretString fails loudly - a secret meant to back
// Get(name) must be a JSON object of fields. The error wraps the SDK error and the secret ID,
// never the secret value, so a refresh-failure log cannot leak it (secretcache.go).
func (p *AwsSecretsManagerSecretProvider) load(ctx context.Context) (map[string]string, error) {
	out, err := p.client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId: aws.String(p.secretID),
	})
	if err != nil {
		var notFound *smtypes.ResourceNotFoundException
		if errors.As(err, &notFound) {
			return map[string]string{}, nil
		}
		return nil, fmt.Errorf("aws secretsmanager GetSecretValue %s: %w", p.secretID, err)
	}

	if out.SecretString == nil {
		return nil, fmt.Errorf("aws secret %s has no SecretString: SecretBinary-only secrets are unsupported; store a JSON object of fields", p.secretID)
	}

	fields, err := coerceObjectFields([]byte(*out.SecretString))
	if err != nil {
		// Deliberately drop the decoder error: a malformed SecretString can embed the secret
		// value, and encoding/json echoes payload bytes into its messages, which would reach a
		// refresh-failure log. Report only the secret id, matching the other backends' no-leak
		// contract (ADR-0024).
		return nil, fmt.Errorf("aws secret %s is not a JSON object of fields", p.secretID)
	}
	return fields, nil
}
