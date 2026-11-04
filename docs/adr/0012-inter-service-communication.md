# 0012. Inter-service communication

- **Status:** accepted (implementation phased; see roadmap)
- **Date:** 2026-11-03
- **Deciders:** Jeet Parekh

## Context and problem statement

Services need to talk to each other across languages without creating a distributed monolith. We must choose the synchronous transport, the asynchronous messaging story, and the principle that governs when to use which - consistent with hexagonal (transport is an adapter) and the cloud-agnostic OSS posture.

## Decision drivers

- Polyglot typed contracts (clients/servers for all five languages).
- Decoupling and resilience - avoid synchronous call chains that cascade failures.
- Cloud-agnostic, OSS, and swappable behind ports.

## Considered options

**Synchronous (east-west) transport**

| Option | Typed contract | Polyglot codegen | Perf | Browser-friendly |
|---|---|---|---|---|
| **gRPC** | protobuf | Yes (all langs) | High (HTTP/2, binary) | No (edge stays REST) |
| REST/JSON | OpenAPI | Partial | Medium | Yes |

**Asynchronous message bus**

| Option | Model | Replay/log | Ops weight | Role |
|---|---|---|---|---|
| **NATS JetStream** | pub/sub + streams | Yes (streams) | Light | **Default, now** |
| Kafka | durable log | Strong | Heavy | Supported adapter |
| RabbitMQ | AMQP broker/queues | Limited | Medium | Supported adapter |

## Decision outcome

**Edge stays REST/OpenAPI. East-west synchronous calls use gRPC. Asynchronous events go through a `MessageBus` port with NATS JetStream as the default adapter and Kafka/RabbitMQ as supported swaps.**

### Principle (governs when to use which)

1. **Prefer async events** for cross-service side-effects ("something happened").
2. Use **sync gRPC only** when the caller needs an immediate response.
3. **Never** expose gRPC at the browser edge - the edge is REST/OpenAPI via APISIX.

### Synchronous - gRPC

- protobuf IDL; **buf** for linting, breaking-change detection, and codegen in CI.
- Hexagonal: a gRPC server is a driving adapter (`GrpcApi`); a client to another service is a driven adapter (`ServiceClient`). The domain never depends on gRPC.
- **mTLS via OpenBao PKI** ([ADR-0007](0007-secrets-and-pki.md)) - which is why a full service mesh is not needed yet.

### Asynchronous - `MessageBus` port

- One port (publish + subscribe); `MessagePublisher` (driven) and `MessageConsumer` (driving).
- **NATS JetStream** implemented first (lightweight, CNCF, k8s-native, OSS, cloud-agnostic).
- **Kafka** and **RabbitMQ** adapters slot behind the same port - the port is designed for all three from day one (stream vs queue semantics abstracted).
- Event schemas use **AsyncAPI** as a versioned contract artifact, with the same backward-compat discipline as protobuf.

### Consequences

- Good: typed polyglot contracts; async-first decoupling; brokers are swappable.
- Good: protobuf/AsyncAPI become contract artifacts alongside `platform.yaml`.
- Bad: gRPC adds a codegen pipeline and proto/event versioning discipline; mitigated by buf and AsyncAPI tooling.
- Neutral: NATS runs first; Kafka/RabbitMQ are stood up only when a workload needs their semantics.

> **Implementation status:** OTel-instrumented gRPC client/server factories (with deny-by-default
> auth, scope authZ, and mTLS credential builders), an in-memory `MessageBus`, and a durable
> **NATS JetStream** adapter (ack/nak/DLQ, trace propagation) are implemented. Still planned:
> **protobuf IDL/buf** and **Kafka/RabbitMQ** broker adapters. See [docs/STATUS.md](../STATUS.md).

## Enforcement

- **buf lint** + **buf breaking:** protobuf style and backward-compatibility checks in CI; generated code is reproducible.
- **spectral** / **openapi-spec-validator:** the edge OpenAPI spec must lint clean and declare the `problem+json` error schema.
- **AsyncAPI** event schemas are validated and checked for breaking changes.
- **semgrep:** outbound HTTP/gRPC clients must set timeouts (resilience).

## More information

- Realizes the `interservice` section of [`platform.yaml`](../../platform.yaml).
- Transport-as-adapter follows [ADR-0002](0002-hexagonal-architecture.md); security from [ADR-0006](0006-identity-and-access.md)/[ADR-0007](0007-secrets-and-pki.md).
