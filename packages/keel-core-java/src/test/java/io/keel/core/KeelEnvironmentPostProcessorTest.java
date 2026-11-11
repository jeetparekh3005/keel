package io.keel.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

/**
 * Guards the KEEL_* -> Spring property bridging. Notably it pins the OTLP endpoint to the Boot 4
 * property name: the v0.4 remediation review found it was bridged to the Boot 3 name
 * (management.otlp.tracing.endpoint), which Boot 4 removed, so span export was silently dead.
 */
class KeelEnvironmentPostProcessorTest {

  private static StandardEnvironment environmentWith(Map<String, Object> vars) {
    StandardEnvironment environment = new StandardEnvironment();
    environment.getPropertySources().addFirst(new MapPropertySource("test-env", vars));
    new KeelEnvironmentPostProcessor().postProcessEnvironment(environment, new SpringApplication());
    return environment;
  }

  @Test
  void bridgesOtlpEndpointToTheBoot4ExportProperty() {
    StandardEnvironment environment =
        environmentWith(Map.of("KEEL_OTLP_ENDPOINT", "http://collector:4318"));
    assertEquals(
        "http://collector:4318",
        environment.getProperty("management.opentelemetry.tracing.export.otlp.endpoint"));
    // The removed Boot 3 name must not be the one we set.
    assertNull(environment.getProperty("management.otlp.tracing.endpoint"));
  }

  @Test
  void doesNotSetTheOtlpEndpointWhenUnset() {
    StandardEnvironment environment = environmentWith(Map.of());
    assertNull(environment.getProperty("management.opentelemetry.tracing.export.otlp.endpoint"));
  }

  @Test
  void bridgesPortAndLogLevelAndServiceName() {
    StandardEnvironment environment =
        environmentWith(
            Map.of(
                "KEEL_PORT", "9000",
                "KEEL_LOG_LEVEL", "debug",
                "KEEL_SERVICE_NAME", "svc"));
    assertEquals("9000", environment.getProperty("server.port"));
    assertEquals("debug", environment.getProperty("logging.level.root"));
    assertEquals("svc", environment.getProperty("spring.application.name"));
  }

  @Test
  void enablesStructuredJsonLoggingByDefault() {
    StandardEnvironment environment = environmentWith(Map.of());
    assertEquals("ecs", environment.getProperty("logging.structured.format.console"));
  }
}
