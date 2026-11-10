import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Database, DATABASE, KeelCoreModule } from '@keel/core';
import {
  assertCorsDenyByDefault,
  assertDeniesAnonymous,
  assertHealth,
  assertProblemResponse,
  assertRequiresScope,
  assertSecurityHeaders,
} from '@keel/core/conformance';
import { principal, StubAuthenticator } from '@keel/core/testkit';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ITEM_REPOSITORY } from '../src/items/item.js';
import { ItemService } from '../src/items/item.service.js';
import { ItemsController } from '../src/items/items.controller.js';
import { PgItemRepository } from '../src/items/item.repository.js';
import { InMemoryItemRepository } from './in-memory-item.repository.js';

const authenticator = new StubAuthenticator({
  reader: principal('u-reader', 'items:read'),
  writer: principal('u-writer', 'items:read', 'items:write'),
});

function coreModule() {
  return KeelCoreModule.forRoot({
    logLevel: 'silent',
    corsAllowOrigins: [],
    authenticator,
    readiness: () => true,
  });
}

// The behavioral + CRUD suite runs against an in-memory repository (no database needed).
describe('reference-service-nest (in-memory)', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [coreModule()],
      controllers: [ItemsController],
      providers: [
        ItemService,
        { provide: ITEM_REPOSITORY, useValue: new InMemoryItemRepository() },
      ],
    }).compile();
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
    await assertDeniesAnonymous(server, 'POST', '/v1/items');
    await assertRequiresScope(server, 'POST', '/v1/items', 'reader', { name: 'widget' });
  });

  it('creates, reads, and lists items for an authorized caller', async () => {
    const created = await request(server)
      .post('/v1/items')
      .set('Authorization', 'Bearer writer')
      .send({ name: 'widget' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(id).toBeTruthy();

    const fetched = await request(server)
      .get(`/v1/items/${id}`)
      .set('Authorization', 'Bearer reader');
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual({ id, name: 'widget' });

    const listed = await request(server).get('/v1/items').set('Authorization', 'Bearer reader');
    expect(listed.status).toBe(200);
    expect(listed.body.count).toBeGreaterThanOrEqual(1);
    expect(listed.body.limit).toBe(50);
  });

  it('returns a 404 problem for an unknown id', async () => {
    const res = await request(server)
      .get('/v1/items/does-not-exist')
      .set('Authorization', 'Bearer reader');
    assertProblemResponse(res, 404);
  });

  it('rejects an invalid body with a 400 problem', async () => {
    const res = await request(server)
      .post('/v1/items')
      .set('Authorization', 'Bearer writer')
      .send({ name: '' });
    assertProblemResponse(res, 400);
  });
});

// The same CRUD against real Postgres, gated on KEEL_TEST_DATABASE_URL (runs in CI).
const databaseUrl = process.env.KEEL_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('reference-service-nest (Postgres)', () => {
  let app: INestApplication;
  let server: Server;
  let db: Database;

  beforeAll(async () => {
    db = await Database.connect(databaseUrl as string);
    await db.raw.query('DROP TABLE IF EXISTS items');
    const moduleRef = await Test.createTestingModule({
      imports: [
        KeelCoreModule.forRoot({
          logLevel: 'silent',
          corsAllowOrigins: [],
          authenticator,
          readiness: () => db.ping(),
        }),
      ],
      controllers: [ItemsController],
      providers: [
        ItemService,
        { provide: DATABASE, useValue: db },
        { provide: ITEM_REPOSITORY, useClass: PgItemRepository },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('round-trips an item through Postgres', async () => {
    const created = await request(server)
      .post('/v1/items')
      .set('Authorization', 'Bearer writer')
      .send({ name: 'persisted' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const fetched = await request(server)
      .get(`/v1/items/${id}`)
      .set('Authorization', 'Bearer reader');
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual({ id, name: 'persisted' });
  });
});
