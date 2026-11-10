// The pure domain layer: the error taxonomy and its RFC 9457 problem+json representation.
// Mirrors platform.yaml errors.taxonomy and the Python, Rust, and Go verticals: one category
// per failure, each mapping to a stable HTTP status and a machine-readable urn:keel:error:*
// type. The domain throws a DomainError; adapters render it as a Problem, never leaking
// internals.

/** A domain failure category; each maps to one HTTP status. */
export enum ErrorCategory {
  Validation = 'validation',
  Unauthenticated = 'unauthenticated',
  Forbidden = 'forbidden',
  NotFound = 'not_found',
  Conflict = 'conflict',
  RateLimited = 'rate_limited',
  Internal = 'internal',
  Unavailable = 'unavailable',
}

const STATUS: Record<ErrorCategory, number> = {
  [ErrorCategory.Validation]: 400,
  [ErrorCategory.Unauthenticated]: 401,
  [ErrorCategory.Forbidden]: 403,
  [ErrorCategory.NotFound]: 404,
  [ErrorCategory.Conflict]: 409,
  [ErrorCategory.RateLimited]: 429,
  [ErrorCategory.Internal]: 500,
  [ErrorCategory.Unavailable]: 503,
};

const TITLE: Record<ErrorCategory, string> = {
  [ErrorCategory.Validation]: 'Bad Request',
  [ErrorCategory.Unauthenticated]: 'Unauthorized',
  [ErrorCategory.Forbidden]: 'Forbidden',
  [ErrorCategory.NotFound]: 'Not Found',
  [ErrorCategory.Conflict]: 'Conflict',
  [ErrorCategory.RateLimited]: 'Too Many Requests',
  [ErrorCategory.Internal]: 'Internal Server Error',
  [ErrorCategory.Unavailable]: 'Service Unavailable',
};

/** The HTTP status code for a category (platform.yaml taxonomy). */
export function statusFor(category: ErrorCategory): number {
  return STATUS[category];
}

/** A short human-readable title for the problem response. */
export function titleFor(category: ErrorCategory): string {
  return TITLE[category];
}

/** The machine-readable problem type URI for a category. */
export function typeUriFor(category: ErrorCategory): string {
  return `urn:keel:error:${category}`;
}

/**
 * Whether a category is a server-side fault (5xx) whose detail may embed internal
 * diagnostics (SQL text, driver errors). Such detail must not reach the client; it is
 * logged server-side instead.
 */
export function isServerFault(category: ErrorCategory): boolean {
  return category === ErrorCategory.Internal || category === ErrorCategory.Unavailable;
}

/** An RFC 9457 problem+json body (application/problem+json). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

/** A category plus a human-readable detail; the error type the domain throws. */
export class DomainError extends Error {
  constructor(
    readonly category: ErrorCategory,
    readonly detail: string,
  ) {
    super(`${category}: ${detail}`);
    this.name = 'DomainError';
  }

  /**
   * Render the error as a Problem. For server-fault categories (5xx) the detail is dropped:
   * it may contain internal diagnostics that must never reach a client (adapters log the
   * real detail instead). Client-fault categories (4xx) keep their caller-facing detail.
   */
  toProblem(instance?: string): Problem {
    const problem: Problem = {
      type: typeUriFor(this.category),
      title: titleFor(this.category),
      status: statusFor(this.category),
    };
    if (instance) {
      problem.instance = instance;
    }
    if (!isServerFault(this.category)) {
      problem.detail = this.detail;
    }
    return problem;
  }
}

/** Type guard for DomainError (survives bundling / cross-realm better than instanceof alone). */
export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError || (err instanceof Error && err.name === 'DomainError');
}
