import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Per-request nonce CSP. A static `script-src 'self'` blocks Next App Router's
// inline hydration scripts; the documented fix is a per-request nonce that Next
// applies to its own scripts. 'strict-dynamic' lets those scripts load their
// chunks without allowlisting every path. Non-CSP headers live in next.config.
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  // Next reads the nonce from the request's CSP header and stamps it on its
  // inline scripts; echo the same policy on the response so the browser enforces it.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // Documents only: skip static assets and image optimization, which need no CSP.
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
