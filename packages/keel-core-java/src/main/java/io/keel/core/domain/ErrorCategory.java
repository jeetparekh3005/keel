package io.keel.core.domain;

/**
 * A domain failure category; each maps to one HTTP status and a stable {@code urn:keel:error:*}
 * type. Mirrors platform.yaml errors.taxonomy and the Python, Rust, Go, and TypeScript verticals.
 */
public enum ErrorCategory {
  VALIDATION(400, "validation", "Bad Request"),
  UNAUTHENTICATED(401, "unauthenticated", "Unauthorized"),
  FORBIDDEN(403, "forbidden", "Forbidden"),
  NOT_FOUND(404, "not_found", "Not Found"),
  CONFLICT(409, "conflict", "Conflict"),
  RATE_LIMITED(429, "rate_limited", "Too Many Requests"),
  INTERNAL(500, "internal", "Internal Server Error"),
  UNAVAILABLE(503, "unavailable", "Service Unavailable");

  private final int status;
  private final String slug;
  private final String title;

  ErrorCategory(int status, String slug, String title) {
    this.status = status;
    this.slug = slug;
    this.title = title;
  }

  /** The HTTP status code for this category (platform.yaml taxonomy). */
  public int status() {
    return status;
  }

  /** The stable identifier used in the problem type URI and logs. */
  public String slug() {
    return slug;
  }

  /** A short human-readable title for the problem response. */
  public String title() {
    return title;
  }

  /** The machine-readable problem type URI for this category. */
  public String typeUri() {
    return "urn:keel:error:" + slug;
  }

  /**
   * Whether this is a server-side fault (5xx) whose detail may embed internal diagnostics (SQL
   * text, driver errors). Such detail must not reach the client; it is logged server-side instead.
   */
  public boolean isServerFault() {
    return this == INTERNAL || this == UNAVAILABLE;
  }
}
