import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { DomainError, ErrorCategory } from '../domain/errors.js';
import { ApiKeyAuthenticator, hashApiKey } from './api-key.authenticator.js';
import { Principal } from './principal.js';

function authenticator(): ApiKeyAuthenticator {
  return ApiKeyAuthenticator.fromKeys({
    'secret-key': new Principal('svc', ['items:read']),
  });
}

describe('hashApiKey', () => {
  it('is the SHA-256 hex digest of the key', () => {
    expect(hashApiKey('k')).toBe(createHash('sha256').update('k', 'utf8').digest('hex'));
  });

  it('is deterministic and distinct per key', () => {
    expect(hashApiKey('a')).toBe(hashApiKey('a'));
    expect(hashApiKey('a')).not.toBe(hashApiKey('b'));
  });
});

describe('ApiKeyAuthenticator', () => {
  it('resolves the principal for a valid key', async () => {
    const principal = await authenticator().authenticate('secret-key');
    expect(principal.subject).toBe('svc');
    expect(principal.hasScopes('items:read')).toBe(true);
  });

  it('rejects an unknown key as Unauthenticated (401)', async () => {
    await expect(authenticator().authenticate('wrong')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DomainError && err.category === ErrorCategory.Unauthenticated,
    );
  });

  it('rejects an empty key', async () => {
    await expect(authenticator().authenticate('')).rejects.toBeInstanceOf(DomainError);
  });

  it('constructs from pre-hashed digests (keys never held in plaintext)', async () => {
    const auth = new ApiKeyAuthenticator({ [hashApiKey('abc')]: new Principal('u') });
    expect((await auth.authenticate('abc')).subject).toBe('u');
    await expect(auth.authenticate('xyz')).rejects.toBeInstanceOf(DomainError);
  });
});
