// Package keelcore is the shared platform library for the Go vertical (ADR-0009,
// ADR-0018): ports, cross-cutting adapters, and a test kit that satisfy the
// language-agnostic contract in platform.yaml, under the same hexagonal boundaries
// (ADR-0002) as the Python and Rust verticals.
//
// This is the foundation scaffold; later slices add config, the error taxonomy,
// structured logging with redaction, telemetry, the HTTP edge, OIDC/JWT auth,
// persistence, and the behavioral conformance suite.
package keelcore

// ContractVersion is the platform contractVersion this vertical targets
// (platform.yaml metadata.contractVersion). A generated project records the version
// it targets.
const ContractVersion = "0.2.0"
