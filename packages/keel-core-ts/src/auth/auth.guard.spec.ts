import { Controller, Get, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KeelCoreModule } from '../keel-core.module.js';
import { ApiKeyAuthenticator } from './api-key.authenticator.js';
import { Public, Scopes } from './scopes.decorator.js';
import { principal, StubAuthenticator } from '../testkit/index.js';

// A route needing items:read and one needing items:write, so a principal that holds only
// items:read reaches the first (200) but is forbidden from the second (403), whichever
// credential carried it.
@Controller('v1')
class DataController {
  @Get('data')
  @Scopes('items:read')
  read(): { ok: boolean } {
    return { ok: true };
  }

  @Post('data')
  @Scopes('items:write')
  write(): { created: boolean } {
    return { created: true };
  }

  @Get('open')
  @Public()
  open(): { open: boolean } {
    return { open: true };
  }
}

// Bearer path: a stub IdP. X-API-Key path: an ApiKeyAuthenticator. "ak-reader" holds only
// items:read; "ak-admin" also holds items:write.
const bearer = new StubAuthenticator({ writer: principal('u-writer', 'items:write') });
const apiKeys = ApiKeyAuthenticator.fromKeys({
  'ak-reader': principal('svc-reader', 'items:read'),
  'ak-admin': principal('svc-admin', 'items:read', 'items:write'),
});

@Module({
  imports: [
    KeelCoreModule.forRoot({
      logLevel: 'silent',
      corsAllowOrigins: [],
      authenticator: bearer,
      apiKeyAuthenticator: apiKeys,
      readiness: () => true,
    }),
  ],
  controllers: [DataController],
})
class ApiKeyAppModule {}

describe('AuthGuard with X-API-Key', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiKeyAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets a valid X-API-Key reach a scope-guarded route (200)', async () => {
    const res = await request(server).get('/v1/data').set('X-API-Key', 'ak-reader');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects a wrong X-API-Key with 401', async () => {
    const res = await request(server).get('/v1/data').set('X-API-Key', 'nope');
    expect(res.status).toBe(401);
  });

  it('rejects a request with no credential at all with 401', async () => {
    const res = await request(server).get('/v1/data');
    expect(res.status).toBe(401);
  });

  it('forbids an API-key principal lacking the route scope with 403', async () => {
    // ak-reader holds items:read but not items:write: deny-by-default + @Scopes still apply.
    const res = await request(server).post('/v1/data').set('X-API-Key', 'ak-reader');
    expect(res.status).toBe(403);
  });

  it('admits an API-key principal that holds the route scope (201)', async () => {
    const res = await request(server).post('/v1/data').set('X-API-Key', 'ak-admin');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: true });
  });

  it('still authenticates the bearer JWT path (200)', async () => {
    const res = await request(server).post('/v1/data').set('Authorization', 'Bearer writer');
    expect(res.status).toBe(201);
  });

  it('prefers X-API-Key over a valid bearer token when both are present', async () => {
    // An invalid API key must be rejected even alongside a valid bearer token: the api-key path
    // takes precedence and does not silently fall through to Bearer.
    const res = await request(server)
      .post('/v1/data')
      .set('X-API-Key', 'nope')
      .set('Authorization', 'Bearer writer');
    expect(res.status).toBe(401);
  });

  it('keeps @Public routes open with no credential', async () => {
    const res = await request(server).get('/v1/open');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: true });
  });
});

// A bearer-only service (no apiKeyAuthenticator configured): an X-API-Key request has nothing to
// verify it, so it must be rejected (401), never silently allowed.
@Module({
  imports: [
    KeelCoreModule.forRoot({
      logLevel: 'silent',
      corsAllowOrigins: [],
      authenticator: bearer,
      readiness: () => true,
    }),
  ],
  controllers: [DataController],
})
class BearerOnlyAppModule {}

describe('AuthGuard without an api-key authenticator', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BearerOnlyAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an X-API-Key request with 401 when no api-key authenticator is wired', async () => {
    const res = await request(server).get('/v1/data').set('X-API-Key', 'ak-reader');
    expect(res.status).toBe(401);
  });

  it('still authenticates the bearer path', async () => {
    const res = await request(server).post('/v1/data').set('Authorization', 'Bearer writer');
    expect(res.status).toBe(201);
  });
});
