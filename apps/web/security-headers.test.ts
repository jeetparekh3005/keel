import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxy } from "./proxy";
import nextConfig from "./next.config.mjs";

type Header = { key: string; value: string };
type HeaderRule = { source: string; headers: Header[] };

async function configHeaders(): Promise<Header[]> {
  const rules = (await nextConfig.headers!()) as HeaderRule[];
  return rules[0]!.headers;
}

describe("static security headers (next.config)", () => {
  it("sets the non-CSP hardening headers on every route", async () => {
    const keys = (await configHeaders()).map((h) => h.key);
    for (const required of [
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      expect(keys).toContain(required);
    }
  });

  it("does NOT set CSP here (it needs a per-request nonce from middleware)", async () => {
    const keys = (await configHeaders()).map((h) => h.key);
    expect(keys).not.toContain("Content-Security-Policy");
  });
});

describe("HSTS production gating", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("emits HSTS only in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const prodConfig = (await import("./next.config.mjs")).default;
    const rules = (await prodConfig.headers!()) as HeaderRule[];
    const keys = rules[0]!.headers.map((h) => h.key);
    expect(keys).toContain("Strict-Transport-Security");
  });
});

describe("CSP proxy", () => {
  it("sets a nonce-based CSP that lets Next hydrate and denies framing", () => {
    const res = proxy(new NextRequest("https://example.test/"));
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    // A nonce (not a bare 'self') is what unblocks Next's inline hydration scripts.
    expect(csp).toMatch(/script-src [^;]*'nonce-[^']+'/);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
