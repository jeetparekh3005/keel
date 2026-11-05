/** @type {import('next').NextConfig} */

// Static security headers applied to every response, mirroring the backend edge
// defaults (keel-core SecurityHeadersMiddleware). The Content-Security-Policy is
// NOT set here: it needs a per-request nonce for Next's inline hydration scripts,
// so it lives in middleware.ts. HSTS is emitted only in a production build so local
// http dev is unaffected.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
  },
];

if (process.env.NODE_ENV === "production") {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  });
}

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
