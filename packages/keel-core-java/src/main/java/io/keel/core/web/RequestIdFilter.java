package io.keel.core.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Propagates a client X-Request-Id or mints a fresh UUID, echoes it on the response, and puts it in
 * the logging MDC so log lines carry it (alongside the traceId/spanId Micrometer adds).
 */
public class RequestIdFilter extends OncePerRequestFilter {

  private static final String HEADER = "X-Request-Id";
  private static final String MDC_KEY = "requestId";

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String id = request.getHeader(HEADER);
    if (id == null || id.isEmpty()) {
      id = UUID.randomUUID().toString();
    }
    response.setHeader(HEADER, id);
    MDC.put(MDC_KEY, id);
    try {
      chain.doFilter(request, response);
    } finally {
      MDC.remove(MDC_KEY);
    }
  }
}
