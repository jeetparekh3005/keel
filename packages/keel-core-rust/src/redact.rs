//! Log redaction: family-based key redaction plus value pattern scrubbing, mirroring the
//! Python vertical (`keel_core.adapters.outbound.logging`). [`RedactingJsonLayer`] emits
//! one redacted JSON object per event (and redacts span fields), and is installed by
//! [`crate::logging`] and [`crate::telemetry`], so a secret logged under any key (or
//! inside a value) is redacted before it reaches the JSON **log sink**.
//!
//! Scope: this covers the JSON log output only. It does NOT redact the OTLP span-export
//! path (see [`crate::telemetry`]); span/event field values are exported as-is, so secrets
//! must not be placed in span fields when OTLP export is enabled.

use std::io::Write;
use std::sync::OnceLock;

use opentelemetry::trace::TraceContextExt;
use regex::Regex;
use serde_json::{Map, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Record};
use tracing::{Event, Id, Subscriber};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

const REDACTED: &str = "[REDACTED]";
/// Cap on a single rendered string field (matches the Python `_DEFAULT_MAX_FIELD_LEN`).
const MAX_FIELD_LEN: usize = 8192;

/// Canonical top-level keys this layer emits; a colliding user field is `x_`-namespaced so
/// it cannot overwrite the real value (mirrors the Python vertical's reserved-field set).
/// `trace_id`/`span_id` are reserved too: the real correlation ids are injected by this
/// layer and must survive both a user-field collision and redaction (a valid hex id is not
/// a secret).
const RESERVED_KEYS: &[&str] = &[
    "timestamp",
    "level",
    "target",
    "spans",
    "trace_id",
    "span_id",
];

/// Key fragments (matched against a normalized, lowercased, separator-stripped key) that
/// mark a field as secret; its value is redacted wholesale. Mirrors the Python families.
const SECRET_KEY_FRAGMENTS: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "cookie",
    "authorization",
    "credential",
    "privatekey",
    "pii",
];

/// True if `key` belongs to a secret family (case/separator-insensitive substring match).
fn is_secret_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|c| *c != '-' && *c != '_')
        .flat_map(char::to_lowercase)
        .collect();
    SECRET_KEY_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
}

/// High-precision secret patterns scrubbed from any string value (JWT, AWS key id, bearer
/// token, PEM private-key header). Compiled once.
fn secret_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            [
                r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
                r"AKIA[0-9A-Z]{16}",
                r"(?i)bearer\s+[A-Za-z0-9._~+/-]{8,}=*",
                r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----",
            ]
            .iter()
            .map(|pattern| Regex::new(pattern).expect("valid secret regex"))
            .collect()
        })
        .as_slice()
}

/// Candidate credit-card-like digit runs; only redacted if Luhn-valid (avoids nuking any
/// long number). Mirrors the Python `_CC_CANDIDATE` + Luhn check.
fn cc_candidate() -> &'static Regex {
    static CC: OnceLock<Regex> = OnceLock::new();
    CC.get_or_init(|| Regex::new(r"(?:\d[ -]?){13,19}").expect("valid cc regex"))
}

fn luhn_ok(digits: &str) -> bool {
    let mut sum = 0u32;
    let mut double = false;
    for ch in digits.chars().rev() {
        let Some(d) = ch.to_digit(10) else {
            return false;
        };
        let mut d = d;
        if double {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
        double = !double;
    }
    sum % 10 == 0
}

/// Scrub secret patterns and Luhn-valid card numbers from a string value.
fn scrub_text(text: &str) -> String {
    let mut out = text.to_string();
    for pattern in secret_patterns() {
        out = pattern.replace_all(&out, REDACTED).into_owned();
    }
    out = cc_candidate()
        .replace_all(&out, |caps: &regex::Captures| {
            let matched = &caps[0];
            let digits: String = matched.chars().filter(char::is_ascii_digit).collect();
            if (13..=19).contains(&digits.len()) && luhn_ok(&digits) {
                REDACTED.to_string()
            } else {
                matched.to_string()
            }
        })
        .into_owned();
    out
}

fn truncate(text: String) -> String {
    if text.len() <= MAX_FIELD_LEN {
        return text;
    }
    let dropped = text.len() - MAX_FIELD_LEN;
    let mut cut = MAX_FIELD_LEN;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}...(truncated {dropped} chars)", &text[..cut])
}

/// Recursively redact: secret-keyed entries wholesale, string values scrubbed and capped,
/// nested objects/arrays descended; other scalars pass through.
fn redact_value(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (key, item) in map {
                if is_secret_key(&key) {
                    out.insert(key, Value::String(REDACTED.to_string()));
                } else {
                    out.insert(key, redact_value(item));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact_value).collect()),
        Value::String(text) => Value::String(truncate(scrub_text(&text))),
        other => other,
    }
}

/// Collects tracing event/span fields into a JSON map for redaction.
struct Collector<'a>(&'a mut Map<String, Value>);

