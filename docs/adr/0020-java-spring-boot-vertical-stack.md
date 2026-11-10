# ADR-0020: Java/Spring Boot vertical stack

- Status: accepted
- Date: 2026-11-11
- Deciders: platform team
- Supersedes: none

## Context

keel ships one cross-language contract (`platform.yaml`) implemented by per-language
verticals: Python (v0.1), Rust (v0.3), Go and TypeScript/NestJS (v0.4). This ADR records the
stack for the **Java vertical**, the last of the v0.4 backend verticals.

The Java ecosystem's golden path is unambiguously **Spring Boot**: it is what the large
majority of Java backend teams run, and a golden-path bootstrapper should reflect the path
teams actually take. It also maps cleanly onto the contract, often with a framework-native
feature where the stdlib-first verticals hand-rolled one:

- RFC 9457 is built in (`ProblemDetail`, Spring 6+).
- OIDC/JWT is `spring-security-oauth2-resource-server`, whose `NimbusJwtDecoder` fetches,
  caches, and refreshes the JWKS natively (the same rotation-tolerance that picked go-oidc and
  jose) and whose `anyRequest().authenticated()` is deny-by-default by construction.
- Micrometer Tracing auto-populates `traceId`/`spanId` into the logging MDC, so per-line
  log-to-trace correlation is automatic.

## Decision

Build `packages/keel-core-java` (artifact `keel-core`) + a thin
`services/reference-service-java` (artifact `reference-service`), in a **Maven multi-module
reactor** rooted at a repo-root aggregator `pom.xml` (the JVM analog of `go.work` / the pnpm
workspace). keel-core ships its cross-cutting behavior as a Spring Boot **auto-configuration**,
so the service just declares the dependency and is wired (batteries-included, ADR-0009 Tier 1).

### Stack

| Concern | Choice | Why |
|---------|--------|-----|
| Language | **Java 25 (LTS)** | Latest LTS. Not JDK 27 (a non-LTS interim release Spring Boot has not validated): the repo tracks the latest stable the ecosystem supports, as with TS 5.9 over 7.x (ADR-0019). |
| Framework | **Spring Boot 4.1.2** (Spring Framework 7, Security 7) | The Java golden path. Latest GA (4.2 is only RC). |
| Build | **Maven** (multi-module reactor) | The most ubiquitous JVM build; a repo-root aggregator ties the two modules. |
| Config | **`@ConfigurationProperties(prefix="keel")`** record + `@Validated` | Typed, fail-fast binding. Spring's relaxed binding maps the same `KEEL_*` env vars the other verticals use (e.g. `KEEL_OIDC_JWKS_URI` -> `keel.oidc-jwks-uri`). |
| Errors | **`ProblemDetail`** (built-in) + `@RestControllerAdvice` | RFC 9457 native; a `DomainException` maps to its category, 5xx detail scrubbed. |
| Logging | **Spring Boot structured logging** (JSON) + a `StructuredLoggingJsonMembersCustomizer` | Built-in JSON sink; the customizer applies the same family-based key redaction + value scrubbing (ReDoS-safe) as the other verticals. MDC carries `traceId`/`spanId`. |
| Tracing | **Micrometer Tracing + OTLP exporter** | Auto-configured; `management.otlp.tracing.endpoint` bound from `KEEL_OTLP_ENDPOINT`. Log correlation is automatic via the MDC. |
| Auth | **Spring Security OAuth2 Resource Server** (`NimbusJwtDecoder`, JWKS) | Native JWKS refresh; `anyRequest().authenticated()` is deny-by-default; scope authorities via `@PreAuthorize`. A custom converter accepts the Entra `scp`-as-string form. |
| Persistence | **`JdbcClient`** (Spring 6.1+) + PostgreSQL + HikariCP | A thin SQL executor that maps rows to domain types, matching "ship the plumbing, not a generic repository / ORM" (ADR-0009). Hikari fails fast at startup. `@Transactional` is the unit of work. |
| Validation | **Jakarta Bean Validation** (`spring-boot-starter-validation`) | The Java-idiomatic request validator (the contrast to zod/struct-tags). |
| Tests | **JUnit 5 + Spring Boot Test** + a JDK-`HttpClient` conformance suite | The conformance assertions drive the real running server (`@SpringBootTest(RANDOM_PORT)`) over `java.net.http.HttpClient`, so they stay framework-neutral like the Go/TS suites. Postgres CRUD gated on `KEEL_TEST_DATABASE_URL`. |
| Dep CVE gate | **Trivy** (filesystem scan of the built artifacts) | The blocking dependency-CVE gate, analogous to govulncheck/pip-audit/pnpm-audit. Trivy reads the Spring Boot fat jar's bundled dependencies. |
| Layering | **ArchUnit** test | Enforces hexagonal boundaries (domain pure, adapters depend inward), the Java analog of Python's import-linter. |

## Consequences

- A fifth vertical reuses the same contract and conformance assertions, now proven against the
  dominant enterprise JVM framework, where several contract requirements are framework-native.
- Rust/Go/TS follow-ups are built in from the start: native JWKS refresh, Entra `scp`-string,
  per-line log-to-trace correlation, ReDoS-safe scrubbers (Java regex can backtrack), and
  server-fault detail scrubbing.
- A guardrail this vertical adds that the repo should later backfill elsewhere: an
  **ArchUnit** layering test (Python has import-linter; the others rely on package structure).
  **JaCoCo** coverage is reported; a hard floor needs cross-module report-aggregation (the
  web/auth classes in keel-core are exercised by the service's test) and is a tracked follow-up.
- Not at parity initially (tracked follow-ups, same as Go/TS): HTTP request **metrics** beyond
  Micrometer's defaults and a live **Keycloak** JWKS integration test.
