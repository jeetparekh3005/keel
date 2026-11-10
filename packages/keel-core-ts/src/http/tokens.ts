import type { Logger } from 'pino';

/** DI token for the shared redacting logger. */
export const LOGGER = Symbol('keel.Logger');

/** DI token for the readiness check backing /readyz. */
export const READINESS = Symbol('keel.Readiness');

/** Reports whether the service's dependencies are reachable (e.g. a DB ping). */
export type ReadinessCheck = () => Promise<boolean> | boolean;

export type { Logger };
