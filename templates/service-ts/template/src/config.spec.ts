import { describe, expect, it } from 'vitest';

import { loadServiceConfig } from './config.js';

// loadServiceConfig reads only the KEEL_-prefixed environment and fails fast. These assert the
// typed schema's behavior from an explicit env (never the ambient process.env) so the run is
// hermetic and DB-free.
describe('loadServiceConfig', () => {
  it('applies secure-by-default defaults when nothing is set', () => {
    const cfg = loadServiceConfig({});
    expect(cfg.SERVICE_NAME).toBe('@< service_slug >@');
    expect(cfg.ENVIRONMENT).toBe('production');
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.PORT).toBe(8000);
    expect(cfg.MAX_BODY_BYTES).toBe(1024 * 1024);
    expect(cfg.CORS_ALLOW_ORIGINS).toEqual([]);
  });

  it('reads overrides from the KEEL_-prefixed environment and coerces numbers', () => {
    const cfg = loadServiceConfig({
      KEEL_ENVIRONMENT: 'staging',
      KEEL_PORT: '9090',
      KEEL_MAX_BODY_BYTES: '2048',
    });
    expect(cfg.ENVIRONMENT).toBe('staging');
    expect(cfg.PORT).toBe(9090);
    expect(typeof cfg.PORT).toBe('number');
    expect(cfg.MAX_BODY_BYTES).toBe(2048);
  });

  it('parses CORS_ALLOW_ORIGINS as a trimmed, empty-dropping CSV list', () => {
    const cfg = loadServiceConfig({
      KEEL_CORS_ALLOW_ORIGINS: 'https://a.example, https://b.example, ,',
    });
    expect(cfg.CORS_ALLOW_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('ignores environment keys that lack the KEEL_ prefix', () => {
    const cfg = loadServiceConfig({ PORT: '1', ENVIRONMENT: 'development' });
    expect(cfg.PORT).toBe(8000);
    expect(cfg.ENVIRONMENT).toBe('production');
  });
});
