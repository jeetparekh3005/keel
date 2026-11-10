package io.keel.core.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Sets the always-on security headers (only if a route has not already set them). Registered
 * outermost so even a short-circuited response (e.g. a body-limit 413) carries them. HSTS is
 * emitted unconditionally: browsers ignore it over plaintext.
 */
public class SecurityHeadersFilter extends OncePerRequestFilter {

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    setIfAbsent(response, "Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    setIfAbsent(response, "X-Content-Type-Options", "nosniff");
    setIfAbsent(response, "X-Frame-Options", "DENY");
    setIfAbsent(response, "Referrer-Policy", "no-referrer");
    setIfAbsent(
        response,
        "Permissions-Policy",
        "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
    setIfAbsent(response, "Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    chain.doFilter(request, response);
  }

  private static void setIfAbsent(HttpServletResponse response, String name, String value) {
    if (response.getHeader(name) == null) {
      response.setHeader(name, value);
    }
  }
}
