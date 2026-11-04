# 0006. Identity and access management

- **Status:** accepted
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

keel needs an enterprise-grade, open-source identity story that supports multiple credential types - **API keys, JWT, OAuth2/OIDC** (and optionally mTLS) - with a clear, zero-trust boundary between edge authentication and in-service authorization.

## Decision drivers

- Enterprise auth breadth without vendor lock-in or a paid tier.
- A single, language-agnostic verification abstraction (the `Authenticator` port).
- Defense in depth: the gateway must not be the only thing enforcing access.

## Considered options

| Option | OIDC/OAuth2 | SAML | Self-host OSS | Admin UI | License |
|---|---|---|---|---|---|
| **Keycloak** | Yes | Yes | Yes | Full | Apache-2.0 |
| Authentik | Yes | Yes | Yes | Full | MIT (some enterprise features) |
| Ory (Hydra/Kratos) | Yes | No (Hydra) | Yes | Minimal (API-first) | Apache-2.0 |
| Auth0 / Cognito / Entra | Yes | Yes | No (SaaS) | Full | Proprietary |

## Decision outcome

**Keycloak is the default identity provider; the `Authenticator` port abstracts credential verification; authorization is enforced in the service, deny-by-default.**

### Credential types (coexist behind one port)

- **OAuth2/OIDC + JWT** - user-facing and delegated auth via Keycloak. Authorization Code + PKCE for apps; Client Credentials for service-to-service. Access tokens are short-lived JWTs validated against JWKS.
- **API keys** - machine/partner clients and simple integrations. Validated at the gateway (`key-auth`), mapped to a principal with scopes. Stored hashed; rotatable.
- **mTLS** (optional) - service-to-service, certificates issued by OpenBao PKI ([ADR-0007](0007-secrets-and-pki.md)).

### Authentication vs authorization boundary

- **Gateway (coarse authn):** validate JWT signature/expiry, resolve API keys, run OIDC; inject verified identity. See [ADR-0005](0005-api-gateway.md).
- **Service (authz):** re-verify the token and enforce **fine-grained, deny-by-default** access - RBAC via token scopes/roles, with ABAC/policy via OPA or Keycloak Authorization Services (UMA) where resource-level rules are needed.
- **Rule:** never rely solely on the gateway for authorization (zero-trust).

### Token handling

- Short-lived access tokens + refresh; JWKS rotation honored.
- No tokens or secrets in logs (enforced by the logging redaction contract).

### Consequences

- Good: one port, many credential types; enterprise auth fully OSS.
- Good: compromise of the edge does not bypass service authorization.
- Bad: running Keycloak is an operational component; mitigated by shipping it in the dev compose stack and a Helm chart.
- Neutral: fine-grained policy (OPA/UMA) is opt-in per service.

> **Implementation status (v0.1):** JWT authentication **and** scope/role authorization
> (`require_scopes`/`require_roles`, 403 on insufficient scope) are implemented. The
> `api_key` and `mTLS` credential types remain **planned** - see [docs/STATUS.md](../STATUS.md).

## Enforcement

- **semgrep (keel ruleset):** every HTTP/gRPC route must declare the auth dependency - routes without it fail CI, making deny-by-default mechanical. Any auth-bypass flag or unauthenticated handler is flagged.
- **Protected use cases** must carry a scope/role check (same ruleset).
- Token/secret values are kept out of logs by the logging redaction contract (see [ADR-0010](0010-enforcement-strategy.md)).

## More information

- Realizes the `auth` section of [`platform.yaml`](../../platform.yaml).
- Default adapter: Keycloak; swaps include Auth0, Cognito, Entra behind the same port.
