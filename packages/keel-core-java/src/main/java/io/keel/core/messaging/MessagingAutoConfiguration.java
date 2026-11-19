package io.keel.core.messaging;

import io.keel.core.adapters.messaging.NatsMessageBus;
import io.keel.core.adapters.messaging.RabbitMqMessageBus;
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
 * Wires a {@link MessageBus} only when a broker is configured (ADR-0012, ADR-0025). Each adapter is
 * gated per-bean on its own URL property, so a service with no broker is unaffected and the
 * application context still starts; this mirrors the Python vertical, where the bus is wired only
 * when its URL is present. A connection is opened lazily on first publish/subscribe (not at context
 * refresh), so merely configuring a broker never blocks startup; it is drained via the {@code
 * close} destroy method at shutdown.
 *
 * <p>Both beans carry {@code @ConditionalOnMissingBean(MessageBus.class)}; the fail-closed
 * at-most-one broker selector across NATS/Kafka/RabbitMQ is a later slice (ADR-0025), so this class
 * only parallels the conditional beans.
 */
@AutoConfiguration
@EnableConfigurationProperties(KeelProperties.class)
public class MessagingAutoConfiguration {

  /**
   * Build and expose the NATS JetStream bus. It connects lazily on first use; {@code destroyMethod
   * = "close"} drains the connection at shutdown. The OpenTelemetry bean supplies the W3C
   * propagator so published messages carry the trace context and consumers continue the publisher's
   * trace.
   */
  @Bean(destroyMethod = "close")
  @ConditionalOnClass({NatsMessageBus.class, OpenTelemetry.class})
  @ConditionalOnProperty(prefix = "keel", name = "nats-url")
  @ConditionalOnMissingBean(MessageBus.class)
  public MessageBus natsMessageBus(KeelProperties properties, OpenTelemetry openTelemetry) {
    return new NatsMessageBus(
        properties.natsUrl(), properties.natsStream(), properties.natsSubjects(), openTelemetry);
  }

  /**
   * Build and expose the RabbitMQ bus (ADR-0025). Gated on {@code keel.rabbitmq-url} (env {@code
   * KEEL_RABBITMQ_URL}) exactly as the NATS bean is gated on its URL. It connects lazily on first
   * use; {@code destroyMethod = "close"} drains the connection at shutdown. The OpenTelemetry bean
   * supplies the W3C propagator so published messages carry the trace context and consumers
   * continue the publisher's trace.
   */
  @Bean(destroyMethod = "close")
  @ConditionalOnClass({RabbitMqMessageBus.class, OpenTelemetry.class})
  @ConditionalOnProperty(prefix = "keel", name = "rabbitmq-url")
  @ConditionalOnMissingBean(MessageBus.class)
  public MessageBus rabbitMqMessageBus(KeelProperties properties, OpenTelemetry openTelemetry) {
    return new RabbitMqMessageBus(
        properties.rabbitmqUrl(),
        properties.rabbitmqExchange(),
        properties.rabbitmqQueue(),
        properties.rabbitmqDlx(),
        properties.rabbitmqSubjects(),
        openTelemetry);
  }
}
