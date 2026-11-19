// Kafka MessageBus adapter (ADR-0025 parity with the Go Kafka adapter in
// packages/keel-core-go/messaging/kafka.go and the NATS/RabbitMQ adapters in ./nats and
// ./rabbitmq). Implements the MessageBus port over Kafka via kafkajs with a consumer group,
// auto-commit OFF, and durable at-least-once delivery.
//
// A subject maps to a Kafka topic (non-alphanumeric sanitized exactly as the NATS durable-name
// sanitizer does), publishing produces to that topic, and consumption runs through a consumer group
// so the record's offset is committed only after the handler acks. The delivery contract is
// identical to NATS/RabbitMQ: W3C trace context is injected into record headers on publish and
// re-attached around each handler; on handler failure below the cap the record is re-produced to a
// retry topic (<topic>.retry) with an incremented delivery-count header and the original offset
// committed so the partition is not head-of-line blocked, and at the cap it is produced to the
// dead-letter topic (<topic>.dlq) and committed, so a poison record neither loops forever nor is
// dropped silently. Kafka has no native per-message delivery count, so it travels in a portable
// keel-delivery-count record header. The subject->topic mapping is a lossy sanitization (dots and
// other characters collapse to underscore), so a delivered record cannot recover the published
// subject from its topic name; the original subject travels explicitly in a keel-subject header, set
// on publish and read back on consume (falling back to the topic when absent, e.g. for a record from
// a non-keel producer). If the retry or dead-letter produce itself fails the original
// commit/retry/dead-letter decision is the shared pure disposition function, unit-testable without a
// broker.
//
// This module imports the optional `kafkajs` client and is NOT re-exported from @keel/core's main
// entry point: import it directly (`@keel/core/messaging/kafka`) only when a broker is configured,
// so services without a broker never load the client.
import { context as otelContext, propagation } from '@opentelemetry/api';
import {
  Kafka,
  logLevel,
  type Consumer,
  type IHeaders,
  type KafkaMessage,
  type Producer,
} from 'kafkajs';

import { createLogger } from '../logging/logger.js';
import { type InboundMessage, type MessageHandler } from './index.js';

/** Minimal structured logger surface used by the adapter (pino's Logger satisfies it). */
export interface BusLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The slice of a Kafka client the adapter needs: factories for a producer, a consumer, and an admin
 * client. It is an interface so the connectFn seam can supply a fake in a broker-free test; the real
 * kafkajs `Kafka` instance satisfies it structurally.
 */
export type KafkaFactory = Pick<Kafka, 'producer' | 'consumer' | 'admin'>;

/** Connection factory, overridable as a test seam; defaults to a real kafkajs client. */
export type ConnectFn = (config: { clientId: string; brokers: string[] }) => KafkaFactory;

/** The per-record disposition the delivery contract selects. */
export type Disposition = 'commit' | 'retry' | 'dead-letter';

/**
 * Pure delivery-contract decision (modelled on the Go adapter's `disposition`), factored out so the
 * commit/retry/dead-letter rule is unit-tested without a broker: commit on handler success; re-produce
 * to the retry topic (retry) while the delivery count is below the cap; dead-letter at the cap.
 */
export function disposition(ok: boolean, numDelivered: number, maxDeliver: number): Disposition {
  if (ok) {
    return 'commit';
  }
  if (numDelivered >= maxDeliver) {
    return 'dead-letter';
  }
  return 'retry';
}

/**
 * The portable redelivery count Kafka does not track natively; it is incremented each time a failed
 * record is re-produced to the retry topic.
 */
const DELIVERY_COUNT_HEADER = 'keel-delivery-count';

/**
 * Carries the ORIGINAL published subject. subject->topic sanitization is lossy, so the subject cannot
 * be recovered from the topic name; it is stamped here on publish and read back on consume. It rides
 * through the retry/dead-letter re-produce like keel-delivery-count and the trace headers.
 */
const SUBJECT_HEADER = 'keel-subject';

