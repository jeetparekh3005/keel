package io.keel.core.web;

import java.io.IOException;

/**
 * Thrown by the body-limit stream wrapper when a request body exceeds the configured cap while
 * being read (the chunked case, where there is no Content-Length to check up front). Extends
 * IOException so Spring's message converter wraps it in HttpMessageNotReadableException, which the
 * exception handler maps to a 413.
 */
public class PayloadTooLargeException extends IOException {
  public PayloadTooLargeException(long maxBytes) {
    super("request body exceeds the " + maxBytes + "-byte limit");
  }
}
