package io.keel.reference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.registry.otlp.OtlpMeterRegistry;
import java.sql.Connection;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * Proves the HikariCP connection pool exports DB saturation under the OpenTelemetry database
 * semantic-convention names, bound to the OTLP export registry (parity epic #419). Gated on
 * KEEL_TEST_DATABASE_URL (a real Postgres, supplied in CI) because the Hikari gauges register only
 * once the pool initializes; the test forces initialization with a real connection, then asserts
 * {@code db.client.connection.count} (states used + idle) and {@code db.client.connection.max}
 * exist, each carrying {@code db.client.connection.pool.name}. The assertions fail if the keel-core
 * MeterFilter mapping, the pool-name setting, or the OTLP registry dependency is removed.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
      // Force the OTLP meter registry on (gated off by default without a collector) so its binding
      // can be asserted; the URL is never actually dialed in the test.
      "management.otlp.metrics.export.enabled=true",
      "management.otlp.metrics.export.url=http://localhost:4318/v1/metrics",
      "management.otlp.metrics.export.step=1s"
    })
@Import(ReferenceServiceConformanceTest.StubAuthConfig.class)
@EnabledIfEnvironmentVariable(named = "KEEL_TEST_DATABASE_URL", matches = ".+")
class ReferenceServiceDbPoolMetricsTest {

  @Autowired MeterRegistry meterRegistry;

  @Autowired DataSource dataSource;

  @Autowired ApplicationContext applicationContext;

  @DynamicPropertySource
  static void databaseUrl(DynamicPropertyRegistry registry) {
    registry.add("keel.database-url", () -> System.getenv("KEEL_TEST_DATABASE_URL"));
  }

  @Test
  void exportsDbPoolSaturationUnderOtelSemanticConventionNames() throws Exception {
    // Force the Hikari pool to initialize so its connection gauges are registered (and so renamed
    // by the keel-core MeterFilter at registration time).
    try (Connection connection = dataSource.getConnection()) {
      assertTrue(connection.isValid(2), "test database connection was not valid");
    }

    Gauge used =
        meterRegistry
            .find("db.client.connection.count")
            .tag("db.client.connection.state", "used")
            .gauge();
    assertNotNull(
        used,
        "no db.client.connection.count{state=used} gauge - the Hikari-to-OTel mapping or the pool"
            + " metrics binding is missing");

    Gauge idle =
        meterRegistry
            .find("db.client.connection.count")
            .tag("db.client.connection.state", "idle")
            .gauge();
    assertNotNull(idle, "no db.client.connection.count{state=idle} gauge");

    Gauge max = meterRegistry.find("db.client.connection.max").gauge();
    assertNotNull(max, "no db.client.connection.max gauge (the saturation denominator)");
    assertTrue(max.value() >= 1.0, "max pool size gauge should be positive, got " + max.value());

    // Every series carries the pool name (deterministic because DataSourceFactory sets it), so a
    // multi-pool service would not collapse onto one series.
    assertEquals(
        "default",
        used.getId().getTag("db.client.connection.pool.name"),
        "db.client.connection.count is not tagged with the configured pool name");
    assertEquals(
        "default",
        max.getId().getTag("db.client.connection.pool.name"),
        "db.client.connection.max is not tagged with the configured pool name");

    // The OTLP export registry is bound; removing the dependency fails here (metrics would be
    // recorded but never exported).
    assertTrue(
        applicationContext.getBeanNamesForType(OtlpMeterRegistry.class).length > 0,
        "no OtlpMeterRegistry bean - DB pool metrics are recorded but not exported over OTLP");
  }
}
