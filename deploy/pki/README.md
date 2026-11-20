# keel OpenBao PKI + cert-manager mTLS certs (ADR-0027)

Short-lived service-to-service **mTLS** certs, **issued from the OpenBao PKI** and **auto-rotated** by
cert-manager. This closes ADR-0007's PKI story: the certs the `mtls_*_credentials` builders consume
are no longer hand-provisioned - they come from the internal CA and renew ahead of expiry with no
human in the loop. See [ADR-0027](../../docs/adr/0027-openbao-pki-mtls-certs.md).

## CA structure

A two-tier CA (the standard posture): a long-lived **root** at `pki/` that signs a shorter-lived
**issuing intermediate** at `pki_int/`. Leaves are issued only by the intermediate, so the root key
is used once and can stay offline in production. The issuing role `keel-service` on `pki_int/`:

- `allowed_domains = svc, svc.cluster.local, cluster.local` with `allow_subdomains` - covers the
  in-cluster service DNS names (e.g. `reference-service.default.svc.cluster.local`);
- **short** `ttl`/`max_ttl` (72h default), no long max - certs expire quickly;
- both `server_auth` **and** `client_auth` EKUs - mTLS is bidirectional.

## Files

| File | What |
|---|---|
| `bootstrap.sh` | Enables the PKI, builds the root + intermediate, writes the `keel-service` role, and (when `ENABLE_K8S_AUTH=true`) wires the Kubernetes auth method + a **sign-only** policy for cert-manager. POSIX sh; reusable for local dev and the kind CI. Idempotent. |
| `cluster-issuer.yaml` | cert-manager **Vault** `ClusterIssuer` pointed at `pki_int/sign/keel-service`, authenticating via Kubernetes auth (cert-manager's SA token -> OpenBao, **no static token**), plus the RBAC that lets cert-manager mint the SA token. |
| `certificate-test.yaml` | The CI proof `Certificate` (short duration + `renewBefore` that forces a rotation inside the job). |
| `ci/openbao-dev.yaml` | In-cluster OpenBao **dev mode** for the kind CI only (never production). |

## Local dev

The OpenBao dev container is in `deploy/docker-compose.yml`. Bootstrap the PKI (Kubernetes auth is
skipped locally - there is no k8s API):

```sh
# one-shot, opt-in profile:
docker compose --profile pki up openbao-init
# or against an already-running dev OpenBao:
docker compose exec -e ENABLE_K8S_AUTH=false openbao sh /pki/bootstrap.sh
```

## Authentication (no static token)

cert-manager mints a short-lived token for the `keel-cert-manager` ServiceAccount and exchanges it at
OpenBao's Kubernetes auth role for an OpenBao token scoped by the `keel-pki-sign` policy to **only**
the one sign path. With `audiences` omitted on the issuer's `serviceAccountRef`, cert-manager sets the
token audience to `vault://openbao-pki` (the ClusterIssuer name), so the OpenBao role binds exactly
that audience. OpenBao does the TokenReview with its own pod SA (bound to `system:auth-delegator`).

In production, point the ClusterIssuer `server` at the HTTPS OpenBao address and set `caBundle` to the
OpenBao serving CA; the dev/CI OpenBao serves plain HTTP so no `caBundle` is needed.

## CI proof

`.github/workflows/pki.yml` stands up kind + OpenBao + cert-manager, runs `bootstrap.sh`, applies the
ClusterIssuer and test Certificate, and asserts: the cert **chains to the OpenBao CA** with the
expected SANs + both EKUs + a short TTL; a real **mutual-TLS handshake** succeeds; and cert-manager
**auto-rotates** the cert (the Secret's cert serial changes). It fails loudly and dumps cert-manager +
OpenBao state if any assertion does not hold.

## Per-service wiring

The `mtls.*` block in the `keel-service-base` library chart is **opt-in and default-off**: with
`mtls.enabled: false` a chart renders byte-identically (no Certificate, no secret mount). Set
`mtls.enabled: true` to have cert-manager issue a cert into `<release>-<chart>-mtls` and mount it at
`/var/run/secrets/keel/tls`; the existing builders load `tls.crt`/`tls.key`/`ca.crt` - no app change.
