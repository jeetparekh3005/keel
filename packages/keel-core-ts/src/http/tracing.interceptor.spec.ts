import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { Server } from 'node:http';
import type { DestinationStream } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KeelCoreModule } from '../keel-core.module.js';
import { Public } from '../auth/scopes.decorator.js';
import { createLogger } from '../logging/logger.js';
import { StubAuthenticator } from '../testkit/index.js';

// Captures the controller's log output so the test can assert correlation on a REAL request.
const captured: Record<string, unknown>[] = [];
const captureStream: DestinationStream = {
  write(chunk: string) {
    captured.push(JSON.parse(chunk) as Record<string, unknown>);
  },
};

@Public()
@Controller()
class PingController {
  private readonly log = createLogger('info', captureStream);

  @Get('ping')
  ping(): { ok: boolean } {
    this.log.info('handled request');
    return { ok: true };
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
  controllers: [PingController],
})
class TestAppModule {}

// Proves the real fix: the TracingInterceptor makes a span active for the duration of the
// handler, so a log emitted while handling an actual HTTP request carries the trace id. This
// FAILS if the interceptor is removed (no active span -> no trace_id), unlike a manual
// startActiveSpan test - which is why the previous fix's test was vacuous.
describe('TracingInterceptor correlation (real request)', () => {
  let app: INestApplication;
  let provider: BasicTracerProvider;

  beforeAll(async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await provider.shutdown();
    context.disable();
    trace.disable();
  });

  it('stamps the trace id on a log emitted while handling a real request', async () => {
    captured.length = 0;
    const res = await request(app.getHttpServer() as Server).get('/ping');
    expect(res.status).toBe(200);
    const line = captured.find((l) => l.message === 'handled request');
    expect(line, 'controller log line was not captured').toBeDefined();
    expect(line?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(line?.span_id).toMatch(/^[0-9a-f]{16}$/);
  });
});
