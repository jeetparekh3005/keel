package adapters

// SecretProvider selection (ADR-0024 decision 5). The composition root picks exactly one
// backend from the environment: OpenBao when KEEL_VAULT_ADDR is set, AWS Secrets Manager when
// KEEL_AWS_SECRET_ID is set, GCP Secret Manager when KEEL_GCP_SECRET is set, and the
// EnvSecretProvider when none is. Setting more than one gating var is an ambiguous
// misconfiguration that fails construction rather than silently choosing one. Any
// misconfiguration of the selected backend fails closed (it never falls back to the environment).

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
	gcp := strings.TrimSpace(os.Getenv(envGCPSecret)) != ""

	if countTrue(vault, aws, gcp) > 1 {
		return nil, fmt.Errorf("multiple secret backends configured: set at most one of %s, %s, %s", envAddr, envAWSSecretID, envGCPSecret)
	}

	switch {
	case vault:
		return NewOpenBaoSecretProvider(ctx)
	case aws:
		return NewAwsSecretsManagerSecretProvider(ctx)
	case gcp:
		return NewGcpSecretManagerSecretProvider(ctx)
	default:
		return EnvSecretProvider{}, nil
	}
}

// countTrue counts the set gating vars, so "more than one backend configured" is a single clear
// check rather than a growing matrix of pairwise conditions (ADR-0024 decision 5).
func countTrue(flags ...bool) int {
	n := 0
	for _, f := range flags {
		if f {
			n++
		}
	}
	return n
}
