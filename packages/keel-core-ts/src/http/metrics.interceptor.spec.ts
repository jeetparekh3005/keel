import { Controller, Get, Module, Param } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KeelCoreModule } from '../keel-core.module.js';
import { Public } from '../auth/scopes.decorator.js';
import { StubAuthenticator } from '../testkit/index.js';

// A controller with a PARAMETERIZED route so the test proves the metric label is the route
// TEMPLATE (`/v1/widgets/:id`), not the raw URL (`/v1/widgets/abc-123`) - the whole point of the
// route-templated attribute.
@Public()
@Controller('v1/widgets')
class WidgetsController {
  @Get(':id')
  get(@Param('id') id: string): { id: string } {
    return { id };
  }
}

@Module({
  imports: [
    KeelCoreModule.forRoot({
      logLevel: 'silent',
      corsAllowOrigins: [],
      authenticator: new StubAuthenticator({}),
      readiness: () => true,
    }),
  ],
  controllers: [WidgetsController],
})
class TestAppModule {}

interface Collected {
  name: string;
  unit: string;
  dataPoints: DataPoint<unknown>[];
}

// Proves HTTP request metrics are actually emitted by the MetricsInterceptor on a REAL request:
// a duration histogram and an in-flight up-down counter, both labelled by the matched route
// template. This FAILS if the interceptor is removed from the module (no instrument records, so
// neither metric appears in the collected batch) - it is not a vacuous "the meter is wired" test.
describe('MetricsInterceptor (real request)', () => {
  let app: INestApplication;
  let provider: MeterProvider;
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;

  beforeAll(async () => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    // A long interval so nothing exports until the test calls forceFlush() deterministically.
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    provider = new MeterProvider({ readers: [reader] });
    // Register globally BEFORE app.init so the interceptor's metrics.getMeter() binds to it.
    metrics.setGlobalMeterProvider(provider);

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await provider.shutdown();
    metrics.disable();
  });

  async function collect(): Promise<Collected[]> {
    // Let the server's response 'finish' event settle (that is when the interceptor records).
    await new Promise((resolve) => setImmediate(resolve));
    await reader.forceFlush();
    const batches = exporter.getMetrics();
    const latest = batches.at(-1);
    if (!latest) {
      return [];
    }
    return latest.scopeMetrics.flatMap((scope) =>
      scope.metrics.map((metric) => ({
        name: metric.descriptor.name,
        unit: metric.descriptor.unit,
        dataPoints: metric.dataPoints,
      })),
    );
  }

  it('records duration + active-request metrics labelled by the route template', async () => {
    const res = await request(app.getHttpServer() as Server).get('/v1/widgets/abc-123');
    expect(res.status).toBe(200);

    const collected = await collect();

    const duration = collected.find((m) => m.name === 'http.server.request.duration');
    expect(duration, 'duration histogram was not recorded').toBeDefined();
    expect(duration?.unit).toBe('s');
    const durationPoint = duration?.dataPoints.find(
      (p) => p.attributes['http.route'] === '/v1/widgets/:id',
    );
    expect(durationPoint, 'no duration point with the route template').toBeDefined();
    expect(durationPoint?.attributes['http.request.method']).toBe('GET');
    // Status code is only known once the response is written; the interceptor records it there.
    expect(durationPoint?.attributes['http.response.status_code']).toBe(200);

    const active = collected.find((m) => m.name === 'http.server.active_requests');
    expect(active, 'active_requests counter was not recorded').toBeDefined();
    const activePoint = active?.dataPoints.find(
      (p) => p.attributes['http.route'] === '/v1/widgets/:id',
    );
    expect(activePoint, 'no active_requests point with the route template').toBeDefined();
    expect(activePoint?.attributes['http.request.method']).toBe('GET');
    // Incremented on entry and decremented on completion with the SAME attributes, so the
    // in-flight gauge nets back to zero once the request is done.
    expect(activePoint?.value).toBe(0);
  });
});
