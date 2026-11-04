---
description: Independent Security / Performance / Enterprise review of the current branch
---
Launch **three independent review subagents in parallel** (one message, three Agent calls,
subagent_type general-purpose) against the currently checked-out branch. Each must be
adversarial, cite `file:line`, and severity-rank findings. Do not be charitable.

1. **Security** - authz (deny-by-default actually enforced?), OIDC/JWT, edge hardening
   (headers, body-size/streaming), log redaction families, CI security gates, container,
   secrets, input validation, honesty vs `docs/STATUS.md`.
2. **Performance** - event-loop blocking (auth/JWKS, logging CPU), DB pool + pagination,
   metrics cardinality, span processor, per-request allocations.
3. **Enterprise/standards** - hexagonal purity, observability completeness (metrics + port
   coverage), lifecycle/graceful shutdown, integration testing + coverage, CI/CD maturity,
   and where ADRs/`platform.yaml` claim more than the code does.

When all three return, **synthesize one honest verdict**: a severity-ranked, deduped findings
table (note cross-reviewer agreement), explicit over-claims to fix, and a prioritized remediation
list. Then propose (don't auto-run) the fix set.

Scope/notes for this review: $ARGUMENTS
