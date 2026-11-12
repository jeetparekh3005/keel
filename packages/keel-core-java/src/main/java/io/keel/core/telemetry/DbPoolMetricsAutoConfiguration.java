package io.keel.core.telemetry;

import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tag;
import io.micrometer.core.instrument.config.MeterFilter;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.context.annotation.Bean;

/**
 * Renames Boot/Micrometer's HikariCP connection-pool gauges to the OpenTelemetry database
 * semantic-convention names so the OTLP export carries the cross-vertical saturation identities
 * (parity epic #419), matching what the Python, Go, Rust, and TypeScript verticals emit.
 *
 * <p>Micrometer auto-binds {@code hikaricp.connections.*} gauges off the pool's MXBean once a
 * {@link MeterRegistry} is present and the pool is initialized. This maps them to the semconv
 * shape:
 *
 * <ul>
 *   <li>{@code hikaricp.connections.active} (checked-out connections) becomes {@code
 *       db.client.connection.count} tagged {@code db.client.connection.state=used};
 *   <li>{@code hikaricp.connections.idle} becomes {@code db.client.connection.count} tagged {@code
 *       db.client.connection.state=idle} - the two share one metric name as distinct series;
 *   <li>{@code hikaricp.connections.max} becomes {@code db.client.connection.max}, the saturation
 *       denominator.
 * </ul>
 *
 * <p>On every mapped meter Hikari's {@code pool} tag is rewritten to the semconv {@code
 * db.client.connection.pool.name} attribute (the pool name {@code DataSourceFactory} sets), so a
 * service with multiple pools keeps distinct series. A {@link MeterFilter} is applied to every
 * registry in the context (the OTLP registry and any test registry alike), so what a test asserts
 * is exactly what is exported - mirroring {@link HttpServerMetricsAutoConfiguration}.
 */
@AutoConfiguration
@ConditionalOnClass(MeterRegistry.class)
public class DbPoolMetricsAutoConfiguration {

  static final String HIKARI_ACTIVE = "hikaricp.connections.active";
  static final String HIKARI_IDLE = "hikaricp.connections.idle";
  static final String HIKARI_MAX = "hikaricp.connections.max";
  static final String HIKARI_POOL_TAG = "pool";

  static final String OTEL_CONNECTION_COUNT = "db.client.connection.count";
  static final String OTEL_CONNECTION_MAX = "db.client.connection.max";
  static final String STATE_TAG = "db.client.connection.state";
  static final String POOL_NAME_TAG = "db.client.connection.pool.name";
  static final String STATE_USED = "used";
  static final String STATE_IDLE = "idle";

  @Bean
  public MeterFilter dbPoolMetricsOtelNaming() {
    return new MeterFilter() {
      @Override
      public Meter.Id map(Meter.Id id) {
        return switch (id.getName()) {
          case HIKARI_ACTIVE -> toCount(id, STATE_USED);
          case HIKARI_IDLE -> toCount(id, STATE_IDLE);
          case HIKARI_MAX -> id.withName(OTEL_CONNECTION_MAX).replaceTags(poolNameTags(id));
          default -> id;
        };
      }
    };
  }

  private static Meter.Id toCount(Meter.Id id, String state) {
    List<Tag> tags = poolNameTags(id);
    tags.add(Tag.of(STATE_TAG, state));
    return id.withName(OTEL_CONNECTION_COUNT).replaceTags(tags);
  }

  // Rewrite Hikari's `pool` tag to the OTel `db.client.connection.pool.name` attribute, preserving
  // every other tag unchanged so multi-pool services do not collapse onto one series.
  private static List<Tag> poolNameTags(Meter.Id id) {
    List<Tag> tags = new ArrayList<>();
    for (Tag tag : id.getTags()) {
      if (HIKARI_POOL_TAG.equals(tag.getKey())) {
        tags.add(Tag.of(POOL_NAME_TAG, tag.getValue()));
      } else {
        tags.add(tag);
      }
    }
    return tags;
  }
}
