package messaging

// Broker-free unit tests for the fail-closed MessageBus env selector (ADR-0025 section 3), mirroring
// the SecretProvider selector's selection tests: more than one gating var fails closed before any
// adapter is built; each single gating var selects the right concrete adapter; none yields the
// in-memory dev default. Construction is lazy (no Connect), so none of these dial a broker. A couple
// of white-box config-wiring checks confirm the selected adapter is built from its documented env.

import (
	"context"
	"strings"
	"testing"
)

// busEnvVars are every variable the selector reads; clearBusEnv blanks them so a test is isolated
// from the ambient environment (CI or a developer shell may have one set).
var busEnvVars = []string{
	envNATSURL, envNATSStream, envNATSSubjects,
	envKafkaBrokers, envKafkaTopics, envKafkaGroupID, envKafkaDLQTopic,
	envRabbitURL, envRabbitExchange, envRabbitQueue, envRabbitDLX, envRabbitSubjects,
}

func clearBusEnv(t *testing.T) {
	t.Helper()
	for _, k := range busEnvVars {
		t.Setenv(k, "")
	}
}

func TestMessageBusFromEnvSelection(t *testing.T) {
	t.Run("in-memory bus when no gating var set", func(t *testing.T) {
		clearBusEnv(t)
		bus, err := MessageBusFromEnv(context.Background())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := bus.(*InMemoryMessageBus); !ok {
			t.Errorf("want *InMemoryMessageBus when no gating var is set, got %T", bus)
		}
	})

	t.Run("nats when KEEL_NATS_URL set", func(t *testing.T) {
		clearBusEnv(t)
		t.Setenv(envNATSURL, "nats://127.0.0.1:4222")
		bus, err := MessageBusFromEnv(context.Background())
		if err != nil {
			t.Fatalf("construct: %v", err)
		}
		if _, ok := bus.(*NatsMessageBus); !ok {
			t.Errorf("want *NatsMessageBus when %s is set, got %T", envNATSURL, bus)
		}
	})

	t.Run("kafka when KEEL_KAFKA_BROKERS set", func(t *testing.T) {
		clearBusEnv(t)
		t.Setenv(envKafkaBrokers, "127.0.0.1:9092")
		bus, err := MessageBusFromEnv(context.Background())
		if err != nil {
			t.Fatalf("construct: %v", err)
		}
		if _, ok := bus.(*KafkaMessageBus); !ok {
			t.Errorf("want *KafkaMessageBus when %s is set, got %T", envKafkaBrokers, bus)
		}
	})

	t.Run("rabbitmq when KEEL_RABBITMQ_URL set", func(t *testing.T) {
		clearBusEnv(t)
		t.Setenv(envRabbitURL, "amqp://127.0.0.1:5672")
		bus, err := MessageBusFromEnv(context.Background())
		if err != nil {
			t.Fatalf("construct: %v", err)
		}
		if _, ok := bus.(*RabbitMessageBus); !ok {
			t.Errorf("want *RabbitMessageBus when %s is set, got %T", envRabbitURL, bus)
		}
	})

	t.Run("multiple backends configured fails construction", func(t *testing.T) {
		// More than one gating var set is an ambiguous misconfiguration (ADR-0025 section 3):
		// construction must fail fast (before any adapter is built) rather than silently pick one.
		for name, vars := range map[string]map[string]string{
			"nats+kafka":   {envNATSURL: "nats://127.0.0.1:4222", envKafkaBrokers: "127.0.0.1:9092"},
			"nats+rabbit":  {envNATSURL: "nats://127.0.0.1:4222", envRabbitURL: "amqp://127.0.0.1:5672"},
			"kafka+rabbit": {envKafkaBrokers: "127.0.0.1:9092", envRabbitURL: "amqp://127.0.0.1:5672"},
			"all three":    {envNATSURL: "nats://127.0.0.1:4222", envKafkaBrokers: "127.0.0.1:9092", envRabbitURL: "amqp://127.0.0.1:5672"},
		} {
			t.Run(name, func(t *testing.T) {
				clearBusEnv(t)
				for k, v := range vars {
					t.Setenv(k, v)
				}
				bus, err := MessageBusFromEnv(context.Background())
				if err == nil {
					t.Fatalf("setting multiple gating vars (%s) must fail construction, got %T", name, bus)
				}
				if bus != nil {
					t.Errorf("a failed selection must return a nil bus, got %T", bus)
				}
			})
		}
	})
}

