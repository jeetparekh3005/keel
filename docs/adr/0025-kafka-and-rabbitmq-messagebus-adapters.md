# 0025. Kafka and RabbitMQ MessageBus adapters

- **Status:** accepted <!-- proposed | accepted | rejected | deprecated | superseded by ADR-XXXX -->
- **Date:** 2026-11-19
- **Deciders:** keel maintainers

## Context and problem statement

ADR-0012 defined one `MessageBus` port (`publish` + `subscribe`, an `InboundMessage{subject,
payload, headers}`, ack semantics in the adapter) and shipped a durable **NATS JetStream** adapter
across all five verticals: at-least-once delivery, ack on success / nak below a cap / terminate
(dead-letter) at the cap, W3C trace-context propagation through message headers, opt-in client.
`platform.yaml` `interservice.async.supported` already names `nats_jetstream`, `kafka`, and
`rabbitmq`, and `idl: asyncapi`. This ADR implements the two remaining brokers across all five
verticals behind the same port with identical delivery semantics, adds a fail-closed broker
selector, and lands the first AsyncAPI artifact.

## Decision drivers

- **Full delivery-contract parity with NATS** - a Kafka or RabbitMQ bus behaves exactly like the
  NATS one through the port: at-least-once, ack-on-success, bounded redelivery, dead-letter at the
  cap, trace propagation, never log a payload.
- **Broker-native semantics** - Kafka (topics + consumer groups + offset commit) and RabbitMQ
  (exchange/queue + manual ack/nack + dead-letter exchange) are different primitives; each adapter
  maps the one contract onto its broker correctly rather than faking NATS-isms.
- **Opt-in, default build stays broker-free** - the client libraries are heavy; a service pulls one
  in only when it selects that broker.
- **One selection model across cross-cutting concerns** - broker choice is fail-closed at-most-one,
  matching the `SecretProvider` selector (ADR-0024).

## Decision

### 1. Client libraries (per vertical)

| Vertical | Kafka | RabbitMQ |
|---|---|---|
| Python | `aiokafka` (pure-Python asyncio) | `aio-pika` (async, over aiormq) |
| Go | `franz-go` (`github.com/twmb/franz-go`, pure Go) | `amqp091-go` (`github.com/rabbitmq/amqp091-go`, official) |
| TypeScript | `kafkajs` (pure JS) | `amqplib` |
| Java | `org.apache.kafka:kafka-clients` (official) | `com.rabbitmq:amqp-client` (official) |
| Rust | `rdkafka` (`rust-rdkafka`, wraps librdkafka) | `lapin` (pure Rust, async) |

RabbitMQ is a pure-language client in every vertical, including Rust (`lapin`). Kafka is
pure-language in four of five.

**Rust Kafka C-dependency exception.** `rust-rdkafka` wraps the C library **librdkafka**, which
breaks the ring-only / no-C-crypto posture held elsewhere (ADR-0024's `gcloud-sdk` choice, the
`aws` adapter, the gRPC stack). It is accepted deliberately: there is no mature pure-Rust Kafka
client (`rskafka` lacks production consumer-group and offset-management support and could not meet
the ack/nak/dead-letter contract below), and `rust-rdkafka` is the de-facto standard with full
consumer groups, manual offset commit, headers, and transactions. This is the inverse of the
ADR-0024 exception (there we rejected a C dep because a ring-only path existed; here no pure-Rust
path exists). Consequences: the Rust Kafka build needs `cmake` + a C toolchain and links libsasl/zlib;
librdkafka is vendored/statically built by the crate. The exception is **scoped to the `kafka`
Cargo feature only** - `deny.toml` continues to ban `aws-lc-sys`/`openssl-sys`/`native-tls`
everywhere, and librdkafka's own TLS is irrelevant to the Rust crypto posture (it is a separate C
TLS stack used only on the Kafka socket, not keel's rustls/ring tree). STATUS and the ADR note this
honestly rather than claiming an all-pure-Rust tree.

### 2. Delivery contract (identical to NATS, mapped per broker)

Every adapter preserves the NATS defaults - **maxDeliver = 5, ackWait = 30s, maxAckPending = 256** -
and the disposition rule: **ack on handler success; redeliver (nak) while the delivery count is
below `maxDeliver`; dead-letter (term) at the cap, always logging the terminate**; control-plane
failures (a failed ack/commit) are logged, never raised. The pure disposition function
(`disposition(ok, num_delivered, max_deliver)`, modelled on the Rust NATS adapter) is reused so the
decision is unit-tested without a broker.

- **Kafka.** `subject` maps to a Kafka **topic** (non-alphanumeric sanitized, as NATS durable names
  are). Consume via a **consumer group** (`KEEL_KAFKA_GROUP_ID`, default `keel`) with
  auto-commit **off**; commit the offset only after the handler acks. Redelivery count travels in a
  record header (`keel-delivery-count`) incremented on each retry; below the cap the record is
  re-produced to a **retry topic** (`<topic>.retry`) and the original offset committed so the
  partition is not head-of-line blocked; at the cap it is produced to the **dead-letter topic**
  (`<topic>.dlq`, overridable via `KEEL_KAFKA_DLQ_TOPIC`) and committed. W3C trace context rides in
  record headers.