impl Visit for Collector<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0
            .insert(field.name().to_string(), Value::String(value.to_string()));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().to_string(), Value::Bool(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0
            .insert(field.name().to_string(), Value::Number(value.into()));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0
            .insert(field.name().to_string(), Value::Number(value.into()));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        if let Some(number) = serde_json::Number::from_f64(value) {
            self.0
                .insert(field.name().to_string(), Value::Number(number));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(
            field.name().to_string(),
            Value::String(format!("{value:?}")),
        );
    }
}

fn record_to_object<R>(record: impl FnOnce(&mut Collector) -> R) -> Map<String, Value> {
    let mut map = Map::new();
    let mut collector = Collector(&mut map);
    record(&mut collector);
    match redact_value(Value::Object(map)) {
        Value::Object(object) => object,
        _ => Map::new(),
    }
}

/// The lowercase level name, matching the Python vertical's log schema.
fn level_name(level: &tracing::Level) -> &'static str {
    match *level {
        tracing::Level::ERROR => "error",
        tracing::Level::WARN => "warn",
        tracing::Level::INFO => "info",
        tracing::Level::DEBUG => "debug",
        tracing::Level::TRACE => "trace",
    }
}

/// Redacted span fields, stored as a span extension so an event can include its scope.
struct SpanFields(Map<String, Value>);

/// A tracing [`Layer`] that emits one redacted JSON object per event (`platform.yaml`
/// logging: json, leveled, one line per event). Event and span fields are run through
/// [`redact_value`], so secret-keyed fields and secret-valued strings never reach the
/// sink. Generic over a [`MakeWriter`] (stdout in production, a buffer in tests).
pub struct RedactingJsonLayer<W> {
    make_writer: W,
}

impl<W> RedactingJsonLayer<W> {
    /// Build the layer writing to `make_writer` (e.g. `std::io::stdout`).
    pub fn new(make_writer: W) -> Self {
        Self { make_writer }
    }
}

