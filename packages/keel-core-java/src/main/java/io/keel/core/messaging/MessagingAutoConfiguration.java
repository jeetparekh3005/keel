package io.keel.core.messaging;

import io.keel.core.adapters.messaging.NatsMessageBus;
import io.keel.core.config.KeelProperties;
import io.keel.core.ports.messaging.MessageBus;
import io.opentelemetry.api.OpenTelemetry;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

/**
 * Wires the NATS JetStream {@link MessageBus} only when a broker is configured (ADR-0012, epic #419
 * v0.6 parity). The bean is conditional on {@code keel.nats-url} (env {@code KEEL_NATS_URL}), so a
 * service with no broker is unaffected and the application context still starts; this mirrors the
 * Python vertical, where the NATS adapter is wired only when the URL is present. The connection is
 * opened lazily on first publish/subscribe (not at context refresh), so merely configuring a broker
 * never blocks startup; it is drained via the {@code close} destroy method at shutdown.
 */
@AutoConfiguration
@ConditionalOnClass({NatsMessageBus.class, OpenTelemetry.class})
@ConditionalOnProperty(prefix = "keel", name = "nats-url")
@EnableConfigurationProperties(KeelProperties.class)
public class MessagingAutoConfiguration {

  /**
   * Build and expose the NATS JetStream bus. It connects lazily on first use; {@code destroyMethod
   * = "close"} drains the connection at shutdown. The OpenTelemetry bean supplies the W3C
   * propagator so published messages carry the trace context and consumers continue the publisher's
   * trace.
   */
  @Bean(destroyMethod = "close")
  @ConditionalOnMissingBean(MessageBus.class)
  public MessageBus natsMessageBus(KeelProperties properties, OpenTelemetry openTelemetry) {
    return new NatsMessageBus(
        properties.natsUrl(), properties.natsStream(), properties.natsSubjects(), openTelemetry);
  }
}
