import type { Metadata } from "next";
import type { ReactNode } from "react";

// Render per request so the CSP middleware's per-request nonce is stamped onto
// Next's inline hydration scripts. A statically prerendered page cannot carry a
// nonce, which would leave the inline scripts blocked under the strict CSP. This
// is the deliberate secure-by-default trade-off for the platform's web surface;
// routes that are safe to prerender can opt back in locally.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "keel",
  description: "keel - polyglot golden-path platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
