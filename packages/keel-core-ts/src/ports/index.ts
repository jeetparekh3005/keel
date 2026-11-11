// The driven-port interfaces the domain depends on (ADR-0002, ADR-0009): the small,
// cross-cutting seams that adapters implement. The authentication port lives in ../auth.
// Each port has a matching injection token so services can bind an adapter via NestJS DI.

/** The time seam, so time-dependent logic is testable with a frozen clock. */
export interface Clock {
  now(): Date;
}

/** Resolves a secret by key (highest-precedence config source). Returns undefined when absent. */
export interface SecretProvider {
  get(key: string): string | undefined;
}

/** DI token for the Clock port. */
export const CLOCK = Symbol('keel.Clock');

/** DI token for the SecretProvider port. */
export const SECRET_PROVIDER = Symbol('keel.SecretProvider');
