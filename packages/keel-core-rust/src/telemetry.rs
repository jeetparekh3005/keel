//! OpenTelemetry setup: a shared Resource (service identity), OTLP trace and metric
//! export, and JSON logging. A log line emitted inside a span carries that span's name
//! and fields (under `spans`) plus per-line `trace_id`/`span_id` correlation (see
//! [`crate::redact`]), matching the Python/Go/Java/TS verticals. Export is enabled only
//! when an OTLP endpoint is configured (platform.yaml telemetry); otherwise logs still
//! emit, spans are no-ops (so no correlation ids), and a real-but-reader-less
//! MeterProvider is installed (metrics are still recorded by the SDK, just not exported
//! anywhere). [`observe_db_pool`] registers the DB connection-pool saturation gauges
//! against the global meter.
//!
//! The MeterProvider is always set as the process-global provider so the HTTP edge (see
//! [`crate::http`]) and any other instrumentation can resolve a real meter through
//! `opentelemetry::global::meter`, whether or not OTLP export is configured.
//!
//! Redaction (see [`crate::redact`]) covers the JSON log sink via [`RedactingJsonLayer`]
//! and the OTLP span-export path via [`RedactingSpanExporter`], which wraps the OTLP span
//! exporter below: secret-family attribute keys and secret-valued string attributes on an
//! exported span (and its events/links) are redacted before they reach the collector, the
//! same policy the log sink applies.

use opentelemetry::metrics::{Meter, ObservableGauge};
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::{global, KeyValue};
use opentelemetry_otlp::WithExportConfig as _;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::persistence::Database;
use crate::redact::{RedactingJsonLayer, RedactingSpanExporter};

/// OpenTelemetry DB-semconv metric names and attribute keys for the connection-pool
/// saturation signal (shared with the Python vertical's `observe_db_pool`).
const DB_CONNECTION_COUNT: &str = "db.client.connection.count";
const DB_CONNECTION_MAX: &str = "db.client.connection.max";
const DB_CONNECTION_STATE: &str = "db.client.connection.state";
const DB_POOL_NAME: &str = "db.client.connection.pool.name";

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
                .with_batch_exporter(RedactingSpanExporter::new(exporter))
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

/// Keeps the DB connection-pool observable gauges registered. OpenTelemetry polls the
/// callbacks at collection time, so this handle must be held for the process lifetime
/// (the composition root keeps it alongside [`Telemetry`]); dropping it unregisters them.
pub struct DbPoolGauges {
    _count: ObservableGauge<u64>,
    _max: ObservableGauge<u64>,
}

/// Register observable gauges of DB connection-pool usage (OpenTelemetry DB semantic
/// conventions), mirroring the Python vertical's saturation signal. Emits
/// `db.client.connection.count` by `db.client.connection.state` ({`used`, `idle`}) and
/// `db.client.connection.max` (the saturation denominator), both tagged with
/// `db.client.connection.pool.name` so a service with multiple pools keeps distinct
/// series. The callbacks read the live pool at each collection, so the gauges always
/// reflect current usage.
///
/// Resolves the meter from the process-global MeterProvider installed by [`init`]. Call
/// once after `init` and after the pool is connected; hold the returned handle until
/// shutdown.
#[must_use]
pub fn observe_db_pool(database: &Database, pool_name: &str) -> DbPoolGauges {
    observe_db_pool_with(&global::meter("keel.db"), database, pool_name)
}

