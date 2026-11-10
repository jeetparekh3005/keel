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
  /[Bb][Ee][Aa][Rr][Ee][Rr]\s[A-Za-z0-9._~+/-]{8,}=*/g, // bearer token
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
 * Recursively redact a logged value: a secret-family key is redacted wholesale, string
 * values are scrubbed for secret patterns, and nested objects/arrays are descended into.
 * Cyclic references are broken with a marker so logging can never loop.
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
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? REDACTED : redactValue(val, seen);
  }
  return out;
}
