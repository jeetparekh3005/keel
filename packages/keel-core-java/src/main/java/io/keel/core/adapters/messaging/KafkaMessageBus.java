package io.keel.core.adapters.messaging;

import io.keel.core.ports.messaging.InboundMessage;
import io.keel.core.ports.messaging.MessageBus;
import io.keel.core.ports.messaging.MessageHandler;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapPropagator;
import io.opentelemetry.context.propagation.TextMapSetter;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.regex.Pattern;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.KafkaException;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.errors.WakeupException;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.header.Headers;
import org.apache.kafka.common.header.internals.RecordHeader;
import org.apache.kafka.common.serialization.ByteArrayDeserializer;
import org.apache.kafka.common.serialization.ByteArraySerializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A {@link MessageBus} backed by Apache Kafka for durable, at-least-once delivery (ADR-0025).
 * Delivers the identical contract to the NATS JetStream and RabbitMQ adapters, mapped onto Kafka
 * primitives (the proven Go {@code KafkaMessageBus} is the reference):
 *
 * <ul>
 *   <li>A subject maps to a Kafka <b>topic</b> (every non-alphanumeric/underscore character is
 *       sanitized to {@code _}, exactly as NATS durable names are); {@code publish} produces to
 *       that topic through a {@link KafkaProducer}, injecting the current W3C trace context into
 *       the record headers so a subscriber continues the publisher's trace across the broker.
 *   <li>Consumption runs through a <b>consumer group</b> ({@code KEEL_KAFKA_GROUP_ID}, default
 *       {@code keel}) with auto-commit OFF, so a record's offset is committed only after the
 *       handler acks.
 *   <li>Kafka has no native per-message delivery count, so it travels in a {@code
 *       keel-delivery-count} record header. On handler failure below the cap the record is
 *       re-produced to {@code <topic>.retry} with an incremented count and the original offset
 *       committed (so the partition is not head-of-line blocked); the consumer also subscribes
 *       {@code <topic>.retry}, routing a retried record back to the base topic's handler. At the
 *       cap the original payload and headers are produced to {@code <topic>.dlq} ({@code
 *       KEEL_KAFKA_DLQ_TOPIC} overridable) and the original committed, always logged at error so a
 *       poison record neither loops forever nor is dropped silently.
 * </ul>
 *
 * <p>If the retry or dead-letter produce itself fails, the original offset is NOT committed, so the
 * record is redelivered rather than lost (the preserve-on-produce-failure policy the Go reference
 * and the RabbitMQ adapter share). The ack/retry/dead-letter decision is the pure, package-private
 * {@link #disposition(boolean, int, int)}, unit-testable without a broker.
 *
 * <p>The bootstrap servers and any SASL configuration are never echoed into a connect or produce
 * exception message, so credentials cannot leak through the application log (the Java RabbitMQ and
 * NATS adapters follow the same rule).
 */
public final class KafkaMessageBus implements MessageBus {

  private static final Logger log = LoggerFactory.getLogger(KafkaMessageBus.class);

  /**
   * Carries the portable redelivery count Kafka does not track natively; incremented each time a
   * failed record is re-produced to the retry topic.
   */
  private static final String DELIVERY_COUNT_HEADER = "keel-delivery-count";

  /**
   * Carries the ORIGINAL subject across the broker. A subject maps to a Kafka topic through a lossy
   * sanitization ({@code keel.test.events} -> {@code keel_test_events}), so the topic name cannot
   * recover the published subject; the subject travels in this header so the delivered {@code
   * InboundMessage.subject} equals what was published (unlike NATS/RabbitMQ, where the subject IS
   * the routing key). It survives the re-produce to {@code <topic>.retry}/{@code <topic>.dlq}
   * alongside {@code keel-delivery-count} and the trace headers.
   */
  private static final String SUBJECT_HEADER = "keel-subject";

  private static final String RETRY_SUFFIX = ".retry";
  private static final String DLQ_SUFFIX = ".dlq";

  // Kafka topic alphabet is a superset of [A-Za-z0-9_]; sanitize a subject to that subset exactly
  // as
  // NATS durable names are sanitized, so the .retry/.dlq suffixes only add a legal dot.
  private static final Pattern TOPIC_UNSAFE = Pattern.compile("[^A-Za-z0-9_]");

  private static final TextMapSetter<Map<String, String>> SETTER = Map::put;

  private static final TextMapGetter<Map<String, String>> GETTER =
      new TextMapGetter<>() {
        @Override
        public Iterable<String> keys(Map<String, String> carrier) {
          return carrier.keySet();
        }

        @Override
        public String get(Map<String, String> carrier, String key) {
          return carrier == null ? null : carrier.get(key);
        }
      };

  private final List<String> brokers;
  private final List<String> topics;
  private final String groupId;
  private final String dlqTopic;
  private final TextMapPropagator propagator;
  private final int maxDeliver;
  private final Map<String, String> extraProducerConfig;

  private final Map<String, MessageHandler> handlers = new ConcurrentHashMap<>();
  private volatile Set<String> desiredTopics = Set.of();
  private volatile boolean running;

  private KafkaProducer<byte[], byte[]> producer;
  private KafkaConsumer<byte[], byte[]> consumer;
  private RecordSink sink;
  private Thread pollThread;

  /**
   * Configure the bootstrap brokers, the topics (subjects) to consume, the consumer group, an
   * optional single dead-letter-topic override, the trace propagator, and the redelivery cap.
   *
   * @param brokers the bootstrap servers (from the comma-separated {@code KEEL_KAFKA_BROKERS}); the
   *     gate: a bus is wired only when this is set
   * @param topics the subjects the consumer group subscribes to; each is sanitized to a legal topic
   *     and its {@code <topic>.retry} sibling is consumed too
   * @param groupId the consumer group ({@code KEEL_KAFKA_GROUP_ID})
   * @param dlqTopic a single shared dead-letter topic ({@code KEEL_KAFKA_DLQ_TOPIC}) that overrides
   *     the per-topic {@code <topic>.dlq} default; blank keeps the per-topic default
   * @param openTelemetry source of the W3C text-map propagator used to carry trace context
   * @param maxDeliver redelivery cap before a failed record is dead-lettered
   */
  public KafkaMessageBus(
      List<String> brokers,
      List<String> topics,
      String groupId,
      String dlqTopic,
      OpenTelemetry openTelemetry,
      int maxDeliver) {
    this(brokers, topics, groupId, dlqTopic, openTelemetry, maxDeliver, Map.of());
  }

  /** Configure with the default redelivery cap (maxDeliver 5). */
  public KafkaMessageBus(
      List<String> brokers,
      List<String> topics,
      String groupId,
      String dlqTopic,
      OpenTelemetry openTelemetry) {
    this(brokers, topics, groupId, dlqTopic, openTelemetry, 5, Map.of());
  }

  /**
   * Full constructor; {@code extraProducerConfig} overrides producer client properties (used by the
   * leak test to bound {@code max.block.ms} so a produce against an unreachable broker fails fast,
   * proving the broker address never leaks into the surfaced exception).
   */
  KafkaMessageBus(
      List<String> brokers,
      List<String> topics,
      String groupId,
      String dlqTopic,
      OpenTelemetry openTelemetry,
      int maxDeliver,
      Map<String, String> extraProducerConfig) {
    this.brokers = List.copyOf(brokers);
    this.topics = List.copyOf(topics);
    this.groupId = groupId;
    this.dlqTopic = dlqTopic == null ? "" : dlqTopic;
    this.propagator = openTelemetry.getPropagators().getTextMapPropagator();
    this.maxDeliver = maxDeliver;
    this.extraProducerConfig = Map.copyOf(extraProducerConfig);
  }

  /**
   * Create the producer and consumer (consumer group, auto-commit OFF). Idempotent and
   * synchronized: {@code publish}/{@code subscribe} call it on first use, so the bean does not open
   * a socket merely by being wired into a context; Kafka clients dial lazily, so a broker failure
   * surfaces on the first produce/poll rather than at wiring. Neither the broker list nor any SASL
   * config is echoed into a construction-failure exception, so credentials cannot leak through the
   * log.
   */
  public synchronized void connect() {
    if (producer != null) {
      return;
    }
    try {
      this.producer =
          new KafkaProducer<>(
              producerProperties(), new ByteArraySerializer(), new ByteArraySerializer());
      this.consumer =
          new KafkaConsumer<>(
              consumerProperties(), new ByteArrayDeserializer(), new ByteArrayDeserializer());
      this.sink = new KafkaRecordSink(producer, consumer);
    } catch (KafkaException e) {
      // Reduce the cause to its type: a ConfigException echoes the offending bootstrap.servers /
      // SASL value, which must never reach the log. The type alone diagnoses a misconfiguration.
      closeQuietly();
      throw new IllegalStateException(
          "failed to initialize the Kafka client: " + e.getClass().getName());
    }
  }

  private Properties producerProperties() {
    Properties props = new Properties();
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, String.join(",", brokers));
    // acks=all + idempotence so a produced retry/dead-letter record is durable (and not duplicated)
    // before its origin offset commits.
    props.put(ProducerConfig.ACKS_CONFIG, "all");
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
    extraProducerConfig.forEach(props::put);
    return props;
  }

  private Properties consumerProperties() {
    Properties props = new Properties();
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, String.join(",", brokers));
    props.put(ConsumerConfig.GROUP_ID_CONFIG, groupId);
    // Auto-commit OFF: the offset is committed only after the handler acks (success) or the record
    // has a home on the retry/dead-letter topic, never before the work is done.
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
    // Read a freshly auto-created topic (including a <topic>.retry sibling) from the start so a
    // retried record is not skipped when its topic is created on first produce.
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
    return props;
  }

  @Override
  public void publish(String subject, byte[] payload, Map<String, String> headers) {
    connect();
    Map<String, String> carrier = new HashMap<>();
    if (headers != null) {
      carrier.putAll(headers);
    }
    propagator.inject(Context.current(), carrier, SETTER);
    List<Header> recordHeaders = new ArrayList<>(carrier.size() + 1);
    carrier.forEach((key, value) ->
        recordHeaders.add(new RecordHeader(key, value.getBytes(StandardCharsets.UTF_8))));
    // Carry the original subject explicitly: the topic is a lossy transform of it, so a subscriber
    // recovers the published subject from this header rather than the sanitized topic name.
    recordHeaders.add(new RecordHeader(SUBJECT_HEADER, subject.getBytes(StandardCharsets.UTF_8)));
    ProducerRecord<byte[], byte[]> record =
        new ProducerRecord<>(topicName(subject), null, null, null, payload, recordHeaders);
    // sink.produce throws on failure with a message built from the topic (safe), never the brokers.
    sink.produce(record);
  }

  @Override
  public void subscribe(String subject, MessageHandler handler) {
    connect();
    String base = topicName(subject);
    handlers.put(base, handler);
    // The retried record comes back through the same consumer group, so the retry topic is consumed
    // alongside the base topic; a record on <topic>.retry routes to the base topic's handler.
    Set<String> next = new HashSet<>(desiredTopics);
    next.add(base);
    next.add(base + RETRY_SUFFIX);
    for (String topic : topics) {
      String t = topicName(topic);
      next.add(t);
      next.add(t + RETRY_SUFFIX);
    }
    desiredTopics = Set.copyOf(next);
    startOrWake();
  }

  /** Start the single poll thread on first subscribe, or wake a running one to re-subscribe. */
  private synchronized void startOrWake() {
    if (pollThread == null) {
      running = true;
      pollThread = new Thread(this::pollLoop, "keel-kafka-poll");
      pollThread.setDaemon(true);
      pollThread.start();
    } else {
      // The consumer is single-threaded; wake the blocked poll so the loop re-subscribes to the new
      // topic set on its own thread.
      consumer.wakeup();
    }
  }

  /**
   * Fetch records and route each to its registered handler via {@link #dispatch}, re-subscribing
   * whenever the desired topic set changes, until {@link #close()} stops the loop. A fetch-level
   * error is logged, not raised, so a transient broker hiccup does not tear down the consumer.
   */
  private void pollLoop() {
    Set<String> subscribed = Set.of();
    while (running) {
      try {
        Set<String> want = desiredTopics;
        if (!want.equals(subscribed)) {
          consumer.subscribe(want);
          subscribed = want;
        }
        ConsumerRecords<byte[], byte[]> records = consumer.poll(Duration.ofMillis(500));
        for (ConsumerRecord<byte[], byte[]> record : records) {
          MessageHandler handler = handlers.get(baseTopic(record.topic()));
          if (handler != null) {
            dispatch(sink, record, handler);
          }
        }
      } catch (WakeupException wakeup) {
        // A wakeup is either a subscription change (loop around to re-subscribe) or shutdown
        // (running is now false); either way, re-evaluate the loop condition.
      } catch (RuntimeException e) {
        if (running) {
          log.error("kafka poll error", e);
        }
      }
    }
  }

  /**
   * Run {@code handler} within the record's extracted trace context, then commit on success,
   * re-produce to the retry topic below the cap, or to the dead-letter topic at the cap, per the
   * shared {@link #disposition}. The dead-letter decision is always logged. If the retry or
   * dead-letter produce itself fails the original offset is NOT committed, so the record is
   * redelivered rather than lost. Package-private so the policy is unit-testable without a broker.
   */
  void dispatch(
      RecordSink recordSink, ConsumerRecord<byte[], byte[]> record, MessageHandler handler) {
    String base = baseTopic(record.topic());
    Map<String, String> headers = toMap(record.headers());
    // The delivered subject is the original published subject (from the keel-subject header), not
    // the lossy sanitized topic; fall back to the base topic when the header is absent.
    String subject = headers.getOrDefault(SUBJECT_HEADER, base);
    InboundMessage inbound = new InboundMessage(subject, record.value(), headers);
    Context extracted = propagator.extract(Context.current(), headers, GETTER);

    boolean ok;
    Exception handlerFailure = null;
    try (Scope ignored = extracted.makeCurrent()) {
      handler.handle(inbound);
      ok = true;
    } catch (Exception e) {
      // One bad handler must not kill the poll loop, so every exception is caught and turned into a
      // control-plane decision. The handler still owns its own domain error logging/tracing.
      ok = false;
      handlerFailure = e;
    }

    int numDelivered = deliveryCount(record.headers()) + 1;
    switch (disposition(ok, numDelivered, maxDeliver)) {
      case ACK -> commit(recordSink, record, base);
      case RETRY -> {
        log.warn(
            "message handler failed; scheduling redelivery: subject={} retryTopic={} numDelivered={}",
            base,
            base + RETRY_SUFFIX,
            numDelivered,
            handlerFailure);
        if (!tryProduce(recordSink, retryRecord(record, base, numDelivered))) {
          // Preserve: the record has no home on the retry topic, so leave the offset uncommitted
          // and
          // let the consumer group redeliver it rather than silently drop it.
          log.error(
              "retry produce failed; offset left uncommitted for redelivery: subject={} retryTopic={}",
              base,
              base + RETRY_SUFFIX);
          return;
        }
        commit(recordSink, record, base);
      }
      case DEAD_LETTER -> {
        String dlq = dlqFor(base);
        // Always log the dead-letter: it drops the record from redelivery, which must never be
        // silent.
        log.error(
            "message terminated after exhausting delivery attempts: subject={} dlqTopic={} numDelivered={} maxDeliver={}",
            base,
            dlq,
            numDelivered,
            maxDeliver,
            handlerFailure);
        if (!tryProduce(recordSink, deadLetterRecord(record, dlq))) {
          // Preserve: the record has no home on the dead-letter topic, so leave the offset
          // uncommitted and let it be redelivered rather than lost.
          log.error(
              "dead-letter produce failed; offset left uncommitted for redelivery: subject={} dlqTopic={}",
              base,
              dlq);
          return;
        }
        // Commit the original only after the record has a home on the dead-letter topic.
        commit(recordSink, record, base);
      }
    }
  }

  /** The fate of a delivered record, decided purely from the handler outcome + delivery count. */
  enum Disposition {
    ACK,
    RETRY,
    DEAD_LETTER
  }

  /**
   * Decide a record's fate from the handler outcome and delivery count. Pure, so the
   * poison-handling policy is unit-testable without a broker (parity with the other four
   * verticals): ack on success regardless of count; retry on failure under the cap; dead-letter at
   * or over it.
   */
  static Disposition disposition(boolean ok, int numDelivered, int maxDeliver) {
    if (ok) {
      return Disposition.ACK;
    }
    if (numDelivered >= maxDeliver) {
      return Disposition.DEAD_LETTER;
    }
    return Disposition.RETRY;
  }

  @Override
  public void close() {
    running = false;
    if (consumer != null) {
      consumer.wakeup();
    }
    if (pollThread != null) {
      try {
        pollThread.join(5000);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
      pollThread = null;
    }
    closeQuietly();
  }

  private void closeQuietly() {
    if (producer != null) {
      producer.close();
      producer = null;
    }
    if (consumer != null) {
      consumer.close();
      consumer = null;
    }
    sink = null;
  }

  /**
   * Produce a record, returning false (logged by the caller) rather than raising, so dispatch
   * decides.
   */
  private static boolean tryProduce(RecordSink recordSink, ProducerRecord<byte[], byte[]> record) {
    try {
      recordSink.produce(record);
      return true;
    } catch (RuntimeException e) {
      return false;
    }
  }

  /**
   * Commit the record's offset, logging (not raising) a control-plane failure so it is diagnosable.
   */
  private static void commit(
      RecordSink recordSink, ConsumerRecord<byte[], byte[]> record, String subject) {
    try {
      recordSink.commit(record);
    } catch (RuntimeException e) {
      // A failed commit would otherwise vanish; surface it so redelivery or duplicate-processing
      // anomalies are diagnosable.
      log.error("kafka control call failed: op=commit subject={}", subject, e);
    }
  }

  /**
   * The dead-letter destination for {@code base}: the shared override when set, else {@code
   * <base>.dlq}.
   */
  private String dlqFor(String base) {
    return dlqTopic.isEmpty() ? base + DLQ_SUFFIX : dlqTopic;
  }

  /**
   * Copy {@code record} onto its base's retry topic, preserving the payload, key, and headers
   * (trace context included) and stamping the incremented delivery count so the next delivery sees
   * it.
   */
  private static ProducerRecord<byte[], byte[]> retryRecord(
      ConsumerRecord<byte[], byte[]> record, String base, int numDelivered) {
    return new ProducerRecord<>(
        base + RETRY_SUFFIX,
        null,
        null,
        record.key(),
        record.value(),
        headersWithDeliveryCount(record.headers(), numDelivered));
  }

  /**
   * Copy {@code record} onto the dead-letter topic, preserving the original payload, key, and
   * headers so the dead-lettered record is a faithful copy of what failed.
   */
  private static ProducerRecord<byte[], byte[]> deadLetterRecord(
      ConsumerRecord<byte[], byte[]> record, String dlq) {
    return new ProducerRecord<>(
        dlq, null, null, record.key(), record.value(), cloneHeaders(record.headers()));
  }

  /**
   * Clone the record headers into a mutable list so a re-produced record does not alias the source.
   */
  private static List<Header> cloneHeaders(Headers headers) {
    List<Header> out = new ArrayList<>();
    for (Header header : headers) {
      out.add(new RecordHeader(header.key(), header.value()));
    }
    return out;
  }

  /**
   * Clone the headers and set {@code keel-delivery-count} to {@code n}, replacing any existing
   * value.
   */
  private static List<Header> headersWithDeliveryCount(Headers headers, int n) {
    List<Header> out = new ArrayList<>();
    for (Header header : headers) {
      if (!header.key().equals(DELIVERY_COUNT_HEADER)) {
        out.add(new RecordHeader(header.key(), header.value()));
      }
    }
    out.add(
        new RecordHeader(
            DELIVERY_COUNT_HEADER, Integer.toString(n).getBytes(StandardCharsets.UTF_8)));
    return out;
  }

  /**
   * Read the redelivery count from the {@code keel-delivery-count} header as a non-negative decimal
   * integer, returning 0 when it is absent (the first delivery), malformed, or negative; {@code
   * dispatch} adds one for a 1-based attempt count matching the other verticals' numDelivered.
   *
   * <p>A negative value is clamped to 0 rather than trusted: the header is attacker-controllable,
   * so a published {@code keel-delivery-count: -100000000} would otherwise keep numDelivered far
   * below the cap and cycle the record consume -> fail -> re-produce ~100M times before
   * dead-lettering (a redelivery-amplification DoS). Clamping treats a hostile count as the first
   * delivery.
   */
  private static int deliveryCount(Headers headers) {
    Header header = headers.lastHeader(DELIVERY_COUNT_HEADER);
    if (header == null || header.value() == null) {
      return 0;
    }
    try {
      int parsed = Integer.parseInt(new String(header.value(), StandardCharsets.UTF_8).trim());
      return Math.max(parsed, 0);
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  /** A record on {@code <topic>.retry} belongs to the base topic's handler; strip the suffix. */
  private static String baseTopic(String topic) {
    return topic.endsWith(RETRY_SUFFIX)
        ? topic.substring(0, topic.length() - RETRY_SUFFIX.length())
        : topic;
  }

  /**
   * Sanitize {@code subject} to a legal topic, replacing every non-alphanumeric/underscore
   * character (as NATS durable names are sanitized); the result is a subset of Kafka's legal topic
   * alphabet, to which the {@code .retry}/{@code .dlq} suffixes append a legal dot.
   */
  static String topicName(String subject) {
    return TOPIC_UNSAFE.matcher(subject).replaceAll("_");
  }

  /** Collapse record headers to the single-valued string propagation map the port exposes. */
  private static Map<String, String> toMap(Headers headers) {
    Map<String, String> map = new HashMap<>();
    for (Header header : headers) {
      if (header.value() != null) {
        map.put(header.key(), new String(header.value(), StandardCharsets.UTF_8));
      }
    }
    return map;
  }

  /**
   * The slice of the Kafka clients {@code dispatch} needs: produce a record (to a retry or
   * dead-letter topic) and commit a consumed record's offset. An interface so a broker-free test
   * can supply a fake that records produces and commits without a live client.
   */
  interface RecordSink {
    void produce(ProducerRecord<byte[], byte[]> record);

    void commit(ConsumerRecord<byte[], byte[]> record);
  }

  /** The production {@link RecordSink} backed by a live producer and consumer. */
  private static final class KafkaRecordSink implements RecordSink {
    private final KafkaProducer<byte[], byte[]> producer;
    private final KafkaConsumer<byte[], byte[]> consumer;

    private KafkaRecordSink(
        KafkaProducer<byte[], byte[]> producer, KafkaConsumer<byte[], byte[]> consumer) {
      this.producer = producer;
      this.consumer = consumer;
    }

    @Override
    public void produce(ProducerRecord<byte[], byte[]> record) {
      try {
        // Synchronous: block until the broker acks, so a produce failure is observable (dispatch
        // leaves the offset uncommitted; publish surfaces it). The message names the topic, never
        // the brokers, so no credential leaks.
        producer.send(record).get();
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("interrupted producing to " + record.topic());
      } catch (ExecutionException e) {
        throw new IllegalStateException("failed to produce to " + record.topic(), e.getCause());
      } catch (KafkaException e) {
        // send() itself can throw (e.g. a metadata-wait timeout against an unreachable broker); its
        // message names the topic or the wait, never the brokers, so chaining it leaks no
        // credential.
        throw new IllegalStateException("failed to produce to " + record.topic(), e);
      }
    }

    @Override
    public void commit(ConsumerRecord<byte[], byte[]> record) {
      // Commit the offset AFTER this record: the next poll resumes past it.
      consumer.commitSync(
          Map.of(
              new TopicPartition(record.topic(), record.partition()),
              new OffsetAndMetadata(record.offset() + 1)));
    }
  }
}