/// Like [`observe_db_pool`] but against an explicit [`Meter`], so a test can register the
/// gauges on a local provider with an in-memory reader instead of the process-global one.
#[must_use]
pub fn observe_db_pool_with(meter: &Meter, database: &Database, pool_name: &str) -> DbPoolGauges {
    let pool_name = pool_name.to_string();

    let count_db = database.clone();
    let count_pool = pool_name.clone();
    let count = meter
        .u64_observable_gauge(DB_CONNECTION_COUNT)
        .with_unit("{connection}")
        .with_description("Database connections by state.")
        .with_callback(move |observer| {
            // semconv state enum {used, idle}: used = checked out (size - idle), idle =
            // warm connections not currently checked out.
            let stats = count_db.pool_stats();
            let used = u64::from(stats.size).saturating_sub(u64::from(stats.idle));
            observer.observe(
                used,
                &[
                    KeyValue::new(DB_POOL_NAME, count_pool.clone()),
                    KeyValue::new(DB_CONNECTION_STATE, "used"),
                ],
            );
            observer.observe(
                u64::from(stats.idle),
                &[
                    KeyValue::new(DB_POOL_NAME, count_pool.clone()),
                    KeyValue::new(DB_CONNECTION_STATE, "idle"),
                ],
            );
        })
        .build();

    let max_db = database.clone();
    let max_pool = pool_name;
    let max = meter
        .u64_observable_gauge(DB_CONNECTION_MAX)
        .with_unit("{connection}")
        .with_description("Maximum open connections the pool allows (saturation denominator).")
        .with_callback(move |observer| {
            observer.observe(
                u64::from(max_db.pool_stats().max),
                &[KeyValue::new(DB_POOL_NAME, max_pool.clone())],
            );
        })
        .build();

    DbPoolGauges {
        _count: count,
        _max: max,
    }
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

    #[tokio::test]
    async fn db_pool_gauges_are_observed_with_semconv_states_and_pool_name() {
        use crate::persistence::Database;
        use opentelemetry::metrics::MeterProvider as _;
        use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
        use opentelemetry_sdk::metrics::{InMemoryMetricExporter, SdkMeterProvider};

        let database = Database::connect("sqlite::memory:").await.expect("connect");

        // A local provider + in-memory exporter so a forced collection reads exactly what
        // the gauges observe, independent of the process-global MeterProvider.
        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_periodic_exporter(exporter.clone())
            .build();
        let _gauges = super::observe_db_pool_with(&provider.meter("test"), &database, "default");

        // force_flush triggers a collection cycle, invoking the observable callbacks.
        provider.force_flush().expect("flush");
        let resource_metrics = exporter.get_finished_metrics().expect("metrics");

        let mut count_states: Vec<String> = Vec::new();
        let mut count_pool_names: Vec<String> = Vec::new();
        let mut saw_max = false;
        let mut max_pool_names: Vec<String> = Vec::new();
        for rm in &resource_metrics {
            for scope in rm.scope_metrics() {
                for metric in scope.metrics() {
                    let name = metric.name();
                    if name == super::DB_CONNECTION_COUNT {
                        if let AggregatedMetrics::U64(MetricData::Gauge(gauge)) = metric.data() {
                            for point in gauge.data_points() {
                                for kv in point.attributes() {
                                    match kv.key.as_str() {
                                        super::DB_CONNECTION_STATE => {
                                            count_states.push(kv.value.to_string());
                                        }
                                        super::DB_POOL_NAME => {
                                            count_pool_names.push(kv.value.to_string());
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    } else if name == super::DB_CONNECTION_MAX {
                        if let AggregatedMetrics::U64(MetricData::Gauge(gauge)) = metric.data() {
                            saw_max = true;
                            for point in gauge.data_points() {
                                for kv in point.attributes() {
                                    if kv.key.as_str() == super::DB_POOL_NAME {
                                        max_pool_names.push(kv.value.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // The count gauge carries both semconv states, each tagged with the pool name.
        assert!(
            count_states.iter().any(|s| s == "used"),
            "{} must carry state=used; got {count_states:?}",
            super::DB_CONNECTION_COUNT
        );
        assert!(
            count_states.iter().any(|s| s == "idle"),
            "{} must carry state=idle; got {count_states:?}",
            super::DB_CONNECTION_COUNT
        );
        assert!(
            count_pool_names.iter().all(|p| p == "default") && !count_pool_names.is_empty(),
            "{} points must carry pool.name=default; got {count_pool_names:?}",
            super::DB_CONNECTION_COUNT
        );
        // The saturation denominator is emitted as its own gauge, also tagged with the pool.
        assert!(saw_max, "{} must be observed", super::DB_CONNECTION_MAX);
        assert!(
            max_pool_names.iter().any(|p| p == "default"),
            "{} must carry pool.name=default; got {max_pool_names:?}",
            super::DB_CONNECTION_MAX
        );
    }
}
