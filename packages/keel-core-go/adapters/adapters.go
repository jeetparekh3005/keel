// Package adapters provides the production implementations of the driven ports: a system
// clock and an environment-backed secret provider.
package adapters

import (
	"os"
	"time"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// SystemClock is the real wall clock.
type SystemClock struct{}

// Now returns the current time.
func (SystemClock) Now() time.Time { return time.Now() }

// EnvSecretProvider reads secrets from environment variables (the dev adapter; production
// uses a real secret manager, ADR-0007).
type EnvSecretProvider struct{}

// Get returns the environment variable key, and whether it was set and non-empty.
func (EnvSecretProvider) Get(key string) (string, bool) {
	return os.LookupEnv(key)
}

var (
	_ ports.Clock          = SystemClock{}
	_ ports.SecretProvider = EnvSecretProvider{}
)