/** Suffixes naming the retry and dead-letter topics derived from a base topic. */
const RETRY_SUFFIX = '.retry';
const DLQ_SUFFIX = '.dlq';

// Kafka topics (like NATS durable names) allow only [A-Za-z0-9_]; the same sanitizer derives a
// stable, legal topic per subject, to which the .retry/.dlq suffixes append a legal dot.
const TOPIC_UNSAFE = /[^A-Za-z0-9_]/g;

/**
 * Sanitize `subject` to a legal topic, replacing every non-alphanumeric/underscore character (the
 * same rule the NATS adapter applies to durable names).
 */
export function topicName(subject: string): string {
  return subject.replace(TOPIC_UNSAFE, '_');
}

/** A record consumed from Kafka, flattened to the shape dispatch and the sink work with. */
export interface ConsumedRecord {
  topic: string;
  partition: number;
  offset: string;
  key: Buffer | null;
  value: Buffer;
  headers: Record<string, string>;
}

/** A record produced to a retry or dead-letter topic. */
export interface ProducedRecord {
  topic: string;
  key: Buffer | null;
  value: Buffer;
  headers: Record<string, string>;
}

/**
 * The sink dispatch drives: produce a record (to a retry or dead-letter topic) and commit a consumed
 * record's offset. An interface so a broker-free test can record produces and commits without a live
 * client (mirrors the Go adapter's recordSink).
 */
export interface RecordSink {
  produce(record: ProducedRecord): Promise<void>;
  commit(record: ConsumedRecord): Promise<void>;
}

/** Delivery policy and wiring for the topics the bus owns. */
export interface KafkaMessageBusOptions {
  /** Bootstrap servers (from the comma-separated KEEL_KAFKA_BROKERS); the gate for building a bus. */
  brokers: string[];
  /** Topics (subjects) the consumer group subscribes to (KEEL_KAFKA_TOPICS), defaulting to ['keel']. */
  topics?: string[];
  /** Consumer group (KEEL_KAFKA_GROUP_ID), defaulting to 'keel'. */
  groupId?: string;
  /**
   * Overrides the per-topic <topic>.dlq dead-letter destination with a single shared dead-letter
   * topic (KEEL_KAFKA_DLQ_TOPIC); empty keeps the per-topic default.
   */
  dlqTopic?: string;
  /** Redelivery cap before a failing record is dead-lettered. */
  maxDeliver?: number;
  /** kafkajs client id; defaults to 'keel'. */
  clientId?: string;
  /** Records retry/dead-letter decisions; defaults to an info-level JSON logger. */
  logger?: BusLogger;
  /** Overridable connection factory (test seam); defaults to a real kafkajs client. */
  connectFn?: ConnectFn;
}

/** A MessageBus backed by Kafka for durable at-least-once delivery. */
export class KafkaMessageBus {
  private readonly brokers: string[];
  private readonly topics: string[];
  private readonly groupId: string;
  private readonly dlq: string;
  private readonly maxDeliver: number;
  private readonly clientId: string;
  private readonly logger: BusLogger;
  private readonly connectFn: ConnectFn;
  private readonly handlers = new Map<string, MessageHandler>();
  private readonly subscribedTopics = new Set<string>();
  private kafka: KafkaFactory | undefined;
  private producer: Producer | undefined;
  private consumer: Consumer | undefined;
  private sink: RecordSink | undefined;
  private started = false;

  constructor(options: KafkaMessageBusOptions) {
    this.brokers = [...options.brokers];
    this.topics = options.topics && options.topics.length > 0 ? [...options.topics] : ['keel'];
    this.groupId = options.groupId ?? 'keel';
    this.dlq = options.dlqTopic ?? '';
    this.maxDeliver = options.maxDeliver ?? 5;
    this.clientId = options.clientId ?? 'keel';
    this.logger = options.logger ?? createLogger('info');
    this.connectFn = options.connectFn ?? defaultConnectFn;
  }

