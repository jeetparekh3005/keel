package io.keel.core.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Rejects a request whose Content-Length exceeds the configured cap with a 413 problem+json,
 * bounding the large-payload DoS vector. Chunked over-limit bodies are additionally bounded by the
 * Tomcat max-swallow-size set in application.yml.
 */
public class BodyLimitFilter extends OncePerRequestFilter {

  private final long maxBytes;

  public BodyLimitFilter(long maxBytes) {
    this.maxBytes = maxBytes;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    if (request.getContentLengthLong() > maxBytes) {
      ProblemSupport.write(
          response,
          413,
          "urn:keel:error:payload_too_large",
          "Payload Too Large",
          null,
          request.getRequestURI());
      return;
    }
    chain.doFilter(request, response);
  }
}
