import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
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
  assertRequiresScope,
  assertSecurityHeaders,
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
    app = moduleRef.createNestApplication();
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
