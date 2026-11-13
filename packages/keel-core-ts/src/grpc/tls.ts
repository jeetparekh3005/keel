import type { SecureClientSessionOptions, SecureServerOptions } from 'node:http2';

import { DomainError, ErrorCategory } from '../domain/errors.js';
import type { SecretProvider } from '../ports/index.js';

/** The PEM material for one mTLS identity: the trust root plus this peer's own cert and key. */
export interface MutualTlsPem {
  /** Root CA chain (PEM) used to verify the peer certificate. */
  rootCa: string;
  /** This identity's certificate chain (PEM). */
  cert: string;
  /** This identity's private key (PEM). */
  key: string;
}

/** The SecretProvider keys under which the mTLS PEM material is stored. */
export interface MutualTlsSecretKeys {
  rootCa: string;
  cert: string;
  key: string;
}

/**
 * Load the mTLS PEM material from the SecretProvider, the highest-precedence config source (the
 * PKI is provisioned per deployment by OpenBao/Vault, ADR-0007). A missing or blank secret is an
 * Unavailable DomainError: the server cannot stand up its mTLS listener without it.
 */
export function loadMutualTlsPem(secrets: SecretProvider, keys: MutualTlsSecretKeys): MutualTlsPem {
  return {
    rootCa: requireSecret(secrets, keys.rootCa),
    cert: requireSecret(secrets, keys.cert),
    key: requireSecret(secrets, keys.key),
  };
}

function requireSecret(secrets: SecretProvider, key: string): string {
  const value = secrets.get(key);
  if (value === undefined || value.trim().length === 0) {
    throw new DomainError(ErrorCategory.Unavailable, `missing mTLS secret: ${key}`);
  }
  return value;
}

/**
 * Server-side mTLS options for http2.createSecureServer: serve this identity's cert/key and
 * REQUIRE a client certificate signed by rootCa. This is the Node equivalent of the Python
 * factory's grpc.ssl_server_credentials(..., require_client_auth=True) and the grpc-js
 * ServerCredentials.createSsl(rootCa, [{ private_key, cert_chain }], true): requestCert asks for
 * the client cert and rejectUnauthorized rejects the handshake unless it chains to rootCa.
 */
export function serverTlsOptions(pem: MutualTlsPem): SecureServerOptions {
  return {
    key: pem.key,
    cert: pem.cert,
    ca: pem.rootCa,
    requestCert: true,
    rejectUnauthorized: true,
    // gRPC is HTTP/2 only; disable the HTTP/1 fallback so a plaintext/h1 client cannot bypass it.
    allowHTTP1: false,
    minVersion: 'TLSv1.2',
  };
}

/**
 * Client-side mTLS options for createGrpcTransport's nodeOptions: present this identity's cert/key
 * and verify the server certificate against rootCa, so the call is mutually authenticated.
 */
export function clientTlsOptions(pem: MutualTlsPem): SecureClientSessionOptions {
  return {
    key: pem.key,
    cert: pem.cert,
    ca: pem.rootCa,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
}
