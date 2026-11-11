import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DomainError, ErrorCategory } from './domain/errors.js';
import { KeelCoreModule } from './keel-core.module.js';
import { Scopes } from './auth/scopes.decorator.js';
import { ZodValidationPipe } from './http/validation.pipe.js';
import {
  assertCorsDenyByDefault,
  assertDeniesAnonymous,
  assertHealth,
  assertProblemResponse,
  assertReadyzReportsNotReady,
  assertRequiresScope,
  assertSecurityHeaders,
  assertSecurityHeadersOn413,
  parseProblem,
} from './conformance/index.js';
import { principal, StubAuthenticator } from './testkit/index.js';

const thingSchema = z.object({ name: z.string().min(1).max(200) });

@Controller('v1')
class ThingsController {
  @Post('things')
  @Scopes('things:write')
  create(@Body(new ZodValidationPipe(thingSchema)) body: { name: string }): { name: string } {
    return { name: body.name };
  }

  @Get('boom')
  @Scopes('things:read')
  boom(): never {
    // A server fault whose detail must never reach the client.
    throw new DomainError(ErrorCategory.Internal, 'SELECT secret FROM vault failed');
  }
}

@Module({
  imports: [
    KeelCoreModule.forRoot({
      logLevel: 'silent',
      corsAllowOrigins: [],
      authenticator: new StubAuthenticator({
        reader: principal('u-reader', 'things:read'),
        writer: principal('u-writer', 'things:write'),
      }),
      readiness: () => true,
      // A tiny cap so an over-limit body (any content-type) exercises the 413 path.
      maxBodyBytes: 32,
    }),
  ],
  controllers: [ThingsController],
})
class TestAppModule {}

describe('KeelCoreModule wiring (conformance)', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    // A tiny body limit so an over-limit POST exercises the 413 error path (which must still
    // carry the security headers).
    (app as NestExpressApplication).useBodyParser('json', { limit: 32 });
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('passes the platform conformance suite', async () => {
    await assertHealth(server);
    await assertSecurityHeaders(server);
    await assertCorsDenyByDefault(server);
    await assertDeniesAnonymous(server, 'POST', '/v1/things');
    await assertRequiresScope(server, 'POST', '/v1/things', 'reader', { name: 'widget' });
  });

  it('returns a 413 WITH security headers for an over-limit body', async () => {
    await assertSecurityHeadersOn413(
      server,
      'POST',
      '/v1/things',
      JSON.stringify({ name: 'x'.repeat(200) }),
    );
  });

  it('returns a 413 for an over-limit NON-JSON body (content-type-agnostic)', async () => {
    // The JSON body parser only caps JSON; a text/plain over-limit body must still be rejected by
    // the content-type-agnostic body-limit middleware, with the security headers intact.
    const res = await request(server)
      .post('/v1/things')
      .set('Authorization', 'Bearer writer')
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(200));
    expect(res.status).toBe(413);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('aborts an over-limit CHUNKED body with no Content-Length (bounds buffering, not a 413)', async () => {
    // A Transfer-Encoding: chunked request carries no Content-Length, so the header fast-path
    // cannot see it; the streaming counter must bound buffering by ABORTING the connection (a
    // socket reset, not a decorated 413 - see BodyLimitMiddleware). Sent raw against a listening
    // instance (supertest always sets Content-Length, so it cannot drive this path).
    const { request: httpRequest } = await import('node:http');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const outcome = await new Promise<string>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/things',
            headers: { Authorization: 'Bearer writer', 'Content-Type': 'text/plain' },
          },
          (res) => {
            res.resume();
            resolve(`status:${res.statusCode}`);
          },
        );
        req.on('error', () => resolve('aborted'));
        req.write('x'.repeat(4096)); // > the 32-byte cap; no Content-Length set => chunked
        req.end();
      });
      // The over-limit chunked body must be aborted (connection reset), never accepted or reach
      // the handler. Before the streaming cap it reached the handler (a 400/201), so this guards
      // that the body is bounded - not a decorated-413 contract (the Content-Length path covers 413).
      expect(outcome).toBe('aborted');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('drops server-fault detail from the problem body (logs it server-side)', async () => {
    const res = await request(server).get('/v1/boom').set('Authorization', 'Bearer reader');
    assertProblemResponse(res, 500);
    const problem = parseProblem(res);
    expect(problem.body.detail).toBeUndefined();
    expect(JSON.stringify(problem.body)).not.toContain('vault');
  });

  it('rejects an invalid body with a 400 problem', async () => {
    const res = await request(server)
      .post('/v1/things')
      .set('Authorization', 'Bearer writer')
      .send({ name: '' });
    assertProblemResponse(res, 400);
  });

  it('accepts a valid authorized write', async () => {
    const res = await request(server)
      .post('/v1/things')
      .set('Authorization', 'Bearer writer')
      .send({ name: 'widget' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'widget' });
  });

  it('accepts a case-insensitive bearer scheme', async () => {
    const res = await request(server)
      .post('/v1/things')
      .set('Authorization', 'bearer writer')
      .send({ name: 'widget' });
    expect(res.status).toBe(201);
  });
});

@Module({
  imports: [
    KeelCoreModule.forRoot({
      logLevel: 'silent',
      corsAllowOrigins: [],
      authenticator: new StubAuthenticator({}),
      // A failing dependency: /readyz must report 503, not 200.
      readiness: () => false,
    }),
  ],
})
class NotReadyAppModule {}

describe('KeelCoreModule readiness', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [NotReadyAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/readyz reports 503 when the readiness check fails', async () => {
    await assertReadyzReportsNotReady(app.getHttpServer() as Server);
  });
});
