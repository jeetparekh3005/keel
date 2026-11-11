package io.keel.core.domain;

import java.net.URI;
import org.springframework.http.ProblemDetail;

/**
 * A category plus a human-readable detail; the exception the domain throws. Adapters render it as
 * an RFC 9457 {@link ProblemDetail}, never leaking internals: for a server-fault category (5xx) the
 * detail is dropped from the body (it may contain internal diagnostics) and logged server-side
 * instead; client-fault categories (4xx) keep their caller-facing detail.
 */
public class DomainException extends RuntimeException {

  private final ErrorCategory category;

  public DomainException(ErrorCategory category, String detail) {
    super(detail);
    this.category = category;
  }

  public ErrorCategory category() {
    return category;
  }

  public String detail() {
    return getMessage();
  }

  /** Render this error as an RFC 9457 problem+json body. */
  public ProblemDetail toProblem(URI instance) {
    ProblemDetail problem = ProblemDetail.forStatus(category.status());
    problem.setType(URI.create(category.typeUri()));
    problem.setTitle(category.title());
    if (!category.isServerFault()) {
      problem.setDetail(detail());
    }
    if (instance != null) {
      problem.setInstance(instance);
    }
    return problem;
  }
}
