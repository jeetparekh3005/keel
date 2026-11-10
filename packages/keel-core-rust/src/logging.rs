//! Structured JSON logging (platform.yaml logging: json, leveled, one line per event).
//!
//! Installs a global `tracing` subscriber that emits one JSON object per event via
//! [`crate::redact::RedactingJsonLayer`], so secret-keyed fields and secret-valued strings
//! are redacted before they reach the sink (mirroring the Python vertical). The richer
//! path in [`crate::telemetry`] adds the OpenTelemetry resource and span export on top.
//! A service calls one or the other, not both.

use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::redact::RedactingJsonLayer;

/// Install a global JSON logging subscriber at `level` (e.g. `"info"`, `"debug"`).
///
/// Safe to call once at startup; a second call is a no-op (the global subscriber is
/// install-once), so it will not panic in tests or re-entrant setup. An invalid
/// level string falls back to `info`.
pub fn init(level: &str) {
    let filter = EnvFilter::try_new(level).unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(RedactingJsonLayer::new(std::io::stdout))
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::init;
    use crate::redact::RedactingJsonLayer;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;
    use tracing_subscriber::prelude::*;

    #[test]
    fn init_is_idempotent_and_tolerates_a_bad_level() {
        init("debug");
        init("not-a-level"); // falls back to info; second install is a no-op
    }

    #[derive(Clone)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl Write for Buf {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> MakeWriter<'a> for Buf {
        type Writer = Buf;
        fn make_writer(&'a self) -> Buf {
            self.clone()
        }
    }

    #[test]
    fn secrets_are_redacted_in_the_emitted_json() {
        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let subscriber = tracing_subscriber::registry().with(RedactingJsonLayer::new(buf.clone()));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(
                password = "hunter2",
                user_id = 7,
                note = "key AKIAIOSFODNN7EXAMPLE leaked",
                "login attempt"
            );
        });

        let output = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        let line = output.lines().last().expect("a log line");
        let record: serde_json::Value = serde_json::from_str(line).expect("valid JSON log line");
        // Event-level formatting is preserved, and secrets are redacted.
        assert_eq!(record["message"], "login attempt");
        assert_eq!(record["level"], "info");
        assert_eq!(record["password"], "[REDACTED]"); // secret-keyed field
        assert_eq!(record["user_id"], 7); // non-secret passes through
        assert_eq!(record["note"], "key [REDACTED] leaked"); // secret value scrubbed
    }
}
