import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Database, DATABASE } from '@keel/core';
import type { Pool } from 'pg';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';

// Boots the real composition root (AppModule: InfraModule + KeelCoreModule.forRootAsync + the
// aggregate module) with the Postgres pool replaced by a fake, so the wiring - typed config
// load, the core module factory, the readiness probe, and the shutdown hook - is exercised
// WITHOUT a live database. The real-DB round-trip stays in app.e2e.spec.ts (gated on
// KEEL_TEST_DATABASE_URL).
describe('AppModule wiring (fake database)', () => {
  let app: INestApplication;
  let server: Server;
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const end = vi.fn().mockResolvedValue(undefined);
  const fakeDb = new Database({ query, end } as unknown as Pool);

  beforeAll(async () => {
    // OidcAuthenticator builds a RemoteJWKSet from a URL at construction (no network until a
    // token is verified), so a syntactically valid JWKS URI is required to boot.
    process.env.KEEL_OIDC_JWKS_URI = 'https://auth.example.test/jwks';
    process.env.KEEL_LOG_LEVEL = 'silent';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(fakeDb)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.KEEL_OIDC_JWKS_URI;
    delete process.env.KEEL_LOG_LEVEL;
  });

  it('serves liveness without touching the database', async () => {
    const res = await request(server).get('/healthz');
    expect(res.status).toBe(200);
  });

  it('wires the readiness probe onto the database ping (SELECT 1)', async () => {
    const res = await request(server).get('/readyz');
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('mounts the aggregate routes behind the deny-by-default guard', async () => {
    const res = await request(server).get('/v1/@< aggregate_plural >@');
    expect(res.status).toBe(401);
  });

  it('closes the pool on application shutdown', async () => {
    await app.close();
    expect(end).toHaveBeenCalled();
  });
});
