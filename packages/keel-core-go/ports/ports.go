// Package ports declares the driven-port interfaces the domain depends on (ADR-0002,
// ADR-0009): the small, cross-cutting seams that adapters implement. The authentication
// port lives in package auth.
package ports

import "time"

// Clock is the time seam, so time-dependent logic is testable with a frozen clock.
type Clock interface {
	Now() time.Time
}

// SecretProvider resolves a secret by key (highest-precedence config source). ok is false
// when the key is absent.
type SecretProvider interface {
	Get(key string) (value string, ok bool)
}
