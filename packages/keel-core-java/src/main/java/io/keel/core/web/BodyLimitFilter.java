package io.keel.core.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Bounds the request body to the configured cap, closing the large-payload DoS vector. A request
 * that declares an over-limit Content-Length is rejected up front with a 413. A chunked request (no
 * Content-Length) is bounded by wrapping its input stream in a counting stream that aborts once the
 * cap is read, mirroring Go's http.MaxBytesReader; the abort surfaces as a 413 via the exception
 * handler. Both the stream and the reader are wrapped so JSON and form reads are covered.
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
    chain.doFilter(new LimitingRequest(request, maxBytes), response);
  }

  /** Wraps a request so its body cannot be read past the cap. */
  private static final class LimitingRequest extends HttpServletRequestWrapper {
    private final long maxBytes;

    LimitingRequest(HttpServletRequest request, long maxBytes) {
      super(request);
      this.maxBytes = maxBytes;
    }

    @Override
    public ServletInputStream getInputStream() throws IOException {
      return new LimitingServletInputStream(super.getInputStream(), maxBytes);
    }

    @Override
    public BufferedReader getReader() throws IOException {
      Charset charset =
          getCharacterEncoding() != null
              ? Charset.forName(getCharacterEncoding())
              : StandardCharsets.UTF_8;
      return new BufferedReader(new InputStreamReader(getInputStream(), charset));
    }
  }

  /** Delegating ServletInputStream that throws once more than maxBytes have been read. */
  private static final class LimitingServletInputStream extends ServletInputStream {
    private final ServletInputStream delegate;
    private final long maxBytes;
    private long read;

    LimitingServletInputStream(ServletInputStream delegate, long maxBytes) {
      this.delegate = delegate;
      this.maxBytes = maxBytes;
    }

    private void count(int n) throws IOException {
      if (n > 0) {
        read += n;
        if (read > maxBytes) {
          throw new PayloadTooLargeException(maxBytes);
        }
      }
    }

    @Override
    public int read() throws IOException {
      int b = delegate.read();
      count(b >= 0 ? 1 : 0);
      return b;
    }

    @Override
    public int read(byte[] buffer, int off, int len) throws IOException {
      int n = delegate.read(buffer, off, len);
      count(n);
      return n;
    }

    @Override
    public boolean isFinished() {
      return delegate.isFinished();
    }

    @Override
    public boolean isReady() {
      return delegate.isReady();
    }

    @Override
    public void setReadListener(ReadListener readListener) {
      delegate.setReadListener(readListener);
    }
  }
}