  /**
   * Pre-create the configured topics and their retry/dead-letter siblings (with leaders elected),
   * create the producer and consumer (consumer group, auto-commit off), connect them, and subscribe
   * the configured topics and their retry siblings so a published record is consumed (mirroring the
   * Go adapter's Connect, which pre-subscribes the configured topics). A connect failure is re-thrown
   * as a credential-free error: the broker list and any SASL config are never echoed into the error
   * or the logs, so credentials cannot leak.
   */
  async connect(): Promise<void> {
    const kafka = this.connectFn({ clientId: this.clientId, brokers: this.brokers });
    const producer = kafka.producer();
    const consumer = kafka.consumer({ groupId: this.groupId });
    try {
      // Create every topic the adapter touches (base + <topic>.retry + dead-letter) BEFORE the first
      // produce or fetch, waiting for leader election. See provisionTopics for the rationale.
      await this.provisionTopics(kafka, this.topicSpecs());
      await producer.connect();
      await consumer.connect();
    } catch {
      // Never echo brokers or SASL credentials into the error/logs - swallow the original.
      throw new Error('kafka connection failed');
    }
    this.kafka = kafka;
    this.producer = producer;
    this.consumer = consumer;
    this.sink = new KafkaJsSink(producer, consumer);
    // Pre-subscribe the configured topics (and their retry siblings) before the poll loop starts.
    for (const topic of this.topics) {
      await this.subscribeTopic(consumer, topicName(topic));
    }
  }

