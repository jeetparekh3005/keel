// Shared caching SecretProvider core (ADR-0024). The SecretProvider port's `get` is synchronous in
// every vertical and Node cannot do synchronous I/O, so a cloud-backed provider must never perform
// I/O in `get()`: it loads the secret's field map into memory once at init (awaited by an async
// factory), then serves `get()` synchronously from that cache. A background refresh re-invokes the
// loader every TTL; a transient outage keeps serving the last good field map, and a token or secret
// value is never logged.
//
// OpenBao (ADR-0023), AWS Secrets Manager, and GCP Secret Manager are all loaders over this one
// engine (ADR-0024 decision 3): a loader authenticates and returns the raw field map; the core owns
// the cache, the coercion, the refresh ticker, and the fail-closed/no-leak semantics.

/** Minimal structured logger surface used for refresh diagnostics (pino's Logger satisfies it). */
export interface SecretProviderLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * A per-backend secret loader. `load()` authenticates as needed and returns the raw field map; the
 * caching core calls it once at init and again every TTL. A not-found secret returns an empty map
 * (every `get()` absent); any other failure throws (fail-closed). Implementations hold their own
 * auth state (tokens, leases) across calls - the core never inspects it.
 */
export interface SecretLoader {
  /** A short, non-sensitive label for refresh diagnostics (never a token or secret). */
  readonly label: string;
  /** Authenticate as needed and return the raw field map. */
  load(): Promise<Record<string, unknown>>;
}

/** Construction inputs for the caching core: the refresh cadence and a diagnostics logger. */
export interface CachingSecretProviderOptions {
  ttlMs: number;
  logger: SecretProviderLogger;
}

export const DEFAULT_TTL_SECONDS = 60;

/** Trim a value, treating a whitespace-only or undefined value as absent. */
export function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/** Narrow an unknown to a plain JSON object (not an array, not null). */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Resolve the shared cache TTL (ADR-0024: `KEEL_SECRET_CACHE_TTL_SECONDS`, default 60), used by every
 * backend. The value must parse to a positive integer number of seconds; a non-positive, fractional,
 * or unparseable value fails closed (the caller rejects) rather than quietly picking a surprise
 * refresh cadence.
 */
export function resolveCacheTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = trimmed(env['KEEL_SECRET_CACHE_TTL_SECONDS']);
  const seconds = raw !== undefined ? Number(raw) : DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error('KEEL_SECRET_CACHE_TTL_SECONDS must be a positive integer number of seconds');
  }
  return seconds * 1000;
}

/**
 * The SecretProvider caching engine (ADR-0024). Construct a backend's provider over its
 * {@link SecretLoader}, then `await init()` so `get()` reads a warm cache and performs no I/O. A
 * background ticker re-invokes the loader every TTL; a failed refresh logs a redaction-safe
 * diagnostic and keeps serving the last good field map.
 */
export class CachingSecretProvider {
  private readonly loader: SecretLoader;
  private readonly ttlMs: number;
  private readonly logger: SecretProviderLogger;
  private fields: Record<string, unknown> = {};
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(loader: SecretLoader, options: CachingSecretProviderOptions) {
    this.loader = loader;
    this.ttlMs = options.ttlMs;
    this.logger = options.logger;
  }

  /**
   * Load the field map once, then start the background TTL refresh. Awaited by the factory so the
   * provider is fully warmed before first use; a load failure rejects (fail-closed).
   */
  async init(): Promise<void> {
    this.fields = await this.loader.load();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.ttlMs);
    // Do not keep the event loop (and thus the process) alive just for the refresh ticker.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * ADR-0023 coercion: a JSON string is returned verbatim; a JSON number or boolean is coerced to
   * its canonical string (`42`, `true`/`false`); a JSON object, array, or null (and any absent key)
   * is reported absent (`undefined`) so structured values never leak out as `[object Object]`.
   */
  get(key: string): string | undefined {
    const value = this.fields[key];
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return undefined;
  }

  /** Stop the background refresh. Idempotent; call at shutdown so the process can exit cleanly. */
  close(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Alias for {@link close}, for callers that dispose resources by convention. */
  dispose(): void {
    this.close();
  }

  /**
   * Background refresh: re-invoke the loader and swap in the new field map. On failure the last good
   * map continues to serve and a redaction-safe diagnostic is logged (never a token or secret value)
   * - a transient outage does not take the service down.
   */
  private async refresh(): Promise<void> {
    try {
      this.fields = await this.loader.load();
    } catch (err) {
      this.logger.warn(
        { provider: this.loader.label, err: err instanceof Error ? err.message : String(err) },
        'secret refresh failed; serving last good field map',
      );
    }
  }
}
