package io.keel.core.web;

import io.keel.core.domain.DomainException;
import io.keel.core.domain.ErrorCategory;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/**
 * Renders unhandled errors as RFC 9457 problem+json. A DomainException maps to its category;
 * server-fault (5xx) detail is logged server-side and dropped from the body, so internals never
 * reach the client. Standard Spring MVC exceptions (404/405/415/malformed body) are handled by the
 * base class as problem+json; anything else fails closed to a 500. Spring Security's 401/403 are
 * rendered by the security entry points, not here.
 */
@RestControllerAdvice
public class ProblemExceptionHandler extends ResponseEntityExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(ProblemExceptionHandler.class);

  @ExceptionHandler(DomainException.class)
  public ResponseEntity<ProblemDetail> handleDomain(
      DomainException ex, HttpServletRequest request) {
    if (ex.category().isServerFault()) {
      log.error(
          "request failed with a server-side fault: category={} detail={}",
          ex.category().slug(),
          ex.detail());
    }
    return render(ex.toProblem(URI.create(request.getRequestURI())));
  }

  @Override
  protected ResponseEntity<Object> handleMethodArgumentNotValid(
      MethodArgumentNotValidException ex,
      HttpHeaders headers,
      HttpStatusCode status,
      WebRequest request) {
    String detail =
        ex.getBindingResult().getFieldErrors().stream()
            .map(error -> error.getField() + ": " + error.getDefaultMessage())
            .collect(Collectors.joining("; "));
    ProblemDetail problem =
        new DomainException(
                ErrorCategory.VALIDATION, detail.isEmpty() ? "validation failed" : detail)
            .toProblem(instanceOf(request));
    return ResponseEntity.status(problem.getStatus())
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(problem);
  }

  @Override
  protected ResponseEntity<Object> handleHttpMessageNotReadable(
      HttpMessageNotReadableException ex,
      HttpHeaders headers,
      HttpStatusCode status,
      WebRequest request) {
    // A body-limit overflow surfaces here (the chunked case aborts the stream mid-read);
    // render it as 413 rather than the default 400 for an unreadable body.
    if (ex.getMostSpecificCause() instanceof PayloadTooLargeException) {
      ProblemDetail problem = ProblemDetail.forStatus(413);
      problem.setType(URI.create("urn:keel:error:payload_too_large"));
      problem.setTitle("Payload Too Large");
      URI instance = instanceOf(request);
      if (instance != null) {
        problem.setInstance(instance);
      }
      return ResponseEntity.status(413)
          .contentType(MediaType.APPLICATION_PROBLEM_JSON)
          .body(problem);
    }
    ProblemDetail problem =
        new DomainException(ErrorCategory.VALIDATION, "invalid request body")
            .toProblem(instanceOf(request));
    return ResponseEntity.status(problem.getStatus())
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(problem);
  }

  @ExceptionHandler(AccessDeniedException.class)
  public ResponseEntity<ProblemDetail> handleAccessDenied(
      AccessDeniedException ex, HttpServletRequest request) {
    // @PreAuthorize denials surface here (inside MVC), unlike filter-level 401/403s.
    return render(
        new DomainException(ErrorCategory.FORBIDDEN, "insufficient scope")
            .toProblem(URI.create(request.getRequestURI())));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<ProblemDetail> handleUnknown(Exception ex, HttpServletRequest request) {
    log.error("unhandled error", ex);
    ProblemDetail problem =
        new DomainException(ErrorCategory.INTERNAL, "internal error")
            .toProblem(URI.create(request.getRequestURI()));
    return render(problem);
  }

  private static ResponseEntity<ProblemDetail> render(ProblemDetail problem) {
    return ResponseEntity.status(problem.getStatus())
        .contentType(MediaType.APPLICATION_PROBLEM_JSON)
        .body(problem);
  }

  private static URI instanceOf(WebRequest request) {
    if (request instanceof ServletWebRequest servletRequest) {
      return URI.create(servletRequest.getRequest().getRequestURI());
    }
    return null;
  }
}
