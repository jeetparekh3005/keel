package io.keel.core.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import org.junit.jupiter.api.Test;
import org.springframework.http.ProblemDetail;

class DomainExceptionTest {

  @Test
  void mapsCategoriesToPlatformStatuses() {
    assertEquals(400, ErrorCategory.VALIDATION.status());
    assertEquals(401, ErrorCategory.UNAUTHENTICATED.status());
    assertEquals(403, ErrorCategory.FORBIDDEN.status());
    assertEquals(404, ErrorCategory.NOT_FOUND.status());
    assertEquals(409, ErrorCategory.CONFLICT.status());
    assertEquals(429, ErrorCategory.RATE_LIMITED.status());
    assertEquals(500, ErrorCategory.INTERNAL.status());
    assertEquals(503, ErrorCategory.UNAVAILABLE.status());
  }

  @Test
  void buildsStableTypeUris() {
    assertEquals("urn:keel:error:not_found", ErrorCategory.NOT_FOUND.typeUri());
    assertEquals("urn:keel:error:rate_limited", ErrorCategory.RATE_LIMITED.typeUri());
  }

  @Test
  void keepsClientDetailButDropsServerDetail() {
    ProblemDetail client =
        new DomainException(ErrorCategory.VALIDATION, "name required")
            .toProblem(URI.create("/v1/items"));
    assertEquals(400, client.getStatus());
    assertEquals("name required", client.getDetail());

    ProblemDetail server =
        new DomainException(ErrorCategory.INTERNAL, "SELECT secret FROM vault").toProblem(null);
    assertEquals(500, server.getStatus());
    assertNull(server.getDetail());
  }

  @Test
  void onlyFiveHundredsAreServerFaults() {
    assertTrue(ErrorCategory.INTERNAL.isServerFault());
    assertTrue(ErrorCategory.UNAVAILABLE.isServerFault());
    assertEquals(false, ErrorCategory.NOT_FOUND.isServerFault());
  }
}
