import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { recordHttpRequest, type Logger } from "@ai-platform/observability";
import type { AppConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { PgRateLimitStore } from "./plugins/rate-limit-store.js";
import { CSRF_HEADER, registerAuth } from "./plugins/auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAgentRoutes } from "./routes/v1/agent.js";
import { registerAuthRoutes } from "./routes/v1/auth.js";
import { registerChatRoute } from "./routes/v1/chat.js";
import { registerAudioRoutes } from "./routes/v1/audio.js";
import { registerImageRoutes } from "./routes/v1/images.js";
import { registerRagRoutes } from "./routes/v1/rag.js";
import { registerPlatformRoutes } from "./routes/v1/platform.js";
import { registerUsageRoute } from "./routes/v1/usage.js";
import { registerVideoRoutes } from "./routes/v1/videos.js";

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The only endpoints that may be reached without a credential — docs/26_DECISIONS.md ADR-049.
 *
 * Kept as an explicit, short list rather than a pattern, because "which routes are public" is
 * a security decision that should be readable in one glance and hard to widen by accident. A
 * route absent from this list requires authentication; there is no ambient authority anywhere
 * else in the API.
 */
const PUBLIC_PATHS = [
  "/api/health",
  "/api/v1/auth/signup",
  "/api/v1/auth/login",
  "/api/v1/auth/logout",
];

export async function buildServer(config: AppConfig, ctx: AppContext, logger: Logger) {
  // docs/20_OBSERVABILITY.md §1.1 — a pre-built, shared Pino instance (not `logger: true`,
  // which would make Fastify construct its own, separate from the one job workers use) so
  // every structured log line in this process — HTTP request/response and job/provider-call
  // alike — shares the same redaction config and JSON shape. The cast is real Fastify/Pino
  // TypeScript friction, not a runtime concern: a Pino `Logger` implements everything
  // `FastifyBaseLogger` requires (Fastify's own default logger *is* a Pino instance), the
  // types just don't structurally line up on an optional `msgPrefix` field.
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Whose address `request.ip` is — ADR-112. It feeds every per-IP rate limit and every audit
    // row. This was `trustProxy: true`, which takes the LEFTMOST X-Forwarded-For entry: the one
    // the client writes. Any caller could name its own address and rotate it per request, so no
    // per-IP limit bound anyone and the audit trail recorded whatever a client claimed. A hop
    // count trusts only what the deployment's own proxies appended — 1 behind Cloud Run's front
    // end. 0, the default, trusts nothing and uses the socket's address, which is correct for a
    // process exposed directly. The number must match the deployment in both directions: too
    // low behind a proxy and every client shares the proxy's one address and one bucket.
    // A function, not the bare number: Fastify 5's types do not accept one. Hop 0 is the socket
    // peer, so with TRUST_PROXY_HOPS=0 nothing is trusted and the socket's own address is used.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,

    // A UUID, not Fastify's default per-process counter -- ADR-098.
    //
    // `request.id` is not only a log tag here: it is written to audit records, propagated into
    // job payloads, and used as the usage-ledger idempotency key for a RAG query (the one
    // spending path with no persisted row to key off). The default generator restarts at
    // `req-1` in every process, so those keys COLLIDED across restarts and across replicas --
    // and a collision on that unique index silently DROPS the charge rather than
    // double-charging, which is the direction that loses money quietly.
    //
    // It also makes the id in an error response the same id that appears in every log line for
    // that request. The error handler used to mint its own separate UUID, so the id handed to a
    // caller matched nothing an operator could grep for.
    genReqId: () => randomUUID(),
  });

  // docs/13_SECURITY_ARCHITECTURE.md §4 — the API sent no security headers at all before
  // ADR-049's audit. Most of helmet's defaults are aimed at HTML, but three matter here and
  // cost nothing: `X-Content-Type-Options: nosniff` (a JSON error body containing
  // attacker-supplied text must never be sniffed as HTML and executed), HSTS (once behind
  // TLS, no downgrade), and the referrer policy.
  await app.register(helmet, {
    // This API serves JSON and binary assets, never a document — so the strictest possible
    // policy is also the correct one. `frame-ancestors 'none'` is the modern replacement for
    // X-Frame-Options and covers the same clickjacking case for any error page a browser
    // might render.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    // The SPA is served from a different origin than this API (CORS_ORIGIN), and
    // `GET /api/v1/assets/:id` returns images and video the browser must be able to load.
    // helmet's `same-origin` default would block exactly that, so the relaxation is
    // deliberate and narrow: CORS above still decides *which* origin may read a response.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  // Cookies must be parsed before the auth plugin's preHandler can read the session cookie,
  // and `reply.setCookie`/`clearCookie` (routes/v1/auth.ts) only exist once this is
  // registered. No `secret`: the session cookie carries an opaque random token that is looked
  // up by hash server-side (backend/packages/security/tokens.ts), so there is nothing for cookie
  // signing to add — it would only move trust into a key we would then have to manage.
  await app.register(cookie);

  // @fastify/cors defaults `methods` to "GET,HEAD,POST" only — DELETE (used by
  // /api/v1/memory/:id) and PUT/PATCH would otherwise fail preflight in any real browser,
  // a real bug found only by actual browser-driven UI testing (docs/25 Phase 10), never by
  // curl (which doesn't enforce CORS at all) or by unit/integration tests.
  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    // Without this the browser drops the session cookie on every cross-origin call and the
    // whole cookie-based session (ADR-049) silently degrades to "always logged out". It is
    // also why `origin` must stay an explicit origin: the CORS spec forbids `*` with
    // credentials, and a wildcard here would additionally let any site read authenticated
    // responses.
    credentials: true,
    // Explicit rather than reflecting whatever the browser asks for, so the request headers
    // this API accepts are auditable in one place: JSON bodies, bearer API keys, the
    // double-submit CSRF token, and the project selector a session-authenticated caller uses
    // to name its scope (see plugins/auth.ts's `extractProjectId`).
    allowedHeaders: ["content-type", "authorization", CSRF_HEADER, "x-project-id"],
  });

  // docs/13_SECURITY_ARCHITECTURE.md §4 "Layer 1 — edge/API rate limiting". A generous
  // global default (real requests aren't expensive; this exists to blunt a runaway client
  // or script, not to throttle normal use) plus stricter per-route overrides on the
  // genuinely expensive or abuse-prone endpoints (image/video generation, agent task
  // creation, signup/login — see routes/v1/{images,videos,agent,auth}.ts's `config.rateLimit`).
  //
  // The counters live in Postgres, not in this process's memory (ADR-071). The default
  // per-process store makes the effective limit N × max across N instances — and it fails in
  // the worst direction, since the harder an endpoint is hammered the more instances the
  // autoscaler adds and the higher the real limit climbs. `store` takes a constructor, and the
  // plugin builds it with its own options, so this closure binds the database and logger while
  // letting the plugin supply the window.
  const RateLimitStoreForApp = class extends PgRateLimitStore {
    constructor(pluginOptions: { timeWindow?: number }) {
      super({ db: ctx.db, logger, timeWindowMs: pluginOptions.timeWindow ?? 60_000 });
    }
  };
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    store: RateLimitStoreForApp as never,
    // @fastify/rate-limit's default error has a `statusCode` but no `code` property, so the
    // central error handler's generic fallback ("BAD_REQUEST") reported an accurate status
    // with a misleading label — this keeps the response shape consistent with every other
    // endpoint's typed error codes.
    errorResponseBuilder: (_req, context) => ({
      statusCode: context.statusCode,
      code: "RATE_LIMITED",
      message: `Rate limit exceeded, retry in ${context.after}.`,
    }),
  });

  // docs/13_SECURITY_ARCHITECTURE.md §12 / docs/26_DECISIONS.md ADR-041 — the only multipart
  // consumer is POST /api/v1/files/upload (routes/v1/rag.ts). Hard caps enforced by the
  // parser itself, before any route code runs: one file per request, 25 MiB — comfortably
  // above any real document this platform ingests, far below anything that could exhaust
  // memory when buffered for the content sniff + asset-store write. Exceeding it surfaces
  // as a real 413 through the central error handler, not a silent truncation.
  await app.register(multipart, { limits: { files: 1, fileSize: UPLOAD_MAX_BYTES, fields: 5 } });

  /**
   * RED-method HTTP metrics — docs/20_OBSERVABILITY.md §2.1, ADR-082.
   *
   * `onResponse` rather than a wrapper around each route: a hook cannot be forgotten by a route
   * added later, which is the same reasoning that put `tool.call`'s span in the registry rather
   * than at its call sites (ADR-073).
   *
   * The label is `routeOptions.url` — the route PATTERN (`/api/v1/files/:id`) — never
   * `request.url`. Labelling by resolved URL would mint a new Prometheus time series for every
   * document id the platform has ever served, which is the classic way to take down a metrics
   * backend. A request that matched no route has no pattern; it is bucketed as `unmatched` so
   * 404 scanning traffic stays visible as one series instead of unbounded many.
   */
  app.addHook("onResponse", async (request, reply) => {
    recordHttpRequest({
      route: request.routeOptions?.url ?? "unmatched",
      method: request.method,
      statusCode: reply.statusCode,
      // Fastify measures this itself, from the moment the request was received.
      durationMs: reply.elapsedTime,
    });
  });

  registerErrorHandler(app);

  // BEFORE any route. `registerAuth` installs a `preHandler` hook, and Fastify only applies a
  // hook to routes registered after it in the same encapsulation context — registering it
  // below the routes would compile, start, serve traffic, and authenticate nothing. The hook
  // resolves identity for every request (cheap, indexed hash lookup) but grants nothing on its
  // own: each route names the permission it needs via `requireProject`, so a route that names
  // nothing gets nothing.
  registerAuth(app, {
    authService: ctx.auth,
    cookieSecure: ctx.cookieSecure,
    publicPaths: PUBLIC_PATHS,
  });

  registerHealthRoute(app);
  registerAuthRoutes(app, ctx);
  registerChatRoute(app, ctx);
  registerAgentRoutes(app, ctx);
  registerRagRoutes(app, ctx);
  registerAudioRoutes(app, ctx);
  registerImageRoutes(app, ctx);
  registerVideoRoutes(app, ctx);
  registerUsageRoute(app, ctx);
  registerPlatformRoutes(app, ctx);

  return app;
}
