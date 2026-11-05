# 0005. API gateway

- **Status:** accepted; gateway not yet deployed (deployment-time infra). The in-app `RateLimitMiddleware` defense-in-depth landed in v0.2; the APISIX edge itself is a later milestone.
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

Generated services need an edge gateway for TLS termination, routing, rate limiting, and coarse authentication. The gateway must support **API keys, JWT, and OAuth2/OIDC** at enterprise grade, and every one of those must be in the **truly open-source** tier - not behind an enterprise SKU. It must run on Kubernetes and stay swappable.

## Decision drivers

- All of {API key, JWT, OAuth2/OIDC} available in OSS, not paywalled.
- Enterprise-grade: production-proven at scale, maintained, performant.
- Kubernetes-native and compatible with the Kubernetes Gateway API.
- Vendor-neutral governance (no single-vendor open-core lever).

## Considered options

| Gateway | API key | JWT | OIDC | License / OSS posture |
|---|---|---|---|---|
| **Apache APISIX** | Yes | Yes | Yes | Apache-2.0, no auth paywall |
| Kong OSS | Yes | Yes | No (Enterprise-only) | Apache-2.0, OIDC gated |
| Envoy Gateway | Via ext_authz | Yes | Yes | Apache-2.0 (CNCF) |
| Traefik | Via ForwardAuth | Delegated | Via oauth2-proxy | MIT, auth delegated |
| Tyk | Yes | Yes | Yes | Gateway OSS, control-plane proprietary |

## Decision outcome

Chosen option: **Apache APISIX, placed behind the Kubernetes Gateway API.**

- Auth plugins are all OSS: `key-auth`, `jwt-auth`, `openid-connect`, plus `authz-keycloak` and `opa` for fine-grained authorization.
- Apache Foundation governance; production-proven; nginx/LuaJIT performance; k8s ingress controller.
- **Gateway API as the interface** makes the implementation swappable - APISIX is the default, not a lock-in.

Rejected: **Kong OSS** (the OIDC plugin, our primary need, is enterprise-only); **Envoy Gateway** (API-key is DIY via `ext_authz`, younger wrapper) - kept as a documented swap; **Traefik** (auth delegated in OSS); **Tyk** (management plane proprietary).

### Boundary

The gateway performs **coarse authn only** (validate JWT signature/expiry, look up API keys, run OIDC). Services re-verify and enforce **fine-grained, deny-by-default authz** - see [ADR-0006](0006-identity-and-access.md). Never trust the gateway alone.

**Rate limiting** is a gateway responsibility: it is the single shared point in front of all replicas, so limits are coordinated and consistent. keel-core also ships an **opt-in, per-instance** `RateLimitMiddleware` (token bucket, in-memory) for single-instance deployments and local defense-in-depth; it does not coordinate across replicas and is not a substitute for the gateway.

### Consequences

- Good: every required auth method is OSS and first-class.
- Good: Gateway API keeps the gateway swappable.
- Bad: etcd dependency; custom plugins are Lua-first (external plugin-runners/Wasm exist); smaller community than Kong.

## More information

- Validates tokens issued by [ADR-0006](0006-identity-and-access.md); deployed per [ADR-0004](0004-infrastructure-strategy.md).
