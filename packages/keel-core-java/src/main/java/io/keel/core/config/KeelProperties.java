package io.keel.core.config;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Typed, fail-fast configuration bound from the {@code KEEL_*} environment (platform.yaml config:
 * typed, fail-fast). Spring's relaxed binding maps the same env vars the other verticals use:
 * {@code KEEL_OIDC_JWKS_URI} -> {@code keel.oidc-jwks-uri} -> {@code oidcJwksUri}, {@code
 * KEEL_CORS_ALLOW_ORIGINS} (comma-separated) -> a list, etc.
 *
 * <p>Port, log level, service identity, and the OTLP endpoint are bridged to Spring's own
 * properties in application.yml; this record holds what Spring does not model natively.
 *
 * <p>The NATS fields gate the JetStream {@code MessageBus} adapter: it is wired only when {@code
 * KEEL_NATS_URL} ({@code keel.nats-url}) is set, so a service without a broker is unaffected.
 * {@code KEEL_NATS_STREAM} and {@code KEEL_NATS_SUBJECTS} (comma-separated) name the stream and the
 * subjects it captures.
 *
 * <p>The gRPC fields gate the inbound gRPC server (ADR-0022): it is wired only when {@code
 * KEEL_GRPC_PORT} ({@code keel.grpc-port}) is set, so a service without gRPC is unaffected. The TLS
 * PEM fields ({@code KEEL_GRPC_TLS_CERT_PEM}, {@code KEEL_GRPC_TLS_KEY_PEM}, {@code
 * KEEL_GRPC_TLS_CA_PEM}) carry the server leaf cert/key and the client-auth trust anchor; when all
 * three are present the server serves mTLS and requires a client certificate, otherwise it serves
 * plaintext (local/dev). A {@link io.keel.core.ports.SecretProvider} entry under the same key wins
 * over the configured value, so the PEM can come from a secret store rather than the environment.
 * Serving plaintext on an exposed gRPC port is fail-closed: it requires the explicit opt-in {@code
 * KEEL_GRPC_TLS_INSECURE} ({@code keel.grpc-tls-insecure}), false by default, so a production
 * deployment that forgets to supply the PEM triple fails to start rather than binding in the clear.
 *
 * <p>The secret-backend fields select one production {@link io.keel.core.ports.SecretProvider}
 * (ADR-0023, ADR-0024). At most one of {@code KEEL_VAULT_ADDR} ({@code keel.vault-addr}), {@code
 * KEEL_AWS_SECRET_ID} ({@code keel.aws-secret-id}), and {@code KEEL_GCP_SECRET} ({@code
 * keel.gcp-secret}) may be set; more than one fails construction, and none selects the dev {@code
 * EnvSecretProvider}. For OpenBao, {@code KEEL_VAULT_TOKEN} (static token) or {@code
 * KEEL_VAULT_ROLE} (Kubernetes auth role) authenticates; {@code KEEL_VAULT_MOUNT}/{@code
 * KEEL_VAULT_PATH} name the KV v2 secret, and the remaining {@code KEEL_VAULT_*} fields tune the
 * Kubernetes auth mount/JWT path, the Vault namespace, and the TLS CA. For AWS Secrets Manager,
 * {@code KEEL_AWS_SECRET_ID} names the secret (name or ARN) and {@code KEEL_AWS_REGION} optionally
 * pins the region (else the SDK default chain); credentials come from the default AWS provider
 * chain. For GCP Secret Manager, {@code KEEL_GCP_SECRET} names the secret ({@code
 * projects/<project>/secrets/<name>} or the full {@code .../versions/<v>}) and {@code
 * KEEL_GCP_SECRET_VERSION} ({@code keel.gcp-secret-version}, default {@code latest}) selects the
 * version when the resource name carries none; credentials come from Application Default
 * Credentials. {@code KEEL_SECRET_CACHE_TTL_SECONDS} ({@code keel.secret-cache-ttl-seconds},
 * positive or fail, default 60) is the shared field-map cache TTL for every backend.
 */
@ConfigurationProperties(prefix = "keel")
@Validated
public record KeelProperties(
    @DefaultValue("") String oidcIssuer,
    @DefaultValue("") String oidcAudience,
    @DefaultValue("") String oidcJwksUri,
    @DefaultValue("postgres://localhost/keel") String databaseUrl,
    @DefaultValue("1048576") long maxBodyBytes,
    @DefaultValue List<String> corsAllowOrigins,
    @DefaultValue List<ApiKeyEntry> apiKeys,
    @DefaultValue("") String natsUrl,
    @DefaultValue("keel") String natsStream,
    @DefaultValue({"keel.>"}) List<String> natsSubjects,
    @DefaultValue("0") int grpcPort,
    @DefaultValue("") String grpcTlsCertPem,
    @DefaultValue("") String grpcTlsKeyPem,
    @DefaultValue("") String grpcTlsCaPem,
    @DefaultValue("false") boolean grpcTlsInsecure,
    @DefaultValue("") String vaultAddr,
    @DefaultValue("") String vaultToken,
    @DefaultValue("") String vaultRole,
    @DefaultValue("kubernetes") String vaultK8sMount,
    @DefaultValue("/var/run/secrets/kubernetes.io/serviceaccount/token") String vaultK8sJwtPath,
    @DefaultValue("secret") String vaultMount,
    @DefaultValue("") String vaultPath,
    @DefaultValue("") String vaultNamespace,
    @DefaultValue("") String vaultCacert,
    @DefaultValue("60") int secretCacheTtlSeconds,
    @DefaultValue("") String awsSecretId,
    @DefaultValue("") String awsRegion,
    @DefaultValue("") String gcpSecret,
    @DefaultValue("latest") String gcpSecretVersion) {

  /**
   * One configured API-key credential (platform.yaml auth: api_key). The key is stored only as its
   * SHA-256 hex digest ({@code keyHash}) so plaintext never lands in config or memory; the
   * presented key is hashed and compared. {@code subject} identifies the caller and {@code
   * scopes}/{@code roles} become the {@code SCOPE_*}/{@code ROLE_*} authorities enforced per route.
   * Bound from {@code KEEL_APIKEYS_0_KEYHASH}, {@code KEEL_APIKEYS_0_SUBJECT}, {@code
   * KEEL_APIKEYS_0_SCOPES}, etc.
   */
  public record ApiKeyEntry(
      @DefaultValue("") String keyHash,
      @DefaultValue("") String subject,
      @DefaultValue List<String> scopes,
      @DefaultValue List<String> roles) {}
}