- **RabbitMQ.** A **topic exchange** (`KEEL_RABBITMQ_EXCHANGE`, default `keel`) with `subject` as the
  routing key; a durable **queue** (`KEEL_RABBITMQ_QUEUE`, default `keel`) bound to the configured
  subjects, consumed with manual ack. Handler success -> `basic.ack`; below the cap ->
  `basic.nack(requeue=true)`; at the cap -> publish to a **dead-letter exchange**
  (`KEEL_RABBITMQ_DLX`, default `keel.dlx`) and `basic.ack` the original. Delivery count is read from
  the AMQP `x-death`/`x-delivery-count` headers (quorum queues expose `x-delivery-count`), with a
  `keel-delivery-count` header as the portable fallback. W3C trace context rides in AMQP headers.

### 3. Broker selection (fail-closed, at most one)

A per-vertical `message_bus_from_env()` factory (new for Python/Go/TS/Rust, which had no bus
factory; an extended Spring `@AutoConfiguration` for Java) selects the bus from exactly one gating
variable, mirroring the `SecretProvider` selector:

| Broker | Gate | Other keys |
|---|---|---|
| NATS JetStream | `KEEL_NATS_URL` | `KEEL_NATS_STREAM` (`keel`), `KEEL_NATS_SUBJECTS` (`keel.>`) |
| Kafka | `KEEL_KAFKA_BROKERS` | `KEEL_KAFKA_TOPICS`, `KEEL_KAFKA_GROUP_ID` (`keel`), `KEEL_KAFKA_DLQ_TOPIC` |
| RabbitMQ | `KEEL_RABBITMQ_URL` | `KEEL_RABBITMQ_EXCHANGE` (`keel`), `KEEL_RABBITMQ_QUEUE` (`keel`), `KEEL_RABBITMQ_DLX` (`keel.dlx`) |

More than one gate set **fails closed at startup** (an ambiguous-configuration error, exactly like
the at-most-one secret-backend check). None set yields the in-memory `InMemoryMessageBus` (the dev
default), unchanged. Shared cache TTL is irrelevant here; there is no caching layer for a bus.

### 4. AsyncAPI artifact

A single `schemas/asyncapi.yaml` (AsyncAPI 3.x) documents the envelope the bus carries - `subject`
(channel address), `payload` (opaque bytes / the domain event), and the W3C `traceparent` header -
and the reference service's channel(s). It is the async analogue of the buf-guarded gRPC IDL
(ADR-0022): a versioned contract artifact, **linted in CI** (Spectral with the AsyncAPI ruleset).
It does not yet enumerate a full domain-event catalog; it pins the envelope and the reference
channel so the contract has a real artifact behind `idl: asyncapi`, and grows as events are added.

### 5. Opt-in packaging and CI

Clients are opt-in exactly as NATS is: Python extras (`[kafka]`, `[rabbitmq]`), Rust Cargo features
(`kafka`, `rabbitmq`), TS subpath-only exports (`./messaging/kafka`, `./messaging/rabbitmq`), Java
explicit `pom.xml` deps, Go module requires. The default build stays broker-free. CI starts a
**Kafka** broker (`apache/kafka` in KRaft mode, pinned) and a **RabbitMQ** broker (`rabbitmq`,
pinned) alongside the existing `nats:2.15 -js` step in every vertical's workflow; the integration
tests are gated on `KEEL_KAFKA_BROKERS` / `KEEL_RABBITMQ_URL` and skip when unset, like the NATS
round-trip. Each adapter also carries a broker-free unit test of the ack/nak/dead-letter
disposition and keeps the vertical above its coverage floor.

## Consequences

- **Good:** both brokers reachable through the one `MessageBus` port with identical delivery
  guarantees; broker choice is one fail-closed decision consistent with secrets; AsyncAPI stops
  being a dangling contract reference; the default build gains no new weight.
- **Bad:** the Rust Kafka adapter introduces a C build dependency (librdkafka + cmake), the first in
  the Rust tree; CI gains two more broker containers per vertical, lengthening the integration lanes.
- **Neutral:** Kafka's lack of a native per-message delivery count forces the retry-topic +
  delivery-count-header pattern, which is more moving parts than NATS's built-in `maxDeliver`; it is
  the standard Kafka approach and is unit-tested via the shared disposition function.

> **Implementation status:** proposed here; flip ADR-0012's "still planned: Kafka/RabbitMQ" note and
> `docs/STATUS.md` only once each adapter is backed by passing unit + gated integration tests, per
> the repo's no-over-claim rule. `platform.yaml` already lists both as `supported`, so no contract
> change is needed to add them.
