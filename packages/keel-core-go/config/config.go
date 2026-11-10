// Package config loads typed, KEEL_-prefixed, 12-factor configuration (platform.yaml
// config: typed, fail-fast). Fields are populated from KEEL_-prefixed environment
// variables per their `env` struct tags; invalid or missing required config fails fast.
// Secret access is a separate concern (a SecretProvider port, later slice); config loads
// only the non-secret typed values.
package config

import (
	"github.com/caarlos0/env/v11"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

// Load parses the environment into T, which must be a struct. A missing required field or
// a type error fails fast with an Internal DomainError (the detail is server-side only).
func Load[T any]() (T, error) {
	var cfg T
	if err := env.ParseWithOptions(&cfg, env.Options{Prefix: "KEEL_"}); err != nil {
		return cfg, domain.New(domain.Internal, "config: "+err.Error())
	}
	return cfg, nil
}
