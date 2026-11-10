package io.keel.core.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Set;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Deny-by-default CORS. No allow-origin header is emitted unless the request's Origin is explicitly
 * configured (or {@code *} is configured, which never combines a wildcard with credentials). When
 * no origins are configured the filter is inert: a cross-origin caller gets no CORS headers, so the
 * browser blocks it. Mirrors the other verticals' CORS.
 */
public class DenyByDefaultCorsFilter extends OncePerRequestFilter {

  private final boolean allowAny;
  private final Set<String> allowed;

  public DenyByDefaultCorsFilter(List<String> origins) {
    this.allowAny = origins.contains("*");
    this.allowed = Set.copyOf(origins);
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String origin = request.getHeader("Origin");
    if (origin != null && !origin.isEmpty()) {
      if (allowAny) {
        response.setHeader("Access-Control-Allow-Origin", "*");
      } else if (allowed.contains(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.addHeader("Vary", "Origin");
      }
      if (response.getHeader("Access-Control-Allow-Origin") != null) {
        response.setHeader(
            "Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      }
    }
    if ("OPTIONS".equals(request.getMethod())) {
      response.setStatus(204);
      return;
    }
    chain.doFilter(request, response);
  }
}
