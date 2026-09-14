import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Which media provider is really in use — docs/26_DECISIONS.md ADR-124.
 *
 * `/api/v1/providers` reported `{ available: true }` for image and video and nothing else, so no
 * screen could distinguish a real generator from a placeholder. The Videos page filled the gap
 * with fixed prose ("a mock clip provider … a real, playable animated GIF"), which became false
 * the moment a real local provider existed. Chat models have carried `isMock` since ADR-065;
 * these hold media to the same standard.
 */
describe("GET /api/v1/providers reports the real media providers", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  const get = async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/providers", headers: auth.headers });
    expect(res.statusCode).toBe(200);
    return (res.json() as { providers: Record<string, { available: boolean; name?: string; isMock?: boolean; technique?: string | null }> })
      .providers;
  };

  it("names each media provider and says whether it is a mock", async () => {
    const providers = await get();

    for (const kind of ["image", "video", "speech"] as const) {
      expect(providers[kind]).toBeDefined();
      expect(typeof providers[kind].available).toBe("boolean");
    }
    // The test app runs on mocks, and the response says so rather than leaving it to be guessed.
    expect(providers.image).toMatchObject({ available: true, name: "mock", isMock: true });
    expect(providers.video).toMatchObject({ name: "mock", isMock: true });
  });

  it("carries the video provider's own description of its ceiling", async () => {
    // `technique` is how a provider that animates a still rather than generating video says so
    // (ADR-121). Null is a valid answer — silence is better than an invented claim — but the
    // FIELD must be present, or a screen cannot tell "no statement" from "not supported".
    const providers = await get();
    expect(providers.video).toHaveProperty("technique");
  });

  it("reflects a real provider as real, not as a mock", async () => {
    // The mock flag has to come from the provider actually in use, not from a constant. Swapping
    // the descriptor is enough to prove the route reads it rather than reporting a fixed answer.
    ctx.mediaProviders.image = { name: "sdcpp", isMock: false };
    ctx.mediaProviders.video = { name: "image-motion", isMock: false, technique: "a still, animated by ffmpeg — motion, not a video model" };

    const providers = await get();
    expect(providers.image).toMatchObject({ name: "sdcpp", isMock: false });
    expect(providers.video).toMatchObject({ name: "image-motion", isMock: false });
    expect(providers.video.technique).toMatch(/not a video model/);
  });

  it("still answers when nothing is configured, without pretending something is", async () => {
    ctx.mediaProviders.image = null;
    ctx.mediaProviders.video = null;
    ctx.mediaProviders.speech = null;

    const providers = await get();
    // No name and no mock flag — the absence is visible rather than filled in with a default.
    expect(providers.image.name).toBeUndefined();
    expect(providers.video.name).toBeUndefined();
    expect(providers.speech.name).toBeUndefined();
  });

  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/providers" })).statusCode).toBe(401);
  });
});
