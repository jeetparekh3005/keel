// Secret redaction for the JSON log sink, matching the Python, Rust, and Go verticals: a
// secret-family key is redacted wholesale, and string values are scrubbed for secret
// patterns (JWT, AWS key id, bearer, PEM private key, Luhn-valid card numbers).
//
// The JavaScript regex engine can backtrack, so every pattern here is written to run in
// linear time (no nested or adjacent ambiguous quantifiers), the ReDoS-immune property the
// Go vertical gets for free from RE2.

export const REDACTED = '[REDACTED]';

// Fragments that mark a key whose value is redacted wholesale. Matched against a normalized
// (lowercased, separator-stripped) key, mirroring the other verticals.
const SECRET_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'cookie',
  'authorization',
  'credential',
  'privatekey',
  'pii',
];

/** Whether a key belongs to a secret family (case- and separator-insensitive). */
export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

// High-precision secret patterns scrubbed from any string value. Each is linear-time.
const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9._~+/-]{8,}=*/g, // bearer token (one-or-more spaces)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // PEM private key
];

// Credit-card-like digit runs (13-19 digits, optionally space/dash separated); only redacted
// when Luhn-valid. Anchored on digits at both ends so surrounding separators are not eaten.
// Bounded repetition with no ambiguous quantifier is linear (ReDoS-safe).
const CC_CANDIDATE = /\d(?:[ -]?\d){12,18}/g;

function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) {
      return false;
    }
    if (double) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replace secret patterns and Luhn-valid card numbers in a string value. */
export function scrubText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  out = out.replace(CC_CANDIDATE, (match) => {
    const digits = match.replace(/[^0-9]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) {
      return REDACTED;
    }
    return match;
  });
  return out;
}

/**
 * Recursively redact a logged value: a secret-family key is redacted wholesale, string values
 * are scrubbed for secret patterns, and nested containers are descended into. Cyclic references
 * are broken with a marker so logging can never loop.
 *
 * Containers are handled by shape rather than by prototype, so this is safe to apply to ANY
 * value - a plain object, an array, a class instance, a Map/Set, an Error, or a Date. This
 * matters because a naive object rebuild (Object.entries) is empty for an Error/Date/Map (their
 * data is in non-enumerable fields or internal slots), which would both destroy an error's
 * message/stack AND, if such values were instead passed through untouched, leak a secret-family
 * field that only key-based redaction catches. The branches below preserve diagnostics (Error
 * message/stack, Date value) while still key-redacting every secret-family entry.
 */
export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return scrubText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  // Date/RegExp carry no secret-family keys and their data lives in internal slots; pass them
  // through so util.format renders the real value instead of an empty {}.
  if (value instanceof Date || value instanceof RegExp) {
    return value;
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value) {
      out.set(k, typeof k === 'string' && isSecretKey(k) ? REDACTED : redactValue(v, seen));
    }
    return out;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value, (item) => redactValue(item, seen)));
  }
  if (value instanceof Error) {
    // Preserve the error's diagnostics (name/message/stack are non-enumerable, so an
    // Object.entries rebuild would drop them). When the error carries NO enumerable own-props
    // there is nothing key-based to redact, so return it as-is and let util.format print the
    // stack. When it does (e.g. an AxiosError's `config` with an auth header, a DB error's
    // connection detail), rebuild a redacted view that keeps the diagnostics and key-redacts
    // those own-props. The message/stack strings are still pattern-scrubbed by the final
    // scrubText pass over the formatted line; a non-pattern secret embedded in the message text
    // itself is not caught (no key to match on) - a known limit, not a container-shape bug.
    const ownEntries = Object.entries(value as unknown as Record<string, unknown>);
    if (ownEntries.length === 0) {
      return value;
    }
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const [key, val] of ownEntries) {
      out[key] = isSecretKey(key) ? REDACTED : redactValue(val, seen);
    }
    return out;
  }
  // Plain object OR class instance: both keep their data in enumerable own-properties, so the
  // key-redaction loop handles them identically (a class instance loses its class name in the
  // log output, an acceptable trade for redacting its secret-family fields).
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? REDACTED : redactValue(val, seen);
  }
  return out;
}
