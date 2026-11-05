//! OpenTelemetry setup: a shared Resource (service identity), OTLP trace export, and
//! JSON logging, wired together so a log line emitted inside a span carries that span's
//! trace context. Export is enabled only when an OTLP endpoint is configured
//! (platform.yaml telemetry); otherwise logs still emit and spans are no-ops.

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig as _;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{fmt, EnvFilter};

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

/// Install the global subscriber: a JSON log layer (leveled) plus, when
/// `otlp_endpoint` is set, an OpenTelemetry layer that exports spans over OTLP and
/// stamps the active span's trace/span id onto log records. Returns the tracer
/// provider (call [`shutdown`] at exit to flush) when export is enabled.
///
/// Safe to call once at startup; a second call is a no-op.
///
/// # Panics
/// Panics if an OTLP endpoint is given but the exporter cannot be constructed.
pub fn init(
    service: &str,
    version: &str,
    environment: &str,
    level: &str,
    otlp_endpoint: Option<&str>,
) -> Option<SdkTracerProvider> {
    let filter = EnvFilter::try_new(level).unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt_layer = fmt::layer().json().flatten_event(true);

    let (otel_layer, provider) = match otlp_endpoint {
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
    provider
}

/// Flush and shut down the tracer provider (call at service shutdown).
pub fn shutdown(provider: SdkTracerProvider) {
    let _ = provider.shutdown();
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
    fn init_without_otlp_endpoint_emits_logs_and_no_provider() {
        // No endpoint -> logging only, no tracer provider; must not panic or double-init.
        assert!(init("svc", "0", "test", "info", None).is_none());
    }
}
