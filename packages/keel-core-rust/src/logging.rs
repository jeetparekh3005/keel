//! Structured JSON logging (platform.yaml logging: json, leveled, one line per event).
//!
//! Installs a global `tracing` subscriber that emits one JSON object per event with
//! the level and message. Per-event `service`/`version` and `trace_id`/`span_id`
//! correlation are attached by the OpenTelemetry layer (a later slice adds the OTLP
//! resource + span context); this slice establishes the JSON log stream and leveling.

use tracing_subscriber::fmt;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

/// Install a global JSON logging subscriber at `level` (e.g. `"info"`, `"debug"`).
///
/// Safe to call once at startup; a second call is a no-op (the global subscriber is
/// install-once), so it will not panic in tests or re-entrant setup. An unparseable
/// level falls back to `info`.
pub fn init(level: &str) {
    let filter = EnvFilter::try_new(level).unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().json().flatten_event(true))
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::init;

    #[test]
    fn init_is_idempotent_and_tolerates_a_bad_level() {
        init("debug");
        init("not-a-level"); // falls back to info; second install is a no-op
    }
}
