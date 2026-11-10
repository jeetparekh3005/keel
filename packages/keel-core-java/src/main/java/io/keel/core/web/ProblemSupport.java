package io.keel.core.web;

import io.keel.core.domain.ErrorCategory;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * Writes an RFC 9457 problem+json response directly to the servlet response. Used by the edge
 * filters and the security entry points, which run before Spring MVC's ProblemDetail machinery is
 * available.
 */
public final class ProblemSupport {

  public static final String CONTENT_TYPE = "application/problem+json";

  private ProblemSupport() {}

  /** Write a problem+json body for a category (type/title/status only; no detail). */
  public static void write(HttpServletResponse response, ErrorCategory category, String instance)
      throws IOException {
    write(response, category.status(), category.typeUri(), category.title(), null, instance);
  }

  public static void write(
      HttpServletResponse response,
      int status,
      String type,
      String title,
      String detail,
      String instance)
      throws IOException {
    response.setStatus(status);
    response.setContentType(CONTENT_TYPE);
    response.setCharacterEncoding("UTF-8");
    StringBuilder body = new StringBuilder(128);
    body.append('{')
        .append("\"type\":\"")
        .append(escape(type))
        .append('"')
        .append(",\"title\":\"")
        .append(escape(title))
        .append('"')
        .append(",\"status\":")
        .append(status);
    if (detail != null) {
      body.append(",\"detail\":\"").append(escape(detail)).append('"');
    }
    if (instance != null) {
      body.append(",\"instance\":\"").append(escape(instance)).append('"');
    }
    body.append('}');
    response.getWriter().write(body.toString());
  }

  private static String escape(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"");
  }
}
