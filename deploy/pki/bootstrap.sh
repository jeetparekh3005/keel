#!/bin/sh
# Bootstrap the OpenBao PKI that issues keel's short-lived mTLS certs (ADR-0027).
#
# Stands up a two-tier CA (an offline-style root plus a short-lived issuing
# intermediate), a `keel-service` issuing role scoped to the in-cluster service
# DNS names, and - for Kubernetes - the k8s auth method bound to cert-manager's
# ServiceAccount via a policy that can ONLY use the one sign path. No static
# OpenBao token ever lands in the cluster: cert-manager exchanges its SA token
# for a short-lived OpenBao token (ADR-0007 PKI).
#
# Reusable for both local dev (the compose OpenBao dev container) and the kind CI
# job. It talks to OpenBao over $BAO_ADDR with $BAO_TOKEN; the Kubernetes wiring
# is opt-in via ENABLE_K8S_AUTH=true. POSIX sh so it runs in the Alpine OpenBao
# image and on a CI runner alike.
#
# Usage (local dev, no k8s):
#   BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN=root sh deploy/pki/bootstrap.sh
# Usage (CI / cluster, with k8s auth for cert-manager):
#   BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN=root ENABLE_K8S_AUTH=true \
#     sh deploy/pki/bootstrap.sh
set -eu

# ---- configuration (override via env) --------------------------------------
BAO_ADDR="${BAO_ADDR:-http://127.0.0.1:8200}"
BAO_TOKEN="${BAO_TOKEN:-root}"

PKI_ROOT_PATH="${PKI_ROOT_PATH:-pki}"
PKI_INT_PATH="${PKI_INT_PATH:-pki_int}"
ROLE_NAME="${ROLE_NAME:-keel-service}"

# Short-lived leaves. Role ttl/max_ttl bound how long an issued mTLS cert lives;
# cert-manager renews well before this (ADR-0027). No long max_ttl by design.
ROLE_TTL="${ROLE_TTL:-72h}"
ROLE_MAX_TTL="${ROLE_MAX_TTL:-72h}"

# In-cluster DNS the role may issue for. allow_subdomains lets a leaf CN/SAN be an
# arbitrary-depth subdomain (e.g. reference-service.default.svc.cluster.local).
ROLE_ALLOWED_DOMAINS="${ROLE_ALLOWED_DOMAINS:-svc,svc.cluster.local,cluster.local}"

# Kubernetes auth wiring (opt-in). The audience MUST equal the cert-manager issuer
# identity: with `audiences` omitted on the ClusterIssuer's serviceAccountRef,
# cert-manager mints the SA token with audience "vault://<clusterissuer-name>",
# so the OpenBao role must bind exactly that audience or TokenReview rejects it.
ENABLE_K8S_AUTH="${ENABLE_K8S_AUTH:-false}"
K8S_AUTH_PATH="${K8S_AUTH_PATH:-kubernetes}"
K8S_HOST="${K8S_HOST:-https://kubernetes.default.svc}"
CM_SA_NAME="${CM_SA_NAME:-keel-cert-manager}"
CM_SA_NAMESPACE="${CM_SA_NAMESPACE:-cert-manager}"
BAO_K8S_ROLE="${BAO_K8S_ROLE:-keel-cert-manager}"
ISSUER_AUDIENCE="${ISSUER_AUDIENCE:-vault://openbao-pki}"
SIGN_POLICY="${SIGN_POLICY:-keel-pki-sign}"

export BAO_ADDR BAO_TOKEN
# OpenBao's CLI honours VAULT_* too; export both so the script works with either
# the `bao` or a `vault` binary name.
VAULT_ADDR="$BAO_ADDR"
VAULT_TOKEN="$BAO_TOKEN"
export VAULT_ADDR VAULT_TOKEN

# Resolve the CLI: prefer `bao`, fall back to `vault` (OpenBao is Vault-API-compatible).
if command -v bao >/dev/null 2>&1; then
  BAO="bao"
elif command -v vault >/dev/null 2>&1; then
  BAO="vault"
else
  echo "ERROR: neither 'bao' nor 'vault' CLI found on PATH" >&2
  exit 1
fi

log() { echo ">>> $*"; }

# Is a secrets/auth mount already enabled at <path>/ ?
mount_enabled() {
  "$BAO" secrets list -format=json 2>/dev/null | grep -q "\"$1/\":" || return 1
}
auth_enabled() {
  "$BAO" auth list -format=json 2>/dev/null | grep -q "\"$1/\":" || return 1
}

# ---- 0. reachability --------------------------------------------------------
log "OpenBao address: $BAO_ADDR"
if ! "$BAO" status >/dev/null 2>&1; then
  # `status` exits non-zero when sealed; a dev server is unsealed, so a hard
  # failure here means we cannot reach OpenBao at all.
  if ! "$BAO" status 2>&1 | grep -qi "sealed"; then
    echo "ERROR: cannot reach OpenBao at $BAO_ADDR" >&2
    "$BAO" status || true
    exit 1
  fi
fi

# ---- 1. root CA -------------------------------------------------------------
if mount_enabled "$PKI_ROOT_PATH"; then
  log "root PKI already mounted at $PKI_ROOT_PATH/"
else
  log "enabling root PKI at $PKI_ROOT_PATH/"
  "$BAO" secrets enable -path="$PKI_ROOT_PATH" pki
fi
"$BAO" secrets tune -max-lease-ttl=87600h "$PKI_ROOT_PATH" >/dev/null

if [ -n "$("$BAO" read -field=certificate "$PKI_ROOT_PATH/cert/ca" 2>/dev/null || true)" ]; then
  log "root CA certificate already present"
