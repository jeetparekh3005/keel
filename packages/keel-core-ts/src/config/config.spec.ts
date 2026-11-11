import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DomainError, ErrorCategory } from '../domain/errors.js';
import { csvList, loadConfig } from './index.js';

const schema = z.object({
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().default(8000),
  CORS_ALLOW_ORIGINS: csvList(),
});

describe('loadConfig', () => {
  it('strips the KEEL_ prefix, coerces types, and applies defaults', () => {
    const cfg = loadConfig(schema, {
      KEEL_PORT: '9000',
      KEEL_CORS_ALLOW_ORIGINS: 'https://a.example, https://b.example',
      UNRELATED: 'ignored',
    });

    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.PORT).toBe(9000);
    expect(cfg.CORS_ALLOW_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('parses an empty CORS list as deny-by-default (empty array)', () => {
    const cfg = loadConfig(schema, {});
    expect(cfg.CORS_ALLOW_ORIGINS).toEqual([]);
  });

  it('fails fast with an Internal DomainError on a type error', () => {
    const strict = z.object({ PORT: z.coerce.number() });
    try {
      loadConfig(strict, { KEEL_PORT: 'not-a-number' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).category).toBe(ErrorCategory.Internal);
    }
  });
});