  /**
   * Pre-create `specs` (with leaders elected) via a short-lived admin client, so the first produce or
   * fetch does not race leader election on a freshly auto-created topic: kafkajs surfaces that as
   * "This server does not host this topic-partition" rather than retrying metadata the way franz-go
   * (Go) and aiokafka (Python) do, and waitForLeaders closes the race. createTopics is idempotent - it
   * resolves false when the topics already exist, which is fine; allowAutoTopicCreation on the client
   * stays on as a fallback. The admin client is provisioning-only and is dropped afterwards (a
   * disconnect error is swallowed so it cannot leak broker/SASL detail or mask a thrown error).
   */
  private async provisionTopics(kafka: KafkaFactory, specs: { topic: string }[]): Promise<void> {
    const admin = kafka.admin();
    try {
      await admin.connect();
      await admin.createTopics({ topics: specs, waitForLeaders: true });
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  }

  /**
   * The topics provisioned for a sanitized base topic `tn`: the base itself, its <topic>.retry
   * sibling, and its dead-letter destination (the KEEL_KAFKA_DLQ_TOPIC override when set, else
   * <topic>.dlq).
   */
  private topicSpecsFor(tn: string): { topic: string }[] {
    return [{ topic: tn }, { topic: tn + RETRY_SUFFIX }, { topic: this.dlqTopic(tn) }];
  }

  /**
   * The topics the adapter provisions on connect: the base, retry, and dead-letter topic for every
   * configured topic, de-duplicated so a shared KEEL_KAFKA_DLQ_TOPIC override is created once.
   */
  private topicSpecs(): { topic: string }[] {
    const topics = new Set<string>();
    for (const t of this.topics) {
      for (const spec of this.topicSpecsFor(topicName(t))) {
        topics.add(spec.topic);
      }
    }
    return [...topics].map((topic) => ({ topic }));
  }

  /** Subscribe `tn` and its retry sibling once (kafkajs permits subscribe() only when not running). */
  private async subscribeTopic(consumer: Consumer, tn: string): Promise<void> {
    if (this.subscribedTopics.has(tn)) {
      return;
    }
    this.subscribedTopics.add(tn);
    // fromBeginning:true so a fresh consumer group replays the backlog (earliest), matching the NATS
    // JetStream DeliverAll baseline and the Python/Java/Rust/Go adapters' earliest offset reset.
    await consumer.subscribe({ topics: [tn, tn + RETRY_SUFFIX], fromBeginning: true });
  }

  /** Start (or restart, after a dynamic subscribe) the poll loop, routing each record via dispatch. */
  private async runLoop(consumer: Consumer, sink: RecordSink): Promise<void> {
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        // A record on <topic>.retry is a retried delivery of the base topic; route it to the base
        // topic's handler so the retry loop converges on the same consumer.
        const base = topic.endsWith(RETRY_SUFFIX) ? topic.slice(0, -RETRY_SUFFIX.length) : topic;
        const h = this.handlers.get(base);
        if (!h) {
          return;
        }
        await this.dispatch(sink, toConsumedRecord(topic, partition, message), h);
      },
    });
  }

  /** Publish `payload` to the topic `subject` maps to, injecting the active trace context into headers. */
  async publish(
    subject: string,
    payload: Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<void> {
    const sink = this.requireSink('publish');
    const carrier: Record<string, string> = { ...(options?.headers ?? {}) };
    // Stamp the original subject so the consumer can recover it (the topic name is a lossy transform).
    carrier[SUBJECT_HEADER] = subject;
    // Serialize the active trace context (W3C `traceparent`/`tracestate`) into the carrier so a
    // consumer can continue the trace.
    propagation.inject(otelContext.active(), carrier);
    await sink.produce({
      topic: topicName(subject),
      key: null,
      value: Buffer.from(payload),
      headers: carrier,
    });
  }

  /**
   * Register `handler` for `subject`'s topic (and its retry sibling) and ensure that topic is actually
   * consumed. A record on <topic>.retry is a retried delivery routed back to the base topic's handler
   * so the retry loop converges on the same consumer.
   *
   * kafkajs forbids consumer.subscribe() while the poll loop is running, so a subject subscribed after
   * the loop started is added via the supported stop -> subscribe -> run cycle (the consumer retains
   * its existing subscriptions across stop), after provisioning the new topic and its retry/dead-letter
   * siblings. A late subscribe is therefore genuinely consumed, never silently black-holed - matching
   * the other four verticals, which add topics to a live consumer.
   */
  async subscribe(subject: string, handler: MessageHandler): Promise<void> {
    const consumer = this.requireConsumer('subscribe');
    const sink = this.sink as RecordSink;
    const kafka = this.kafka as KafkaFactory;
    const tn = topicName(subject);
    this.handlers.set(tn, handler);

    if (this.subscribedTopics.has(tn)) {
      // Already consumed (a configured topic or an earlier subscribe); the handler registration above
      // is enough. Start the poll loop if this is the first subscribe.
      if (!this.started) {
        this.started = true;
        await this.runLoop(consumer, sink);
      }
      return;
    }

    // A topic not yet consumed: provision it (+ its retry/dead-letter siblings) with leaders elected
    // before it is consumed, just like the configured topics on connect.
    await this.provisionTopics(kafka, this.topicSpecsFor(tn));

    if (!this.started) {
      await this.subscribeTopic(consumer, tn);
      this.started = true;
      await this.runLoop(consumer, sink);
      return;
    }

    // The poll loop is already running. kafkajs forbids subscribe() while running, so stop it, add the
    // new topic (the consumer keeps its existing subscriptions across stop), and restart the loop.
    await consumer.stop();
    await this.subscribeTopic(consumer, tn);
    await this.runLoop(consumer, sink);
  }

  /**
   * Run `handler` for one consumed record within its extracted trace context, then commit on success,
   * re-produce to the retry topic below the cap, or to the dead-letter topic at the cap, per the
   * shared disposition rule. The dead-letter decision is always logged - it drops the record from
   * redelivery, which must never be silent. If the re-produce to the retry or dead-letter topic fails,
   * the original offset is NOT committed, so the record is redelivered rather than lost. The sink is
   * passed in so the disposition is exercised without a live client. Invoked by the poll loop; exposed
   * for contract tests.
   */
  async dispatch(sink: RecordSink, record: ConsumedRecord, handler: MessageHandler): Promise<void> {
    const headers = record.headers;
    const base = record.topic.endsWith(RETRY_SUFFIX)
      ? record.topic.slice(0, -RETRY_SUFFIX.length)
      : record.topic;
    // The delivered subject is the ORIGINAL published subject carried in the keel-subject header (the
    // topic name is a lossy sanitization of it); fall back to the topic when the header is absent. The
    // retry/dead-letter topic derivation and the logs stay on `base`, the sanitized topic.
    const subject = headers[SUBJECT_HEADER] ?? base;
    const inbound: InboundMessage = {
      subject,
      payload: new Uint8Array(record.value),
      headers,
    };
    // Re-attach the producer's trace context so the handler's spans/logs join that trace.
    const extracted = propagation.extract(otelContext.active(), headers);
    await otelContext.with(extracted, async () => {
      let ok = false;
      let err: unknown;
      try {
        await handler(inbound);
        ok = true;
      } catch (caught) {
        err = caught;
      }

      // keel-delivery-count is the count of prior failed attempts (absent on first delivery), so +1
      // yields the 1-based num_delivered the disposition cap compares against, matching the Go adapter.
      const numDelivered = deliveryCount(headers) + 1;
      switch (disposition(ok, numDelivered, this.maxDeliver)) {
        case 'commit':
          await this.control(() => sink.commit(record), 'commit', base);
          return;
        case 'retry': {
          this.logger.warn(
            {
              subject: base,
              retry_topic: base + RETRY_SUFFIX,
              num_delivered: numDelivered,
              err: errorText(err),
            },
            'message handler failed; scheduling redelivery',
          );
          const retry = retryRecord(record, base, numDelivered);
          if (
            !(await this.produce(sink, retry, base, base + RETRY_SUFFIX, 'retry produce failed'))
          ) {
            // Preserve: the record has no home on the retry topic, so leave the offset uncommitted
            // and let the consumer group redeliver it rather than silently drop it.
            return;
          }
          await this.control(() => sink.commit(record), 'commit', base);
          return;
        }
        case 'dead-letter': {
          const dlq = this.dlqTopic(base);
          // The terminate decision is always logged - a dead-letter must never be silent.
          this.logger.error(
            {
              subject: base,
              dlq_topic: dlq,
              num_delivered: numDelivered,
              max_deliver: this.maxDeliver,
              err: errorText(err),
            },
            'message terminated after exhausting delivery attempts',
          );
          const dead = deadLetterRecord(record, dlq);
          if (!(await this.produce(sink, dead, base, dlq, 'dead-letter produce failed'))) {
            // Preserve: the record has no home on the dead-letter topic, so leave the offset
            // uncommitted and let it be redelivered rather than lost.
            return;
          }
          // Commit the original only after the record has a home on the dead-letter topic.
          await this.control(() => sink.commit(record), 'commit', base);
          return;
        }
      }
    });
  }

  /** Disconnect the producer and consumer (call at shutdown). */
  async close(): Promise<void> {
    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumer = undefined;
    }
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = undefined;
    }
    this.kafka = undefined;
    this.sink = undefined;
    this.started = false;
    this.subscribedTopics.clear();
  }

  /**
   * Produce `record`, returning true on success. On failure the offset is left uncommitted (preserve
   * policy): the failure is logged under `failMsg` and false returned so the caller skips the commit.
   */
  private async produce(
    sink: RecordSink,
    record: ProducedRecord,
    subject: string,
    destination: string,
    failMsg: string,
  ): Promise<boolean> {
    try {
      await sink.produce(record);
      return true;
    } catch (err) {
      this.logger.error(
        { subject, dest_topic: destination, err: errorText(err) },
        `${failMsg}; offset left uncommitted for redelivery`,
      );
      return false;
    }
  }

  /** The dead-letter destination for `base`: the shared override when set, else <base>.dlq. */
  private dlqTopic(base: string): string {
    return this.dlq !== '' ? this.dlq : base + DLQ_SUFFIX;
  }

  /** Run a commit call, logging (not raising) a control-plane failure so it stays diagnosable. */
  private async control(
    op: () => void | Promise<void>,
    name: string,
    subject: string,
  ): Promise<void> {
    try {
      await op();
    } catch (err) {
      this.logger.error({ op: name, subject, err: errorText(err) }, 'kafka control call failed');
    }
  }

  private requireSink(op: string): RecordSink {
    if (!this.sink) {
      throw new Error(`KafkaMessageBus.connect() must be called before ${op}()`);
    }
    return this.sink;
  }

  private requireConsumer(op: string): Consumer {
    if (!this.consumer) {
      throw new Error(`KafkaMessageBus.connect() must be called before ${op}()`);
    }
    return this.consumer;
  }
}

