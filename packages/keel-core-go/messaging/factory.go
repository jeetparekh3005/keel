package messaging

// MessageBus selection (ADR-0025 section 3). The composition root picks exactly one backend from
// the environment: NATS JetStream when KEEL_NATS_URL is set, Kafka when KEEL_KAFKA_BROKERS is set,
// RabbitMQ when KEEL_RABBITMQ_URL is set, and the in-process InMemoryMessageBus when none is.
// Setting more than one gating var is an ambiguous misconfiguration that fails construction rather
// than silently choosing one, mirroring the SecretProvider selector (ADR-0024).

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

// Gating and configuration environment variables (ADR-0025 section 3). Each backend is gated by a
// single variable; the others tune the selected adapter.
const (
	envNATSURL      = "KEEL_NATS_URL"      // gates the NATS JetStream backend.
	envNATSStream   = "KEEL_NATS_STREAM"   // the JetStream stream; defaults to "keel".
	envNATSSubjects = "KEEL_NATS_SUBJECTS" // comma-separated stream subjects; defaults to "keel.>".

	envKafkaBrokers  = "KEEL_KAFKA_BROKERS"   // gates the Kafka backend; comma-separated bootstrap servers.
	envKafkaTopics   = "KEEL_KAFKA_TOPICS"    // comma-separated topics/subjects; NewKafka defaults to "keel".
	envKafkaGroupID  = "KEEL_KAFKA_GROUP_ID"  // the consumer group; NewKafka defaults to "keel".
	envKafkaDLQTopic = "KEEL_KAFKA_DLQ_TOPIC" // optional shared dead-letter topic override.

	envRabbitURL      = "KEEL_RABBITMQ_URL"      // gates the RabbitMQ backend.
	envRabbitExchange = "KEEL_RABBITMQ_EXCHANGE" // the topic exchange; NewRabbit defaults to "keel".
	envRabbitQueue    = "KEEL_RABBITMQ_QUEUE"    // the durable queue; NewRabbit defaults to "keel".
	envRabbitDLX      = "KEEL_RABBITMQ_DLX"      // the dead-letter exchange; NewRabbit defaults to "keel.dlx".
	envRabbitSubjects = "KEEL_RABBITMQ_SUBJECTS" // comma-separated binding keys; NewRabbit defaults to "keel.#".
)

// NATS defaults, applied here because New (unlike NewKafka and NewRabbit) does not default the
// stream or subjects; the Kafka and RabbitMQ defaults live in their own constructors.
const (
	defaultNATSStream   = "keel"
	defaultNATSSubjects = "keel.>"
)

// MessageBusFromEnv is the composition-root factory for the MessageBus port (ADR-0025 section 3).
// It selects the bus from exactly one gating variable and returns it unconnected: the broker
// adapters are lazy (no connection is dialed until Connect), so building the bus never blocks
// startup. Setting more than one gating var is an ambiguous misconfiguration that fails closed
// before any adapter is built rather than silently choosing one. None set yields the in-process
// InMemoryMessageBus, the dev/test default. The returned bus may be an io.Closer (the broker
// adapters are); callers that manage lifecycle should type-assert and Close it on shutdown.
//
// The context is accepted for signature parity with the other composition-root factories and for
// the caller to thread into the subsequent Connect; it is unused here because construction is lazy.
func MessageBusFromEnv(ctx context.Context) (ports.MessageBus, error) {
	_ = ctx

	nats := strings.TrimSpace(os.Getenv(envNATSURL)) != ""
	kafka := strings.TrimSpace(os.Getenv(envKafkaBrokers)) != ""
	rabbit := strings.TrimSpace(os.Getenv(envRabbitURL)) != ""

	if countTrue(nats, kafka, rabbit) > 1 {
		return nil, fmt.Errorf("multiple message bus backends configured: set at most one of %s, %s, %s", envNATSURL, envKafkaBrokers, envRabbitURL)
	}

	switch {
	case nats:
		return newNatsFromEnv(), nil
	case kafka:
		return newKafkaFromEnv(), nil
	case rabbit:
		return newRabbitFromEnv(), nil
	default:
		return NewInMemory(), nil
	}
}

// newNatsFromEnv builds the NATS JetStream bus from its documented env, applying the stream and
// subject defaults that New does not.
func newNatsFromEnv() *NatsMessageBus {
	return New(Config{
		URL:      strings.TrimSpace(os.Getenv(envNATSURL)),
		Stream:   getenvOr(envNATSStream, defaultNATSStream),
		Subjects: splitList(envNATSSubjects, defaultNATSSubjects),
	})
}

// newKafkaFromEnv builds the Kafka bus from its documented env; NewKafka defaults the topics and
// consumer group when they are empty.
func newKafkaFromEnv() *KafkaMessageBus {
	return NewKafka(KafkaConfig{
		Brokers:  splitList(envKafkaBrokers),
		Topics:   splitList(envKafkaTopics),
		GroupID:  strings.TrimSpace(os.Getenv(envKafkaGroupID)),
		DLQTopic: strings.TrimSpace(os.Getenv(envKafkaDLQTopic)),
	})
}

// newRabbitFromEnv builds the RabbitMQ bus from its documented env; NewRabbit defaults the exchange,
// queue, binding subjects, and dead-letter exchange when they are empty.
func newRabbitFromEnv() *RabbitMessageBus {
	return NewRabbit(RabbitConfig{
		URL:      strings.TrimSpace(os.Getenv(envRabbitURL)),
		Exchange: strings.TrimSpace(os.Getenv(envRabbitExchange)),
		Queue:    strings.TrimSpace(os.Getenv(envRabbitQueue)),
		Subjects: splitList(envRabbitSubjects),
		DLX:      strings.TrimSpace(os.Getenv(envRabbitDLX)),
	})
}

// countTrue counts the set gating vars, so "more than one backend configured" is a single clear
// check rather than a growing matrix of pairwise conditions (mirrors the SecretProvider selector).
func countTrue(flags ...bool) int {
	n := 0
	for _, f := range flags {
		if f {
			n++
		}
	}
	return n
}

// getenvOr returns the trimmed value of key, or fallback when it is unset or blank.
func getenvOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// splitList parses a comma-separated env var into trimmed, non-empty items, returning fallback when
// the var is unset or blank. An empty fallback (no variadic argument) yields a nil slice, letting
// the adapter constructor apply its own default.
func splitList(key string, fallback ...string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return fallback
	}
	return out
}
