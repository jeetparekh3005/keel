//! OpenTelemetry setup: a shared Resource (service identity), OTLP trace and metric
//! export, and JSON logging. A log line emitted inside a span carries that span's name
//! and fields (under `spans`); per-line `trace_id`/`span_id` correlation is not yet
//! emitted (a tracked v0.4 parity item vs the Python vertical). Export is enabled only
//! when an OTLP endpoint is configured (platform.yaml telemetry); otherwise logs still
//! emit, spans are no-ops, and a real-but-reader-less MeterProvider is installed (metrics
//! are still recorded by the SDK, just not exported anywhere).
//!
//! The MeterProvider is always set as the process-global provider so the HTTP edge (see
//! [`crate::http`]) and any other instrumentation can resolve a real meter through
//! `opentelemetry::global::meter`, whether or not OTLP export is configured.
//!
//! Redaction (see [`crate::redact`]) covers the JSON log sink. It does NOT cover the OTLP
//! span-export path: values recorded as span fields or in-span event fields are exported
//! to the collector as-is, so secrets must not be put in span fields when export is on.

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig as _;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::redact::RedactingJsonLayer;

/// The providers installed by [`init`]. Hold it until service shutdown, then pass it to
/// [`shutdown`] to flush the exporters cleanly. The tracer is present only when OTLP
/// export is enabled; the meter is always present and is always set as the global
/// MeterProvider.
pub struct Telemetry {
    tracer: Option<SdkTracerProvider>,
    meter: SdkMeterProvider,
}

impl Telemetry {
    /// Whether an OTLP tracer provider was installed (i.e. an endpoint was configured).
    #[must_use]
    pub fn exports_traces(&self) -> bool {
        self.tracer.is_some()
    }
}

/// Build the shared telemetry Resource: service name/version, deployment environment,
/// and a per-instance id (so replicas are distinguishable in traces/metrics).
#[must_use]
pub fn resource(service: &str, version: &str, environment: &str) -> Resource {
    Resource::builder()
        .with_service_name(service.to_string())
        .with_attributes([
            KeyValue::new("service.version", version.to_string()),
            KeyValue::new("deployment.environment.name", environment.to_string()),
            KeyValue::new("service.instance.id", uuid::Uuid::new_v4().to_string()),
        ])
        .build()
}

/// Install the global subscriber: a redacting JSON log layer (leveled) plus, when
/// `otlp_endpoint` is set, an OpenTelemetry layer that exports spans over OTLP. Always
/// installs and globally sets a real MeterProvider (exporting over OTLP when an endpoint
/// is given). Returns the [`Telemetry`] handle; call [`shutdown`] at exit to flush.
///
/// Safe to call once at startup; a second registry init is a no-op.
///
/// # Panics
/// Panics if an OTLP endpoint is given but a span or metric exporter cannot be constructed.
pub fn init(
    service: &str,
    version: &str,
    environment: &str,
    level: &str,
    otlp_endpoint: Option<&str>,
) -> Telemetry {
    let filter = EnvFilter::try_new(level).unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt_layer = RedactingJsonLayer::new(std::io::stdout);

    let (otel_layer, tracer) = match otlp_endpoint {
        Some(endpoint) => {
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_tonic()
                .with_endpoint(endpoint)
                .build()
                .expect("build OTLP span exporter");
            let provider = SdkTracerProvider::builder()
                .with_resource(resource(service, version, environment))
                .with_batch_exporter(exporter)
                .build();
            let tracer = provider.tracer("keel");
            (
                Some(tracing_opentelemetry::layer().with_tracer(tracer)),
                Some(provider),
            )
        }
        None => (None, None),
    };

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .with(otel_layer)
        .try_init();

    let meter = init_meter_provider(service, version, environment, otlp_endpoint);
    Telemetry { tracer, meter }
}

/// Build a real [`SdkMeterProvider`] and set it as the global provider. When an OTLP
/// endpoint is configured a periodic exporter ships metrics to the collector; otherwise
/// the provider has no reader (metrics are recorded by the SDK but not exported), so the
/// global meter is still real and the HTTP edge records against it.
///
/// # Panics
/// Panics if an OTLP endpoint is given but the metric exporter cannot be constructed.
fn init_meter_provider(
    service: &str,
    version: &str,
    environment: &str,
    otlp_endpoint: Option<&str>,
) -> SdkMeterProvider {
    let mut builder =
        SdkMeterProvider::builder().with_resource(resource(service, version, environment));
    if let Some(endpoint) = otlp_endpoint {
        let exporter = opentelemetry_otlp::MetricExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint)
            .build()
            .expect("build OTLP metric exporter");
        builder = builder.with_periodic_exporter(exporter);
    }
    let provider = builder.build();
    opentelemetry::global::set_meter_provider(provider.clone());
    provider
}

/// Flush and shut down the tracer and meter providers (call at service shutdown).
pub fn shutdown(telemetry: Telemetry) {
    if let Some(tracer) = telemetry.tracer {
        let _ = tracer.shutdown();
    }
    let _ = telemetry.meter.shutdown();
}

#[cfg(test)]
mod tests {
    use super::{init, resource};
    use opentelemetry::Key;

    #[test]
    fn resource_carries_service_identity() {
        let resource = resource("ref-svc", "1.2.3", "staging");
        assert_eq!(
            resource
                .get(&Key::from_static_str("service.name"))
                .map(|value| value.to_string()),
            Some("ref-svc".to_string())
        );
        assert_eq!(
            resource
                .get(&Key::from_static_str("deployment.environment.name"))
                .map(|value| value.to_string()),
            Some("staging".to_string())
        );
        assert!(resource
            .get(&Key::from_static_str("service.instance.id"))
            .is_some());
    }

    #[test]
    fn init_without_otlp_endpoint_emits_logs_and_no_tracer() {
        // No endpoint -> logging plus a real (reader-less) meter, but no tracer provider;
        // must not panic or double-init. A real global meter is still installed so the
        // HTTP edge records metrics even when export is off.
        let telemetry = init("svc", "0", "test", "info", None);
        assert!(!telemetry.exports_traces());
        super::shutdown(telemetry);
    }
}
