// Unit tests for the MessageBus selection factory (ADR-0025 section 3, "Broker selection"). Mirrors
// secret-provider.factory.spec.ts: exactly one gating var selects its adapter, none selects the
// in-memory dev default, and more than one fails closed. Broker-free - the factory only constructs
// adapters (no connect()), so no running NATS/Kafka/RabbitMQ broker is needed.
import { describe, expect, it } from 'vitest';

import { KafkaMessageBus } from './kafka.js';
import { InMemoryMessageBus } from './memory.js';
import { messageBusFromEnv } from './message-bus.factory.js';
import { NatsMessageBus } from './nats.js';
import { RabbitMqMessageBus } from './rabbitmq.js';

describe('messageBusFromEnv (selection)', () => {
  it('returns the InMemoryMessageBus when no broker is gated', () => {
    expect(messageBusFromEnv({})).toBeInstanceOf(InMemoryMessageBus);
  });

  it('ignores unrelated and whitespace-only vars and still returns the in-memory default', () => {
    // A whitespace-only gate reads as unset, so no broker is selected.
    const bus = messageBusFromEnv({ KEEL_NATS_URL: '   ', SOMETHING_ELSE: 'x' });
    expect(bus).toBeInstanceOf(InMemoryMessageBus);
  });

  it('selects the NATS adapter when KEEL_NATS_URL is set', () => {
    const bus = messageBusFromEnv({
      KEEL_NATS_URL: 'nats://127.0.0.1:4222',
      KEEL_NATS_STREAM: 'orders',
      KEEL_NATS_SUBJECTS: 'keel.orders.>,keel.audit.>',
    });
    expect(bus).toBeInstanceOf(NatsMessageBus);
  });

  it('selects the Kafka adapter when KEEL_KAFKA_BROKERS is set', () => {
    const bus = messageBusFromEnv({
      KEEL_KAFKA_BROKERS: 'broker-1:9092,broker-2:9092',
      KEEL_KAFKA_TOPICS: 'keel.orders',
      KEEL_KAFKA_GROUP_ID: 'orders',
      KEEL_KAFKA_DLQ_TOPIC: 'keel.dlq',
    });
    expect(bus).toBeInstanceOf(KafkaMessageBus);
  });

  it('selects the RabbitMQ adapter when KEEL_RABBITMQ_URL is set', () => {
    const bus = messageBusFromEnv({
      KEEL_RABBITMQ_URL: 'amqp://127.0.0.1:5672',
      KEEL_RABBITMQ_EXCHANGE: 'orders',
      KEEL_RABBITMQ_QUEUE: 'orders',
      KEEL_RABBITMQ_DLX: 'orders.dlx',
      KEEL_RABBITMQ_SUBJECTS: 'keel.orders.#',
    });
    expect(bus).toBeInstanceOf(RabbitMqMessageBus);
  });

  it('selects each adapter from gates alone, with all other keys defaulted', () => {
    expect(messageBusFromEnv({ KEEL_NATS_URL: 'nats://127.0.0.1:4222' })).toBeInstanceOf(
      NatsMessageBus,
    );
    expect(messageBusFromEnv({ KEEL_KAFKA_BROKERS: 'broker:9092' })).toBeInstanceOf(
      KafkaMessageBus,
    );
    expect(messageBusFromEnv({ KEEL_RABBITMQ_URL: 'amqp://127.0.0.1:5672' })).toBeInstanceOf(
      RabbitMqMessageBus,
    );
  });

  it('fails closed when NATS and Kafka are both configured', () => {
    expect(() =>
      messageBusFromEnv({
        KEEL_NATS_URL: 'nats://127.0.0.1:4222',
        KEEL_KAFKA_BROKERS: 'broker:9092',
      }),
    ).toThrow(/multiple message bus backends configured/);
  });

  it('fails closed when Kafka and RabbitMQ are both configured', () => {
    expect(() =>
      messageBusFromEnv({
        KEEL_KAFKA_BROKERS: 'broker:9092',
        KEEL_RABBITMQ_URL: 'amqp://127.0.0.1:5672',
      }),
    ).toThrow(/multiple message bus backends configured/);
  });

  it('fails closed when all three brokers are configured', () => {
    expect(() =>
      messageBusFromEnv({
        KEEL_NATS_URL: 'nats://127.0.0.1:4222',
        KEEL_KAFKA_BROKERS: 'broker:9092',
        KEEL_RABBITMQ_URL: 'amqp://127.0.0.1:5672',
      }),
    ).toThrow(/set at most one of KEEL_NATS_URL, KEEL_KAFKA_BROKERS, KEEL_RABBITMQ_URL/);
  });
});
