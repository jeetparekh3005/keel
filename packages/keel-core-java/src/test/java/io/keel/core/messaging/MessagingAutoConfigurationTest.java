package io.keel.core.messaging;

import static org.assertj.core.api.Assertions.assertThat;

import io.keel.core.adapters.messaging.KafkaMessageBus;
import io.keel.core.adapters.messaging.NatsMessageBus;
import io.keel.core.adapters.messaging.RabbitMqMessageBus;
import io.keel.core.ports.messaging.MessageBus;
import io.opentelemetry.api.OpenTelemetry;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Covers the fail-closed at-most-one {@link MessageBus} selector (ADR-0025 section 3), the
 * message-bus analogue of the at-most-one secret-backend selector (ADR-0024). None of the three
 * gating properties set wires no bus; exactly one wires that broker's adapter; more than one is an
 * ambiguous misconfiguration that fails the context at startup rather than letting bean ordering
 * silently pick one. The adapters connect lazily (on first publish/subscribe), so constructing a
 * bus here opens no socket and the tests stay hermetic.
 */
class MessagingAutoConfigurationTest {

  private final ApplicationContextRunner runner =
      new ApplicationContextRunner()
          .withConfiguration(AutoConfigurations.of(MessagingAutoConfiguration.class))
          .withUserConfiguration(StubBeans.class);

  @Test
  void noBrokerConfiguredWiresNoBus() {
    runner.run(context -> {
      assertThat(context).hasNotFailed();
      assertThat(context).doesNotHaveBean(MessageBus.class);
    });
  }

  @Test
  void natsUrlAloneWiresNatsBus() {
    runner
        .withPropertyValues("keel.nats-url=nats://localhost:4222")
        .run(context -> {
          assertThat(context).hasSingleBean(MessageBus.class);
          assertThat(context.getBean(MessageBus.class)).isInstanceOf(NatsMessageBus.class);
        });
  }

  @Test
  void kafkaBrokersAloneWiresKafkaBus() {
    runner
        .withPropertyValues("keel.kafka-brokers=localhost:9092")
        .run(context -> {
          assertThat(context).hasSingleBean(MessageBus.class);
          assertThat(context.getBean(MessageBus.class)).isInstanceOf(KafkaMessageBus.class);
        });
  }

  @Test
  void rabbitmqUrlAloneWiresRabbitMqBus() {
    runner
        .withPropertyValues("keel.rabbitmq-url=amqp://localhost:5672")
        .run(context -> {
          assertThat(context).hasSingleBean(MessageBus.class);
          assertThat(context.getBean(MessageBus.class)).isInstanceOf(RabbitMqMessageBus.class);
        });
  }

  @Test
  void natsAndRabbitmqBothSetFailsClosedAtStartup() {
    // Fail-closed: two gates set is ambiguous and must refuse to start rather than silently
    // preferring one bus by bean ordering.
    runner
        .withPropertyValues(
            "keel.nats-url=nats://localhost:4222", "keel.rabbitmq-url=amqp://localhost:5672")
        .run(context -> {
          assertThat(context).hasFailed();
          assertThat(context.getStartupFailure())
              .rootCause()
              .isInstanceOf(IllegalStateException.class)
              .hasMessageContaining("multiple message bus backends configured")
              .hasMessageContaining("keel.nats-url")
              .hasMessageContaining("keel.kafka-brokers")
              .hasMessageContaining("keel.rabbitmq-url");
        });
  }

  @Test
  void natsAndKafkaBothSetFailsClosedAtStartup() {
    runner
        .withPropertyValues(
            "keel.nats-url=nats://localhost:4222", "keel.kafka-brokers=localhost:9092")
        .run(context -> {
          assertThat(context).hasFailed();
          assertThat(context.getStartupFailure())
              .rootCause()
              .isInstanceOf(IllegalStateException.class)
              .hasMessageContaining("multiple message bus backends configured");
        });
  }

  @Test
  void kafkaAndRabbitmqBothSetFailsClosedAtStartup() {
    runner
        .withPropertyValues(
            "keel.kafka-brokers=localhost:9092", "keel.rabbitmq-url=amqp://localhost:5672")
        .run(context -> {
          assertThat(context).hasFailed();
          assertThat(context.getStartupFailure())
              .rootCause()
              .isInstanceOf(IllegalStateException.class)
              .hasMessageContaining("multiple message bus backends configured");
        });
  }

  @Test
  void allThreeSetFailsClosedAtStartup() {
    runner
        .withPropertyValues(
            "keel.nats-url=nats://localhost:4222",
            "keel.kafka-brokers=localhost:9092",
            "keel.rabbitmq-url=amqp://localhost:5672")
        .run(context -> {
          assertThat(context).hasFailed();
          assertThat(context.getStartupFailure())
              .rootCause()
              .isInstanceOf(IllegalStateException.class)
              .hasMessageContaining("multiple message bus backends configured");
        });
  }

  /** The sole collaborator the bus adapters need: the trace-propagating OpenTelemetry. */
  @Configuration(proxyBeanMethods = false)
  static class StubBeans {

    @Bean
    OpenTelemetry openTelemetry() {
      return OpenTelemetry.noop();
    }
  }
}