impl<S, W> Layer<S> for RedactingJsonLayer<W>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    W: for<'a> MakeWriter<'a> + 'static,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let fields = record_to_object(|c| attrs.record(c));
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(SpanFields(fields));
        }
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id) {
            let added = record_to_object(|c| values.record(c));
            let mut extensions = span.extensions_mut();
            if let Some(SpanFields(existing)) = extensions.get_mut::<SpanFields>() {
                existing.extend(added);
            } else {
                extensions.insert(SpanFields(added));
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut object = Map::new();
        if let Ok(timestamp) = OffsetDateTime::now_utc().format(&Rfc3339) {
            object.insert("timestamp".to_string(), Value::String(timestamp));
        }
        object.insert(
            "level".to_string(),
            Value::String(level_name(meta.level()).to_string()),
        );
        object.insert(
            "target".to_string(),
            Value::String(meta.target().to_string()),
        );
        // Per-line log-to-trace correlation: stamp the enclosing span's OpenTelemetry
        // trace/span id onto every record emitted inside an active span, so a log line can
        // be joined to its trace (parity with the Python/Go/Java/TS verticals). The
        // tracing-opentelemetry layer activates each span's OTel context on entry, so the
        // current context carries the active span; when no OpenTelemetry layer is installed
        // (OTLP export off) the context is empty and the span context is invalid, so nothing
        // is emitted. These are injected directly (not via `record_to_object`), so a valid
        // hex id survives redaction, and they are reserved keys so a user field of the same
        // name cannot clobber them.
        let span_context = opentelemetry::Context::current();
        let span_context = span_context.span();
        let span_context = span_context.span_context();
        if span_context.is_valid() {
            object.insert(
                "trace_id".to_string(),
                Value::String(span_context.trace_id().to_string()),
            );
            object.insert(
                "span_id".to_string(),
                Value::String(span_context.span_id().to_string()),
            );
        }
        // Event fields (already redacted), flattened to the top level; "message" included.
        // A user field that collides with a canonical key this layer injects is namespaced
        // with an `x_` prefix (mirroring the Python vertical's reserved-field protection),
        // so it cannot clobber the real timestamp/level/target/spans.
        for (key, value) in record_to_object(|c| event.record(c)) {
            if RESERVED_KEYS.contains(&key.as_str()) {
                object.insert(format!("x_{key}"), value);
            } else {
                object.insert(key, value);
            }
        }
        // The enclosing span scope, each span's redacted fields included for correlation.
        if let Some(scope) = ctx.event_scope(event) {
            let spans: Vec<Value> = scope
                .from_root()
                .map(|span| {
                    let mut entry = Map::new();
                    entry.insert("name".to_string(), Value::String(span.name().to_string()));
                    if let Some(SpanFields(fields)) = span.extensions().get::<SpanFields>() {
                        for (key, value) in fields {
                            entry.insert(key.clone(), value.clone());
                        }
                    }
                    Value::Object(entry)
                })
                .collect();
            if !spans.is_empty() {
                object.insert("spans".to_string(), Value::Array(spans));
            }
        }
        if let Ok(mut line) = serde_json::to_vec(&Value::Object(object)) {
            line.push(b'\n');
            let _ = self.make_writer.make_writer().write_all(&line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_secret_key, redact_value, scrub_text, RedactingJsonLayer};
    use serde_json::json;
    use std::io;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::Registry;

    #[test]
    fn secret_key_families_match_across_separators_and_case() {
        for key in [
            "password",
            "X-Api-Key",
            "access_token",
            "Set-Cookie",
            "client_secret",
        ] {
            assert!(is_secret_key(key), "{key} should be secret");
        }
        for key in ["user_id", "name", "count", "status"] {
            assert!(!is_secret_key(key), "{key} should not be secret");
        }
    }

    #[test]
    fn value_patterns_are_scrubbed() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5NXgL0n3I9";
        assert_eq!(scrub_text(jwt), "[REDACTED]");
        assert_eq!(scrub_text("AKIAIOSFODNN7EXAMPLE"), "[REDACTED]");
        assert!(scrub_text("Bearer abcdef12345").contains("[REDACTED]"));
        // \s+ in the bearer pattern: a token separated by more than one space is still scrubbed
        // (the two-space vector the TS/Java v0.4 review flagged; #359 parity back-port).
        assert!(scrub_text("Bearer  abcdef12345").contains("[REDACTED]"));
        // Luhn-valid card redacted; a random long number is left alone.
        assert_eq!(scrub_text("4111 1111 1111 1111"), "[REDACTED]");
        assert_eq!(scrub_text("1234567890123456"), "1234567890123456");
    }

    #[test]
    fn nested_secret_key_and_value_are_redacted() {
        let value = json!({
            "password": "hunter2",
            "user_id": 7,
            "inner": { "api_key": "k", "ok": 1 },
            "note": "AKIAIOSFODNN7EXAMPLE here",
        });
        let redacted = redact_value(value);
        assert_eq!(redacted["password"], "[REDACTED]");
        assert_eq!(redacted["user_id"], 7);
        assert_eq!(redacted["inner"]["api_key"], "[REDACTED]");
        assert_eq!(redacted["inner"]["ok"], 1);
        assert_eq!(redacted["note"], "[REDACTED] here");
    }

    /// A `MakeWriter` that captures every emitted line into a shared buffer, so a test can
    /// read back exactly what the layer wrote.
    #[derive(Clone)]
    struct BufferWriter(Arc<Mutex<Vec<u8>>>);

    impl io::Write for BufferWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("buffer lock").extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for BufferWriter {
        type Writer = BufferWriter;

        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn log_event_inside_a_span_carries_trace_and_span_ids() {
        use opentelemetry::trace::TracerProvider as _;
        use opentelemetry_sdk::trace::SdkTracerProvider;

        // A real tracer provider + the tracing-opentelemetry layer so entering a span
        // activates a valid OTel context; the redacting layer then stamps the ids. No
        // exporter is needed: ids are generated regardless of export.
        let provider = SdkTracerProvider::builder().build();
        let tracer = provider.tracer("test");
        let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

        let buffer = Arc::new(Mutex::new(Vec::new()));
        let subscriber = Registry::default()
            .with(otel_layer)
            .with(RedactingJsonLayer::new(BufferWriter(buffer.clone())));

        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!("unit-of-work");
            let _entered = span.enter();
            tracing::info!("inside the span");
        });

        let bytes = buffer.lock().expect("buffer lock").clone();
        let text = String::from_utf8(bytes).expect("utf8 log output");
        let line = text.lines().next().expect("a log line was emitted");
        let value: serde_json::Value = serde_json::from_str(line).expect("valid json log line");

        let trace_id = value["trace_id"]
            .as_str()
            .expect("trace_id must be present on a log emitted inside a span");
        let span_id = value["span_id"]
            .as_str()
            .expect("span_id must be present on a log emitted inside a span");
        // A W3C trace id is 32 hex chars; a span id is 16; neither may be the all-zero
        // (invalid) id, which would mean the correlation did not actually resolve.
        assert_eq!(
            trace_id.len(),
            32,
            "trace_id must be 32 hex chars: {trace_id}"
        );
        assert!(trace_id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(trace_id, "0".repeat(32));
        assert_eq!(span_id.len(), 16, "span_id must be 16 hex chars: {span_id}");
        assert!(span_id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(span_id, "0".repeat(16));
    }

    #[test]
    fn log_event_without_a_span_has_no_correlation_ids() {
        // No OpenTelemetry layer and no active span: the current context is empty, so the
        // correlation ids are absent rather than emitted as the all-zero invalid id.
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let subscriber =
            Registry::default().with(RedactingJsonLayer::new(BufferWriter(buffer.clone())));

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("no span here");
        });

        let bytes = buffer.lock().expect("buffer lock").clone();
        let text = String::from_utf8(bytes).expect("utf8 log output");
        let line = text.lines().next().expect("a log line was emitted");
        let value: serde_json::Value = serde_json::from_str(line).expect("valid json log line");
        assert!(value.get("trace_id").is_none());
        assert!(value.get("span_id").is_none());
    }
}
