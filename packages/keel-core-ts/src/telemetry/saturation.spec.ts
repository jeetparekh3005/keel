import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it } from 'vitest';

import type { PoolStats } from '../persistence/index.js';
import { observeDbPool, type PoolStatsSource } from './saturation.js';

// A fake pool: fixed counts prove the gauge callbacks read stats() at collection time, without a
// real Postgres. total=8, idle=3 => used = total - idle = 5; max = 10 is the denominator.
class FakePool implements PoolStatsSource {
  stats(): PoolStats {
    return { total: 8, idle: 3, waiting: 0, max: 10 };
  }
}

interface Collected {
  name: string;
  unit: string;
  dataPoints: DataPoint<number>[];
}

// Proves the DB pool saturation gauges are ACTUALLY emitted with OTel DB-semconv names and
// attributes - not just that a meter is wired. It FAILS if observeDbPool's registration is
// removed (no instrument is created, so neither metric appears in the collected batch).
describe('observeDbPool (saturation gauges)', () => {
  let provider: MeterProvider;

  afterEach(async () => {
    await provider.shutdown();
  });

  async function collect(
    register: (source: PoolStatsSource, provider: MeterProvider) => void,
  ): Promise<Collected[]> {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    // A long interval so nothing exports until forceFlush() collects deterministically.
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    provider = new MeterProvider({ readers: [reader] });
    register(new FakePool(), provider);
    await reader.forceFlush();
    const latest = exporter.getMetrics().at(-1);
    if (!latest) {
      return [];
    }
    return latest.scopeMetrics.flatMap((scope) =>
      scope.metrics.map((metric) => ({
        name: metric.descriptor.name,
        unit: metric.descriptor.unit,
        dataPoints: metric.dataPoints as DataPoint<number>[],
      })),
    );
  }

  it('emits db.client.connection.count by state and db.client.connection.max, pool-tagged', async () => {
    const metrics = await collect((source, prov) =>
      // Pass the meter explicitly to avoid the process-global set-once meter provider.
      observeDbPool(source, { meter: prov.getMeter('test'), poolName: 'items' }),
    );

    const count = metrics.find((m) => m.name === 'db.client.connection.count');
    expect(count, 'db.client.connection.count was not registered').toBeDefined();
    expect(count?.unit).toBe('{connection}');

    // The semconv state enum {used, idle}, each carrying the pool name.
    const byState = new Map(
      count?.dataPoints.map((p) => [p.attributes['db.client.connection.state'], p]),
    );
    expect(new Set(byState.keys())).toEqual(new Set(['used', 'idle']));
    expect(byState.get('used')?.value).toBe(5); // total(8) - idle(3)
    expect(byState.get('idle')?.value).toBe(3);
    for (const point of count?.dataPoints ?? []) {
      expect(point.attributes['db.client.connection.pool.name']).toBe('items');
    }

    const max = metrics.find((m) => m.name === 'db.client.connection.max');
    expect(max, 'db.client.connection.max was not registered').toBeDefined();
    expect(max?.dataPoints[0]?.value).toBe(10);
    expect(max?.dataPoints[0]?.attributes['db.client.connection.pool.name']).toBe('items');
  });
});
