// The behavioral contract suite: assertions a service runs against its composed HTTP server
// to prove it honors platform.yaml, so an over-claim or broken wiring fails a test rather
// than shipping. The TypeScript mirror of the Go conformance package and the Rust
// testkit::conformance. Framework-neutral: it drives the raw http.Server via supertest and
// raises node assertions, so it works under any test runner.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import request, { type Test } from 'supertest';

/** HTTP methods the conformance helpers drive. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function open(server: Server, method: HttpMethod, path: string): Test {
  const agent = request(server);
  switch (method) {
    case 'POST':
      return agent.post(path);
    case 'PUT':
      return agent.put(path);
    case 'PATCH':
      return agent.patch(path);
    case 'DELETE':
      return agent.delete(path);
    default:
      return agent.get(path);
  }
}

/** A problem+json response: status, headers, and the parsed body. */
export interface ProblemResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/**
 * Parse a response body as JSON. superagent only auto-parses `application/json`, not the
 * `application/problem+json` the error path returns, so fall back to parsing the raw text.
 */
export function parseProblem(res: {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  text?: string;
}): ProblemResponse {
  let body = res.body as Record<string, unknown>;
  if (!body || Object.keys(body).length === 0) {
    body = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {};
  }
  return { status: res.status, headers: res.headers, body };
}

/** platform.yaml health: /healthz is 200 and /readyz is 200 or 503. */
export async function assertHealth(server: Server): Promise<void> {
  const health = await open(server, 'GET', '/healthz');
  assert.equal(health.status, 200, `/healthz = ${health.status}, want 200`);
  const ready = await open(server, 'GET', '/readyz');
  assert.ok(
    ready.status === 200 || ready.status === 503,
    `/readyz = ${ready.status}, want 200 or 503`,
  );
}

/** The always-on edge security headers are present, with the expected nosniff value. */
export async function assertSecurityHeaders(server: Server): Promise<void> {
  const res = await open(server, 'GET', '/healthz');
  for (const header of [
    'content-security-policy',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'permissions-policy',
  ]) {
    assert.ok(res.headers[header], `missing security header ${header}`);
  }
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
}

/** No Access-Control-Allow-Origin is returned for a cross-origin request when none configured. */
export async function assertCorsDenyByDefault(server: Server): Promise<void> {
  const res = await open(server, 'GET', '/healthz').set('Origin', 'https://evil.example');
  assert.ok(!res.headers['access-control-allow-origin'], 'CORS must be deny-by-default');
}

/** A protected route rejects an unauthenticated caller with 401. */
export async function assertDeniesAnonymous(
  server: Server,
  method: HttpMethod,
  path: string,
): Promise<void> {
  const res = await open(server, method, path);
  assert.equal(res.status, 401, `${method} ${path} anonymous = ${res.status}, want 401`);
}

/**
 * An authenticated caller lacking the route's scope gets 403. `bearer` is a token the app's
 * authenticator accepts but whose principal lacks the scope.
 */
export async function assertRequiresScope(
  server: Server,
  method: HttpMethod,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<void> {
  const req = open(server, method, path).set('Authorization', `Bearer ${bearer}`);
  const res = body === undefined ? await req : await req.send(body as object);
  assert.equal(res.status, 403, `${method} ${path} insufficient scope = ${res.status}, want 403`);
}

/** A response is RFC 9457 problem+json with the expected status and required members. */
export function assertProblemResponse(
  res: {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    text?: string;
  },
  status: number,
): void {
  const problem = parseProblem(res);
  assert.equal(problem.status, status, `status = ${problem.status}, want ${status}`);
  const contentType = String(problem.headers['content-type'] ?? '');
  assert.ok(contentType.startsWith('application/problem+json'), `content-type = ${contentType}`);
  for (const member of ['type', 'title', 'status']) {
    assert.ok(member in problem.body, `problem+json missing ${member}`);
  }
}
