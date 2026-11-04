import { describe, expect, it } from "vitest";

import nextConfig from "./next.config.mjs";

type Header = { key: string; value: string };
type HeaderRule = { source: string; headers: Header[] };

async function headerRules(): Promise<HeaderRule[]> {
  return (await nextConfig.headers!()) as HeaderRule[];
}

describe("security headers", () => {
  it("applies the baseline security headers to every route", async () => {
    const rules = await headerRules();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeDefined();
    const keys = all!.headers.map((h) => h.key);
    for (const required of [
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      expect(keys).toContain(required);
    }
  });

  it("denies framing and sets a deny-by-default CSP", async () => {
    const rules = await headerRules();
    const headers = rules[0]!.headers;
    const csp = headers.find((h) => h.key === "Content-Security-Policy")!.value;
    const frame = headers.find((h) => h.key === "X-Frame-Options")!.value;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(frame).toBe("DENY");
  });
});
