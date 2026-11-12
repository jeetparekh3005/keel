// Saturation signals (the fourth golden signal): DB connection-pool usage, emitted as
// OpenTelemetry observable gauges. These are polled by the meter provider at collection time,
// so register them once at startup (after initTelemetry has set the global meter provider) and
// they read the LIVE pool on every scrape. With no provider registered this is a no-op, matching
// the HTTP metrics (../http) and the Python vertical's observe_db_pool.
import { type Attributes, type Meter, metrics, ValueType } from '@opentelemetry/api';

import type { PoolStats } from '../persistence/index.js';

/** A live source of connection-pool counts (the Database satisfies this). */
export interface PoolStatsSource {
  stats(): PoolStats;
}

/** Tuning for the DB pool observation: which meter and the pool's name label. */
export interface ObserveDbPoolOptions {
  /** Meter to register against; defaults to the global `@keel/core` meter. */
  meter?: Meter;
  /** Meter name used when `meter` is not supplied. */
  meterName?: string;
  /** `db.client.connection.pool.name` label so multi-pool services do not collapse series. */
  poolName?: string;
}

/**
 * Register observable gauges of DB connection-pool usage (OTel DB semantic conventions):
 * `db.client.connection.count` split by a `state` attribute ({used, idle}) and
 * `db.client.connection.max` (the saturation denominator), both tagged with
 * `db.client.connection.pool.name`. The callbacks read `source.stats()` on each collection, so
 * the gauges always reflect the live pool. used = checked-out (total - idle); idle = warm
 * checked-in connections.
 */
export function observeDbPool(source: PoolStatsSource, options: ObserveDbPoolOptions = {}): void {
  const { meter, meterName = '@keel/core', poolName = 'default' } = options;
  const resolved = meter ?? metrics.getMeter(meterName);
  const base: Attributes = { 'db.client.connection.pool.name': poolName };

  const count = resolved.createObservableGauge('db.client.connection.count', {
    description: 'Database connections by state.',
    unit: '{connection}',
    valueType: ValueType.INT,
  });
  count.addCallback((result) => {
    const stats = source.stats();
    result.observe(stats.total - stats.idle, { ...base, 'db.client.connection.state': 'used' });
    result.observe(stats.idle, { ...base, 'db.client.connection.state': 'idle' });
  });

  const max = resolved.createObservableGauge('db.client.connection.max', {
    description: 'Maximum open connections the pool allows (saturation denominator).',
    unit: '{connection}',
    valueType: ValueType.INT,
  });
  max.addCallback((result) => {
    result.observe(source.stats().max, { ...base });
  });
}