else
  log "generating root CA"
  "$BAO" write -field=certificate "$PKI_ROOT_PATH/root/generate/internal" \
    common_name="keel internal Root CA" \
    issuer_name="keel-root" \
    key_type="ec" key_bits=256 \
    ttl=87600h >/dev/null
fi
"$BAO" write "$PKI_ROOT_PATH/config/urls" \
  issuing_certificates="$BAO_ADDR/v1/$PKI_ROOT_PATH/ca" \
  crl_distribution_points="$BAO_ADDR/v1/$PKI_ROOT_PATH/crl" >/dev/null

# ---- 2. issuing intermediate CA --------------------------------------------
if mount_enabled "$PKI_INT_PATH"; then
  log "intermediate PKI already mounted at $PKI_INT_PATH/"
else
  log "enabling intermediate PKI at $PKI_INT_PATH/"
  "$BAO" secrets enable -path="$PKI_INT_PATH" pki
fi
"$BAO" secrets tune -max-lease-ttl=43800h "$PKI_INT_PATH" >/dev/null

# Only (re)generate + sign the intermediate if it has no signed CA yet, so the
# script is idempotent (re-running against an already-bootstrapped OpenBao is a
# no-op rather than minting a second intermediate).
if [ -n "$("$BAO" read -field=certificate "$PKI_INT_PATH/cert/ca" 2>/dev/null || true)" ]; then
  log "intermediate CA already signed"
else
  log "generating intermediate CSR"
  csr="$("$BAO" write -field=csr "$PKI_INT_PATH/intermediate/generate/internal" \
    common_name="keel Issuing CA" \
    key_type="ec" key_bits=256)"
  log "signing intermediate with the root CA"
  int_cert="$(printf '%s' "$csr" | "$BAO" write -field=certificate \
    "$PKI_ROOT_PATH/root/sign-intermediate" \
    issuer_ref="keel-root" \
    csr=- \
    format=pem_bundle \
    ttl=43800h)"
  log "importing the signed intermediate"
  printf '%s' "$int_cert" | "$BAO" write "$PKI_INT_PATH/intermediate/set-signed" \
    certificate=- >/dev/null
fi
"$BAO" write "$PKI_INT_PATH/config/urls" \
  issuing_certificates="$BAO_ADDR/v1/$PKI_INT_PATH/ca" \
  crl_distribution_points="$BAO_ADDR/v1/$PKI_INT_PATH/crl" >/dev/null

# ---- 3. issuing role --------------------------------------------------------
# mTLS is bidirectional, so both server_auth and client_auth EKUs. Short ttl,
# no long max_ttl. key_type=any because cert-manager presents the CSR's key.
log "writing issuing role $ROLE_NAME on $PKI_INT_PATH/"
"$BAO" write "$PKI_INT_PATH/roles/$ROLE_NAME" \
  allowed_domains="$ROLE_ALLOWED_DOMAINS" \
  allow_subdomains=true \
  allow_glob_domains=true \
  allow_bare_domains=true \
  allow_wildcard_certificates=true \
  allow_ip_sans=false \
  server_flag=true \
  client_flag=true \
  key_usage="DigitalSignature,KeyEncipherment" \
  ext_key_usage="ServerAuth,ClientAuth" \
  key_type="any" \
  require_cn=false \
  ttl="$ROLE_TTL" \
  max_ttl="$ROLE_MAX_TTL" \
  no_store=false >/dev/null

# ---- 4. Kubernetes auth for cert-manager (opt-in) --------------------------
if [ "$ENABLE_K8S_AUTH" != "true" ]; then
  log "ENABLE_K8S_AUTH!=true - skipping Kubernetes auth wiring (local-dev mode)"
  log "PKI bootstrap complete."
  exit 0
fi

log "writing policy $SIGN_POLICY (sign-only on $PKI_INT_PATH/sign/$ROLE_NAME)"
"$BAO" policy write "$SIGN_POLICY" - >/dev/null <<EOF
# cert-manager may ONLY sign CSRs on the one issuing role. No read, no CA
# management, no other path. This is the entire blast radius of a compromised
# cert-manager token.
path "$PKI_INT_PATH/sign/$ROLE_NAME" {
  capabilities = ["create", "update"]
}
EOF

if auth_enabled "$K8S_AUTH_PATH"; then
  log "kubernetes auth already enabled at $K8S_AUTH_PATH/"
else
  log "enabling kubernetes auth at $K8S_AUTH_PATH/"
  "$BAO" auth enable -path="$K8S_AUTH_PATH" kubernetes
fi

# Configure only kubernetes_host: with token_reviewer_jwt and kubernetes_ca_cert
# omitted, OpenBao uses its OWN pod ServiceAccount token (which carries
# system:auth-delegator) as the TokenReview reviewer and the pod's local CA. That
# keeps the reviewer credential inside the OpenBao pod - nothing to pass in here.
log "configuring kubernetes auth (host=$K8S_HOST, local reviewer JWT)"
"$BAO" write "auth/$K8S_AUTH_PATH/config" \
  kubernetes_host="$K8S_HOST" >/dev/null

# Bind cert-manager's SA to the sign-only policy. audience MUST match the token
# cert-manager mints (see ISSUER_AUDIENCE note above). Short token ttl.
log "binding role $BAO_K8S_ROLE -> SA $CM_SA_NAMESPACE/$CM_SA_NAME (audience=$ISSUER_AUDIENCE)"
"$BAO" write "auth/$K8S_AUTH_PATH/role/$BAO_K8S_ROLE" \
  bound_service_account_names="$CM_SA_NAME" \
  bound_service_account_namespaces="$CM_SA_NAMESPACE" \
  audience="$ISSUER_AUDIENCE" \
  token_policies="$SIGN_POLICY" \
  token_ttl=20m \
  token_max_ttl=20m >/dev/null

log "PKI + Kubernetes auth bootstrap complete."
