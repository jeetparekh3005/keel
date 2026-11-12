// Secret redaction for the JSON log sink, matching the Python, Rust, and Go verticals: a
// secret-family key is redacted wholesale, and string values are scrubbed for secret
// patterns (JWT, AWS key id, bearer, PEM private key, Luhn-valid card numbers).
//
// The JavaScript regex engine can backtrack, so every pattern here is written to run in
// linear time (no nested or adjacent ambiguous quantifiers), the ReDoS-immune property the
// Go vertical gets for free from RE2.

export const REDACTED = '[REDACTED]';

// Bound recursion so a pathologically deep (or adversarially deep) structure cannot overflow the
// call stack and crash the logging call. Real log payloads are nowhere near this deep.
const MAX_DEPTH = 100;

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
export function redactValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') {
    return scrubText(value);
  }
  if (typeof value === 'function') {
    // A function can carry own properties (a secret among them); util.format would print them
    // verbatim. Collapse it to a bare label so no attached secret can leak.
    return `[Function: ${value.name || 'anonymous'}]`;
  }
  if (typeof value === 'bigint') {
    // JSON.stringify (pino's merge path and util.format's %j) throws on a BigInt; emit its decimal
    // string so logging a BigInt - or an object/record containing one - cannot crash the call.
    return value.toString();
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    // Stop recursing before the stack overflows; the value is elided wholesale, so nothing
    // under it (secret or not) is emitted.
    return '[truncated: max depth]';
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  const next = depth + 1;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, next));
  }
  // A Date's data lives in an internal slot and Date.toJSON emits only the ISO string, so any
  // property attached to it is dropped on serialization - safe to pass through so util.format and
  // pino render the real timestamp.
  if (value instanceof Date) {
    return value;
  }
  // A RegExp, unlike a Date, has NO toJSON, so pino/JSON.stringify serialize its OWN-ENUMERABLE
  // properties verbatim - a secret attached to a RegExp (`r.password = ...`) would leak in
  // cleartext. Represent the pattern by its (scrubbed) source and key-redact any attached props.
  if (value instanceof RegExp) {
    const own = _redactOwnProps(value, seen, next);
    const source = scrubText(value.toString());
    return Object.keys(own).length === 0 ? source : { regex: source, ...own };
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value) {
      // A string key in the secret family redacts its VALUE wholesale. The KEY itself is also
      // redacted (an OBJECT key can carry a secret-family field, and util.format('%o', map) renders
      // keys verbatim - leaving it raw leaks the key object's secret in cleartext).
      const redactedValue =
        typeof k === 'string' && isSecretKey(k) ? REDACTED : redactValue(v, seen, next);
      out.set(redactValue(k, seen, next), redactedValue);
    }
    return out;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value, (item) => redactValue(item, seen, next)));
  }
  if (value instanceof Error) {
    // Return a rebuilt Error with SCRUBBED message/stack and key-redacted own-props. The merge
    // object log path (`logger.x({ err }, msg)`) runs only redactValue - NO final scrubText - so
    // a pattern secret (JWT/AWS/bearer/PEM) in the message or stack must be scrubbed HERE or it
    // prints in cleartext (returning the raw Error, or copying message/stack verbatim, leaks it).
    // We rebuild a real Error (not a plain object) so util.format still renders a native stack and
    // pino's error serializer still sees message/stack - both now scrubbed. A non-pattern secret
    // embedded in the free-form message text is not caught (no key to match on): a known limit.
    const rebuilt = new Error(scrubText(value.message));
    // Keep the original class name without adding an enumerable field to the log output.
    Object.defineProperty(rebuilt, 'name', {
      value: value.name,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    if (typeof value.stack === 'string') {
      rebuilt.stack = scrubText(value.stack);
    }
    // Enumerable own-props only (Object.keys excludes Symbol keys, so a Symbol-keyed secret is
    // DROPPED rather than leaked); key-redact and recurse, guarding a throwing getter.
    for (const [key, val] of Object.entries(_redactOwnProps(value, seen, next))) {
      (rebuilt as unknown as Record<string, unknown>)[key] = val;
    }
    return rebuilt;
  }
  // Plain object OR class instance: both keep their data in enumerable own-properties, so the
  // key-redaction loop handles them identically (a class instance loses its class name in the
  // log output, an acceptable trade for redacting its secret-family fields).
  return _redactOwnProps(value, seen, next);
}

/**
 * Key-redact the enumerable own string-keyed properties of an object, recursing into values.
 * Symbol-keyed properties are intentionally skipped (dropped, never emitted). A property whose
 * getter throws is reported as ``[unreadable]`` rather than crashing the logging call.
 */
function _redactOwnProps(
  value: object,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let keys: string[];
  try {
    // A hostile Proxy can throw from its ownKeys trap; never let that crash the logging call.
    keys = Object.keys(value);
  } catch {
    return { '[unreadable]': true };
  }
  for (const key of keys) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    let raw: unknown;
    try {
      raw = (value as Record<string, unknown>)[key];
    } catch {
      out[key] = '[unreadable]';
      continue;
    }
    out[key] = redactValue(raw, seen, depth);
  }
  return out;
}
