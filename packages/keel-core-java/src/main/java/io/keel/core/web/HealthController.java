package io.keel.core.web;

import io.keel.core.domain.DomainException;
import io.keel.core.domain.ErrorCategory;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Liveness and readiness probes (platform.yaml health). Permitted for anonymous access by the
 * security config: /healthz is always 200 if the process is up; /readyz is 200 when the readiness
 * check passes and a 503 problem+json when a dependency is unreachable.
 */
@RestController
public class HealthController {

  private final ReadinessCheck readiness;

  public HealthController(ReadinessCheck readiness) {
    this.readiness = readiness;
  }

  @GetMapping("/healthz")
  public Map<String, String> healthz() {
    return Map.of("status", "ok");
  }

  @GetMapping("/readyz")
  public Map<String, String> readyz() {
    if (!readiness.isReady()) {
      throw new DomainException(ErrorCategory.UNAVAILABLE, "dependencies not ready");
    }
    return Map.of("status", "ready");
  }
}