func TestMessageBusFromEnvMultipleBackendsErrorMessage(t *testing.T) {
	clearBusEnv(t)
	t.Setenv(envNATSURL, "nats://127.0.0.1:4222")
	t.Setenv(envKafkaBrokers, "127.0.0.1:9092")
	_, err := MessageBusFromEnv(context.Background())
	if err == nil {
		t.Fatal("want an error for two gating vars")
	}
	msg := err.Error()
	if !strings.Contains(msg, "multiple message bus backends configured: set at most one of") {
		t.Errorf("error = %q, want the fail-closed at-most-one phrasing", msg)
	}
	for _, v := range []string{envNATSURL, envKafkaBrokers, envRabbitURL} {
		if !strings.Contains(msg, v) {
			t.Errorf("error = %q, want it to name %s", msg, v)
		}
	}
}

func TestMessageBusFromEnvNatsConfig(t *testing.T) {
	t.Run("defaults the stream and subjects when only the URL is set", func(t *testing.T) {
		clearBusEnv(t)
		t.Setenv(envNATSURL, "nats://127.0.0.1:4222")
		bus := mustNats(t)
		if bus.cfg.Stream != defaultNATSStream {
			t.Errorf("Stream = %q, want %q", bus.cfg.Stream, defaultNATSStream)
		}
		if len(bus.cfg.Subjects) != 1 || bus.cfg.Subjects[0] != defaultNATSSubjects {
			t.Errorf("Subjects = %v, want [%q]", bus.cfg.Subjects, defaultNATSSubjects)
		}
	})

	t.Run("reads the documented stream and comma-separated subjects", func(t *testing.T) {
		clearBusEnv(t)
		t.Setenv(envNATSURL, "nats://127.0.0.1:4222")
		t.Setenv(envNATSStream, "orders")
		t.Setenv(envNATSSubjects, "orders.>, billing.>")
		bus := mustNats(t)
		if bus.cfg.URL != "nats://127.0.0.1:4222" {
			t.Errorf("URL = %q, want the configured URL", bus.cfg.URL)
		}
		if bus.cfg.Stream != "orders" {
			t.Errorf("Stream = %q, want orders", bus.cfg.Stream)
		}
		want := []string{"orders.>", "billing.>"}
		if len(bus.cfg.Subjects) != len(want) {
			t.Fatalf("Subjects = %v, want %v", bus.cfg.Subjects, want)
		}
		for i, s := range want {
			if bus.cfg.Subjects[i] != s {
				t.Errorf("Subjects[%d] = %q, want %q (trimmed, split on comma)", i, bus.cfg.Subjects[i], s)
			}
		}
	})
}

func TestMessageBusFromEnvKafkaConfig(t *testing.T) {
	clearBusEnv(t)
	t.Setenv(envKafkaBrokers, "a:9092, b:9092")
	t.Setenv(envKafkaTopics, "keel.test")
	t.Setenv(envKafkaGroupID, "workers")
	t.Setenv(envKafkaDLQTopic, "keel.dead")
	bus, err := MessageBusFromEnv(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	kb, ok := bus.(*KafkaMessageBus)
	if !ok {
		t.Fatalf("want *KafkaMessageBus, got %T", bus)
	}
	if len(kb.cfg.Brokers) != 2 || kb.cfg.Brokers[0] != "a:9092" || kb.cfg.Brokers[1] != "b:9092" {
		t.Errorf("Brokers = %v, want [a:9092 b:9092]", kb.cfg.Brokers)
	}
	if kb.cfg.GroupID != "workers" {
		t.Errorf("GroupID = %q, want workers", kb.cfg.GroupID)
	}
	if kb.cfg.DLQTopic != "keel.dead" {
		t.Errorf("DLQTopic = %q, want keel.dead", kb.cfg.DLQTopic)
	}
}

func TestMessageBusFromEnvRabbitConfig(t *testing.T) {
	clearBusEnv(t)
	t.Setenv(envRabbitURL, "amqp://127.0.0.1:5672")
	t.Setenv(envRabbitExchange, "events")
	t.Setenv(envRabbitQueue, "workers")
	t.Setenv(envRabbitDLX, "events.dlx")
	bus, err := MessageBusFromEnv(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	rb, ok := bus.(*RabbitMessageBus)
	if !ok {
		t.Fatalf("want *RabbitMessageBus, got %T", bus)
	}
	if rb.cfg.URL != "amqp://127.0.0.1:5672" {
		t.Errorf("URL = %q, want the configured URL", rb.cfg.URL)
	}
	if rb.cfg.Exchange != "events" || rb.cfg.Queue != "workers" || rb.cfg.DLX != "events.dlx" {
		t.Errorf("exchange/queue/dlx = %q/%q/%q, want events/workers/events.dlx", rb.cfg.Exchange, rb.cfg.Queue, rb.cfg.DLX)
	}
}

// mustNats selects the bus and asserts it is the NATS adapter, returning it for config inspection.
func mustNats(t *testing.T) *NatsMessageBus {
	t.Helper()
	bus, err := MessageBusFromEnv(context.Background())
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	nb, ok := bus.(*NatsMessageBus)
	if !ok {
		t.Fatalf("want *NatsMessageBus, got %T", bus)
	}
	return nb
}
