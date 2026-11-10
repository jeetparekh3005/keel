import { describe, expect, it } from 'vitest';

import { DomainError, ErrorCategory, isServerFault, statusFor, typeUriFor } from './errors.js';

describe('error taxonomy', () => {
  it('maps every category to its platform.yaml status', () => {
    expect(statusFor(ErrorCategory.Validation)).toBe(400);
    expect(statusFor(ErrorCategory.Unauthenticated)).toBe(401);
    expect(statusFor(ErrorCategory.Forbidden)).toBe(403);
    expect(statusFor(ErrorCategory.NotFound)).toBe(404);
    expect(statusFor(ErrorCategory.Conflict)).toBe(409);
    expect(statusFor(ErrorCategory.RateLimited)).toBe(429);
    expect(statusFor(ErrorCategory.Internal)).toBe(500);
    expect(statusFor(ErrorCategory.Unavailable)).toBe(503);
  });

  it('builds stable urn:keel:error:* type URIs', () => {
    expect(typeUriFor(ErrorCategory.NotFound)).toBe('urn:keel:error:not_found');
    expect(typeUriFor(ErrorCategory.RateLimited)).toBe('urn:keel:error:rate_limited');
  });

  it('treats only 5xx categories as server faults', () => {
    expect(isServerFault(ErrorCategory.Internal)).toBe(true);
    expect(isServerFault(ErrorCategory.Unavailable)).toBe(true);
    expect(isServerFault(ErrorCategory.Validation)).toBe(false);
    expect(isServerFault(ErrorCategory.NotFound)).toBe(false);
  });

  it('keeps client-fault detail but drops server-fault detail from the problem', () => {
    const clientProblem = new DomainError(ErrorCategory.Validation, 'name required').toProblem(
      '/v1/items',
    );
    expect(clientProblem).toMatchObject({
      type: 'urn:keel:error:validation',
      title: 'Bad Request',
      status: 400,
      detail: 'name required',
      instance: '/v1/items',
    });

    const serverProblem = new DomainError(
      ErrorCategory.Internal,
      'SELECT secret FROM users failed',
    ).toProblem();
    expect(serverProblem.status).toBe(500);
    expect(serverProblem.detail).toBeUndefined();
  });
});
