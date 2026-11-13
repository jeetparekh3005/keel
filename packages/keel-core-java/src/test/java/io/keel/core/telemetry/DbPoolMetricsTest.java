package io.keel.core.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tags;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.concurrent.atomic.AtomicInteger;
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
}
