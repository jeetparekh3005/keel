// MessageBus selection (ADR-0025 section 3, "Broker selection"). The composition root calls this
// factory to bind the MESSAGE_BUS DI token. At most one broker may be gated: `KEEL_NATS_URL` (NATS
// JetStream), `KEEL_KAFKA_BROKERS` (Kafka), `KEEL_RABBITMQ_URL` (RabbitMQ). More than one set is an
// ambiguous misconfiguration that fails construction (fail-closed); none set -> the in-memory dev
// default. This mirrors the SecretProvider at-most-one selector (ADR-0024, secret-provider.factory).
//
// The broker adapters are subpath-only exports that each pull in a heavy client, so this factory is
// itself a subpath-only export (`@keel/core/messaging/message-bus.factory`) and is NOT re-exported
// from the main entry point: the default build stays broker-free, and a service loads the brokers
// only when it opts into selecting a bus. The InMemory default carries no broker client.
import { type MessageBus } from './index.js';
import { KafkaMessageBus } from './kafka.js';
import { InMemoryMessageBus } from './memory.js';
import { NatsMessageBus } from './nats.js';
import { RabbitMqMessageBus } from './rabbitmq.js';

/** A trimmed env value, or undefined when unset or whitespace-only (so a blank var reads as unset). */
function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/** Split a comma-separated env value into trimmed, non-empty entries; `fallback` when none remain. */
function splitCsv(value: string | undefined, fallback: string[]): string[] {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : fallback;
}

/**
 * Select the MessageBus from the environment (ADR-0025 gating). Exactly one gating var selects its
 * broker adapter, each built from its documented keys (fail-closed); two or more reject ("multiple
 * message bus backends configured"); none selects the in-memory dev default. Construction only -
 * the composition root calls the adapter's `connect()`. The MESSAGE_BUS DI token is bound by the
 * service composition root; this factory is what that root calls.
 */
export function messageBusFromEnv(env: NodeJS.ProcessEnv = process.env): MessageBus {
  const nats = trimmed(env['KEEL_NATS_URL']);
  const kafka = trimmed(env['KEEL_KAFKA_BROKERS']);
  const rabbitmq = trimmed(env['KEEL_RABBITMQ_URL']);
  const configured = [nats, kafka, rabbitmq].filter((v) => v !== undefined);
  if (configured.length > 1) {
    throw new Error(
      'messageBusFromEnv: multiple message bus backends configured (set at most one of KEEL_NATS_URL, KEEL_KAFKA_BROKERS, KEEL_RABBITMQ_URL)',
    );
  }
  if (nats !== undefined) {
    return new NatsMessageBus(nats, {
      stream: trimmed(env['KEEL_NATS_STREAM']) ?? 'keel',
      subjects: splitCsv(env['KEEL_NATS_SUBJECTS'], ['keel.>']),
    });
  }
  if (kafka !== undefined) {
    return new KafkaMessageBus({
      brokers: splitCsv(kafka, []),
      topics: splitCsv(env['KEEL_KAFKA_TOPICS'], ['keel']),
      groupId: trimmed(env['KEEL_KAFKA_GROUP_ID']) ?? 'keel',
      dlqTopic: trimmed(env['KEEL_KAFKA_DLQ_TOPIC']) ?? '',
    });
  }
  if (rabbitmq !== undefined) {
    return new RabbitMqMessageBus(rabbitmq, {
      exchange: trimmed(env['KEEL_RABBITMQ_EXCHANGE']) ?? 'keel',
      queue: trimmed(env['KEEL_RABBITMQ_QUEUE']) ?? 'keel',
      subjects: splitCsv(env['KEEL_RABBITMQ_SUBJECTS'], ['keel.#']),
      dlx: trimmed(env['KEEL_RABBITMQ_DLX']) ?? 'keel.dlx',
    });
  }
  return new InMemoryMessageBus();
}