/** The production sink backed by a live kafkajs producer and consumer. */
class KafkaJsSink implements RecordSink {
  constructor(
    private readonly producer: Producer,
    private readonly consumer: Consumer,
  ) {}

  async produce(record: ProducedRecord): Promise<void> {
    await this.producer.send({
      topic: record.topic,
      messages: [{ key: record.key ?? undefined, value: record.value, headers: record.headers }],
    });
  }

  async commit(record: ConsumedRecord): Promise<void> {
    // Commit the next offset to consume (one past the processed record), the kafkajs convention.
    await this.consumer.commitOffsets([
      {
        topic: record.topic,
        partition: record.partition,
        offset: (BigInt(record.offset) + 1n).toString(),
      },
    ]);
  }
}

/** The default connectFn: a real kafkajs client with its own logging silenced so no broker leaks. */
function defaultConnectFn(config: { clientId: string; brokers: string[] }): KafkaFactory {
  return new Kafka({
    clientId: config.clientId,
    brokers: config.brokers,
    // Silence kafkajs's own logger so a connection error never prints the broker list.
    logLevel: logLevel.NOTHING,
  });
}

/** Convert a kafkajs consumed message into the flattened ConsumedRecord dispatch works with. */
function toConsumedRecord(topic: string, partition: number, message: KafkaMessage): ConsumedRecord {
  return {
    topic,
    partition,
    offset: message.offset,
    key: message.key ?? null,
    value: message.value ?? Buffer.alloc(0),
    headers: headersToRecord(message.headers),
  };
}

