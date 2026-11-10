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
 */
@ConfigurationProperties(prefix = "keel")
@Validated
public record KeelProperties(
    @DefaultValue("") String oidcIssuer,
    @DefaultValue("") String oidcAudience,
    @DefaultValue("") String oidcJwksUri,
    @DefaultValue("postgres://localhost/keel") String databaseUrl,
    @DefaultValue("1048576") long maxBodyBytes,
    @DefaultValue List<String> corsAllowOrigins) {}
