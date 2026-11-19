package io.keel.core.messaging;

import io.keel.core.adapters.messaging.KafkaMessageBus;
import io.keel.core.adapters.messaging.NatsMessageBus;
import io.keel.core.adapters.messaging.RabbitMqMessageBus;
import io.keel.core.config.KeelProperties;
import io.keel.core.ports.messaging.MessageBus;
import io.opentelemetry.api.OpenTelemetry;
import java.util.List;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.util.StringUtils;

/**
 * Wires a {@link MessageBus} only when a broker is configured (ADR-0012, ADR-0025). Each adapter is
 * gated per-bean on its own URL property, so a service with no broker is unaffected and the
 * application context still starts; this mirrors the Python vertical, where the bus is wired only
 * when its URL is present. A connection is opened lazily on first publish/subscribe (not at context
 * refresh), so merely configuring a broker never blocks startup; it is drained via the {@code
 * close} destroy method at shutdown.
 *
 * <p>Broker selection is fail-closed and at-most-one (ADR-0025 section 3), mirroring the
 * at-most-one secret-backend selector ({@link io.keel.core.KeelCoreAutoConfiguration#secretProvider
 * secretProvider}, ADR-0024). An operator may set at most one of {@code keel.nats-url} ({@code
 * KEEL_NATS_URL}), {@code keel.kafka-brokers} ({@code KEEL_KAFKA_BROKERS}), and {@code
 * keel.rabbitmq-url} ({@code KEEL_RABBITMQ_URL}); setting more than one is an ambiguous
 * misconfiguration that fails the application context at startup rather than letting bean ordering
 * silently pick one. Each conditional bean therefore runs {@link #requireAtMostOneBroker} before
 * constructing its adapter: with two or more gating properties set, exactly one of the three beans
 * survives {@code @ConditionalOnMissingBean(MessageBus.class)}, and its factory throws before any
 * bus is built. None set wires no bus (a service may supply its own or use none); exactly one wires
 * that bus, unchanged.
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
    requireAtMostOneBroker(properties);
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
    requireAtMostOneBroker(properties);
    return new RabbitMqMessageBus(
        properties.rabbitmqUrl(),
        properties.rabbitmqExchange(),
        properties.rabbitmqQueue(),
        properties.rabbitmqDlx(),
        properties.rabbitmqSubjects(),
        openTelemetry);
  }

  /**
   * Build and expose the Kafka bus (ADR-0025). Gated on {@code keel.kafka-brokers} (env {@code
   * KEEL_KAFKA_BROKERS}) exactly as the NATS and RabbitMQ beans are gated on their URL. It connects
   * lazily on first use; {@code destroyMethod = "close"} drains the clients at shutdown. The
   * OpenTelemetry bean supplies the W3C propagator so published messages carry the trace context
   * and consumers continue the publisher's trace.
   */
  @Bean(destroyMethod = "close")
  @ConditionalOnClass({KafkaMessageBus.class, OpenTelemetry.class})
  @ConditionalOnProperty(prefix = "keel", name = "kafka-brokers")
  @ConditionalOnMissingBean(MessageBus.class)
  public MessageBus kafkaMessageBus(KeelProperties properties, OpenTelemetry openTelemetry) {
    requireAtMostOneBroker(properties);
    return new KafkaMessageBus(
        properties.kafkaBrokers(),
        properties.kafkaTopics(),
        properties.kafkaGroupId(),
        properties.kafkaDlqTopic(),
        openTelemetry);
  }

  /**
   * Fail-closed at-most-one broker guard (ADR-0025 section 3), the message-bus analogue of the
   * at-most-one secret-backend check (ADR-0024). Counts the configured gating properties - {@code
   * keel.nats-url}, {@code keel.kafka-brokers}, {@code keel.rabbitmq-url} - treating a blank /
   * whitespace-only URL (and an empty or all-blank broker list) as unset, and throws when more than
   * one is set so the context fails at startup rather than silently preferring one bus. Called from
   * each conditional bean factory: with two or more gates set, exactly one bean survives
   * {@code @ConditionalOnMissingBean(MessageBus.class)} and throws here before constructing its
   * adapter.
   */
  static void requireAtMostOneBroker(KeelProperties properties) {
    int configured = 0;
    if (StringUtils.hasText(properties.natsUrl())) {
      configured++;
    }
    if (hasBroker(properties.kafkaBrokers())) {
      configured++;
    }
    if (StringUtils.hasText(properties.rabbitmqUrl())) {
      configured++;
    }
    if (configured > 1) {
      throw new IllegalStateException(
          "multiple message bus backends configured: set at most one of keel.nats-url,"
              + " keel.kafka-brokers, keel.rabbitmq-url");
    }
  }

  private static boolean hasBroker(List<String> brokers) {
    return brokers != null && brokers.stream().anyMatch(StringUtils::hasText);
  }
}