/**
 * retryRecord copies `rec` onto its base's retry topic, preserving the payload, key, and headers
 * (trace context included) and stamping the incremented delivery count so the next delivery sees it.
 */
function retryRecord(rec: ConsumedRecord, base: string, numDelivered: number): ProducedRecord {
  return {
    topic: base + RETRY_SUFFIX,
    key: rec.key,
    value: rec.value,
    headers: { ...rec.headers, [DELIVERY_COUNT_HEADER]: String(numDelivered) },
  };
}

/**
 * deadLetterRecord copies `rec` onto the dead-letter topic, preserving the original payload, key, and
 * headers so the dead-lettered record is a faithful copy of what failed.
 */
function deadLetterRecord(rec: ConsumedRecord, dlq: string): ProducedRecord {
  return { topic: dlq, key: rec.key, value: rec.value, headers: { ...rec.headers } };
}

/** Flatten kafkajs record headers into a plain string record for propagation extract and the handler. */
function headersToRecord(headers: IHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    // A header can be a single value or a list; take the last, matching the carrier's set-in-place.
    const raw = Array.isArray(value) ? value[value.length - 1] : value;
    if (raw === undefined) {
      continue;
    }
    out[key] = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  }
  return out;
}

/**
 * The redelivery count from the keel-delivery-count header: the count of prior failed attempts; the
 * caller adds 1 to get the 1-based num_delivered. Parsed strictly as a non-negative decimal integer -
 * a missing, malformed (not clean decimal digits, e.g. "3abc", "", " 3", "3.5"), or negative value is
 * treated as 0 prior deliveries (num_delivered = 1, the first delivery). The strictness is canonical
 * across all five verticals: it denies a producer-injected negative count, which would otherwise make
 * num_delivered small/negative and drive unbounded redelivery (an amplification DoS).
 */
function deliveryCount(headers: Record<string, string>): number {
  const raw = headers[DELIVERY_COUNT_HEADER];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return 0;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
