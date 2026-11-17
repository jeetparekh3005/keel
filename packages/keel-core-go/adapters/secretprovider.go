package adapters

// SecretProvider selection (ADR-0024 decision 5). The composition root picks exactly one
// backend from the environment: OpenBao when KEEL_VAULT_ADDR is set, AWS Secrets Manager when
// KEEL_AWS_SECRET_ID is set, and the EnvSecretProvider when neither is. Setting more than one
// gating var is an ambiguous misconfiguration that fails construction rather than silently
// choosing one. Any misconfiguration of the selected backend fails closed (it never falls
// back to the environment). GCP (KEEL_GCP_SECRET) is a later wave (ADR-0024 rollout).

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// SecretProviderFromEnv is the composition-root factory. The returned provider may be an
// io.Closer (the OpenBao and AWS backends are); callers that manage lifecycle should
// type-assert and Close it on shutdown.
func SecretProviderFromEnv(ctx context.Context) (ports.SecretProvider, error) {
	vault := strings.TrimSpace(os.Getenv(envAddr)) != ""
	aws := strings.TrimSpace(os.Getenv(envAWSSecretID)) != ""

	switch {
	case vault && aws:
		return nil, fmt.Errorf("multiple secret backends configured: set at most one of %s, %s", envAddr, envAWSSecretID)
	case vault:
		return NewOpenBaoSecretProvider(ctx)
	case aws:
		return NewAwsSecretsManagerSecretProvider(ctx)
	default:
		return EnvSecretProvider{}, nil
	}
}
