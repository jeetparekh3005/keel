package io.keel.core.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.Mockito.mock;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.metrics.micrometer.MicrometerMetricsTrackerFactory;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tags;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

/**
 * Proves the DB-pool MeterFilter maps Micrometer's HikariCP gauges onto the OpenTelemetry database
 * semantic-convention names and attributes. Self-contained: it registers gauges with the exact
 * names/tags Micrometer's Hikari binder produces ({@code hikaricp.connections.active|idle|max}
 * tagged {@code pool}) against a registry carrying the filter, then asserts the semconv shape. The
 * assertions fail if the mapping or the pool-tag rewrite is removed (the default no-op would leave
 * the Hikari names and the {@code pool} tag in place and emit no {@code db.client.connection.*}).
 */
class DbPoolMetricsTest {

  @Test
  void mapsHikariGaugesToOtelSemconvNamesTaggedByPoolAndState() {
    MeterRegistry registry = new SimpleMeterRegistry();
    registry.config().meterFilter(new DbPoolMetricsAutoConfiguration().dbPoolMetricsOtelNaming());

    AtomicInteger active = new AtomicInteger(3);
    AtomicInteger idle = new AtomicInteger(7);
    AtomicInteger max = new AtomicInteger(10);
    Tags pool = Tags.of("pool", "default");
    Gauge.builder("hikaricp.connections.active", active, AtomicInteger::doubleValue)
        .tags(pool)
        .register(registry);
    Gauge.builder("hikaricp.connections.idle", idle, AtomicInteger::doubleValue)
        .tags(pool)
        .register(registry);
    Gauge.builder("hikaricp.connections.max", max, AtomicInteger::doubleValue)
        .tags(pool)
        .register(registry);

    Gauge used =
        registry
            .find("db.client.connection.count")
            .tag("db.client.connection.state", "used")
            .tag("db.client.connection.pool.name", "default")
            .gauge();
    assertNotNull(
        used, "active connections not remapped to db.client.connection.count{state=used}");
    assertEquals(3.0, used.value());

    Gauge idleGauge =
        registry
            .find("db.client.connection.count")
            .tag("db.client.connection.state", "idle")
            .tag("db.client.connection.pool.name", "default")
            .gauge();
    assertNotNull(
        idleGauge, "idle connections not remapped to db.client.connection.count{state=idle}");
    assertEquals(7.0, idleGauge.value());

    Gauge maxGauge =
        registry
            .find("db.client.connection.max")
            .tag("db.client.connection.pool.name", "default")
            .gauge();
    assertNotNull(maxGauge, "max connections not remapped to db.client.connection.max");
    assertEquals(10.0, maxGauge.value());

    // Renamed, not duplicated: the Hikari name is gone once the filter has mapped it.
    assertNull(
        registry.find("hikaricp.connections.active").gauge(),
        "Hikari gauge should be renamed to the OTel semconv name, not left in place");
    // The Hikari `pool` tag must be rewritten to the semconv attribute, not retained.
    assertNull(
        registry.find("db.client.connection.max").tag("pool", "default").gauge(),
        "the Hikari `pool` tag must be rewritten to db.client.connection.pool.name");
  }

  @Test
  void realHikariBinderGaugesAreRemappedToOtelSemconv() {
    // Non-gated proof that the filter works against the ACTUAL Micrometer HikariCP binder, not just
    // hand-registered gauges: a real HikariDataSource registers its pool-state gauges off the pool
    // MXBean through MicrometerMetricsTrackerFactory. No live DB is needed - the pool is started
    // with initializationFailTimeout=-1 over a stub DataSource, so no connection is attempted, yet
    // the hikaricp.connections.* gauges are registered and the filter remaps them on sight.
    MeterRegistry registry = new SimpleMeterRegistry();
    registry.config().meterFilter(new DbPoolMetricsAutoConfiguration().dbPoolMetricsOtelNaming());

    HikariConfig config = new HikariConfig();
    config.setPoolName("default");
    config.setMaximumPoolSize(4);
    config.setMinimumIdle(0);
    config.setInitializationFailTimeout(-1); // start the pool without acquiring a connection
    config.setDataSource(mock(DataSource.class));
    config.setMetricsTrackerFactory(new MicrometerMetricsTrackerFactory(registry));

    try (HikariDataSource ignored = new HikariDataSource(config)) {
      assertNotNull(
          registry
              .find("db.client.connection.count")
              .tag("db.client.connection.state", "used")
              .tag("db.client.connection.pool.name", "default")
              .gauge(),
          "real binder's active gauge not remapped to db.client.connection.count{state=used}");
      assertNotNull(
          registry
              .find("db.client.connection.count")
              .tag("db.client.connection.state", "idle")
              .tag("db.client.connection.pool.name", "default")
              .gauge(),
          "real binder's idle gauge not remapped to db.client.connection.count{state=idle}");
      Gauge maxGauge =
          registry
              .find("db.client.connection.max")
              .tag("db.client.connection.pool.name", "default")
              .gauge();
      assertNotNull(maxGauge, "real binder's max gauge not remapped to db.client.connection.max");
      assertEquals(4.0, maxGauge.value());

      // The Hikari name is gone: the filter renamed it, it was not left in place alongside.
      assertNull(
          registry.find("hikaricp.connections.active").gauge(),
          "Hikari gauge from the real binder should be renamed, not duplicated");
    }
  }
}
