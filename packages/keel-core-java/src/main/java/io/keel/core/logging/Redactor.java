package io.keel.core.logging;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Secret redaction for the JSON log sink, matching the other verticals: a secret-family key is
 * redacted wholesale, and string values are scrubbed for secret patterns (JWT, AWS key id, bearer,
 * PEM private key, Luhn-valid card numbers).
 *
 * <p>Java's regex engine can backtrack, so every pattern here is written to run in linear time (no
 * nested or adjacent ambiguous quantifiers), the ReDoS-immune property Go gets from RE2.
 */
public final class Redactor {

  public static final String REDACTED = "[REDACTED]";

  private Redactor() {}

  // Fragments that mark a key whose value is redacted wholesale. Matched against a normalized
  // (lowercased, separator-stripped) key.
  private static final List<String> SECRET_KEY_FRAGMENTS =
      List.of(
          "password",
          "passwd",
          "secret",
          "token",
          "apikey",
          "cookie",
          "authorization",
          "credential",
          "privatekey",
          "pii");

  // High-precision secret patterns scrubbed from any string value. Each is linear-time.
  private static final Pattern[] SECRET_PATTERNS = {
    Pattern.compile("eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}"), // JWT
    Pattern.compile("AKIA[0-9A-Z]{16}"), // AWS access key id
    Pattern.compile("[Bb][Ee][Aa][Rr][Ee][Rr]\\s+[A-Za-z0-9._~+/-]{8,}=*"), // bearer (1+ spaces)
    Pattern.compile("-----BEGIN [A-Z ]*PRIVATE KEY-----"), // PEM private key
  };

  // Card-like digit runs (13-19 digits, optionally space/dash separated); only redacted when
  // Luhn-valid. Anchored on digits at both ends so surrounding separators are not eaten.
  private static final Pattern CC_CANDIDATE = Pattern.compile("\\d(?:[ -]?\\d){12,18}");

  /** Whether a key belongs to a secret family (case- and separator-insensitive). */
  public static boolean isSecretKey(String key) {
    String normalized = key.toLowerCase().replace("-", "").replace("_", "");
    for (String fragment : SECRET_KEY_FRAGMENTS) {
      if (normalized.contains(fragment)) {
        return true;
      }
    }
    return false;
  }

  /** Replace secret patterns and Luhn-valid card numbers in a string value. */
  public static String scrubText(String text) {
    String out = text;
    for (Pattern pattern : SECRET_PATTERNS) {
      out = pattern.matcher(out).replaceAll(REDACTED);
    }
    out =
        CC_CANDIDATE
            .matcher(out)
            .replaceAll(match -> {
              String digits = match.group().replaceAll("[^0-9]", "");
              if (digits.length() >= 13 && digits.length() <= 19 && luhnOk(digits)) {
                return REDACTED;
              }
              return java.util.regex.Matcher.quoteReplacement(match.group());
            });
    return out;
  }

  /**
   * Recursively redact a logged value: a secret-family key is redacted wholesale, string values are
   * scrubbed, and nested maps/lists are descended into.
   */
  @SuppressWarnings("unchecked")
  public static Object redactValue(Object value) {
    if (value instanceof String s) {
      return scrubText(s);
    }
    if (value instanceof Map<?, ?> map) {
      return map.entrySet().stream()
          .collect(
              java.util.LinkedHashMap::new,
              (acc, e) ->
                  acc.put(
                      String.valueOf(e.getKey()),
                      isSecretKey(String.valueOf(e.getKey()))
                          ? REDACTED
                          : redactValue(e.getValue())),
              Map::putAll);
    }
    if (value instanceof List<?> list) {
      return list.stream().map(Redactor::redactValue).toList();
    }
    return value;
  }

  private static boolean luhnOk(String digits) {
    int sum = 0;
    boolean doubleDigit = false;
    for (int i = digits.length() - 1; i >= 0; i--) {
      int d = digits.charAt(i) - '0';
      if (d < 0 || d > 9) {
        return false;
      }
      if (doubleDigit) {
        d *= 2;
        if (d > 9) {
          d -= 9;
        }
      }
      sum += d;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 == 0;
  }
}
