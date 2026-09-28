/**
 * Same-origin API mode (optional): build with `NEXT_PUBLIC_API_PROXY_TARGET=<api origin>` and
 * `NEXT_PUBLIC_API_URL=` (empty), and the web app forwards `/api/*` to the API itself.
 *
 * Why it exists: deployed with the web app and the API on two hosts that are different SITES (two
 * `*.run.app` services are — `run.app` is on the public suffix list), the session cookie is a
 * third-party `SameSite=None` cookie. Safari blocks those outright and Chrome is phasing them out,
 * so sign-in silently fails there. Behind this proxy the browser only ever talks to one origin:
 * cookies are first-party, CORS is not involved, and `SameSite=Lax` is enough. Next passes the
 * caller's `X-Forwarded-For` through unchanged (measured), so behind a load balancer in front of
 * each service the API sees one more entry — the web instance's own address — and
 * `TRUST_PROXY_HOPS` on the API must count it.
 *
 * `NEXT_PUBLIC_` because it is public by nature — an API origin, which every request the proxy
 * makes reveals anyway — and because the frontend reads no server-side variable at all
 * (scripts/check-boundary.mjs, rule 6). It is read only here, so it is not compiled into the bundle.
 *
 * Unset (the default, and local development), the browser calls the API directly as before.
 * Both are evaluated at BUILD time, like every `NEXT_PUBLIC_*` value.
 */
const apiProxyTarget = process.env.NEXT_PUBLIC_API_PROXY_TARGET?.trim().replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a minimal, self-contained server bundle (.next/standalone) with only the
  // production dependencies actually traced from the build output — the officially
  // documented way to containerize a Next.js app (docs/26_DECISIONS.md ADR-037's Dockerfile
  // relies on this). No effect on `next dev`/`next start` outside a container.
  output: "standalone",
  experimental: {
    // Next's rewrite proxy destroys a proxied request after 30 s with no bytes (measured: a
    // stream whose first byte comes at 40 s is cut at exactly 30 s, an empty reply). A CPU model
    // can take longer than that to its first token, so the proxy waits as long as the API's own
    // deployment lets a request run (Cloud Run's maximum, infrastructure/terraform/main.tf).
    // Unconditional on purpose: `next start` re-evaluates this file at RUNTIME, where
    // NEXT_PUBLIC_API_PROXY_TARGET may be unset although the build-time rewrites are still active — a
    // conditional value silently fell back to 30 s there. It does nothing without a rewrite.
    proxyTimeout: 3_600_000,
  },
  ...(apiProxyTarget
    ? {
        // Next's gzip buffers a proxied response until it ends, which turns the chat's
        // server-sent events into one late block. Streaming is the product; compression of API
        // JSON is not worth that.
        compress: false,
        async rewrites() {
          return [{ source: "/api/:path*", destination: `${apiProxyTarget}/api/:path*` }];
        },
      }
    : {}),
};

export default nextConfig;
