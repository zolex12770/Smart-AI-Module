import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  runMigrations,
  organizations,
  projects,
  users,
  PgAssetRepository,
  PgImageGenerationRepository,
  type PgliteDb,
} from "@ai-platform/database";
import type { ImageProvider } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import { LocalAssetStore } from "./asset-store.js";
import { processImageGeneration } from "./image-generation.js";
import { runFfmpegForTest } from "./video-render.js";

/**
 * What a re-claimed job must NOT do — docs/26_DECISIONS.md ADR-128.
 *
 * pg-boss hands a job to another worker once `expireInSeconds` passes, because it assumes the
 * first one died. A worker that is merely slow looks exactly like a dead one, and the image queue
 * allowed 60 seconds while the providers are given 180 (hosted) and up to 600 (local diffusion) —
 * so every real generation was re-claimed mid-flight and the provider was called twice for one
 * request. The usage row's idempotency key deduplicated the BILLING RECORD, which hid the second
 * charge rather than preventing it.
 *
 * The window is derived from the provider's own deadline now; this covers the other half, the
 * guard that makes a re-claim harmless whatever the timing.
 */
describe("a re-claimed image job does not pay twice", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let store: LocalAssetStore;

  const PROJECT = "project-reclaim";
  const USER = "user-reclaim";

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "reclaim-assets-"));
    const now = new Date();
    await db.insert(organizations).values({ id: "org-r", name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "r@example.com", passwordHash: "x", displayName: "R", createdAt: now, updatedAt: now });
    await db.insert(projects).values({ id: PROJECT, organizationId: "org-r", name: "P", createdAt: now, updatedAt: now });
    store = new LocalAssetStore(assetsRoot, new PgAssetRepository(db));
  });

  afterEach(async () => {
    await db.$client.close();
    try {
      rmSync(assetsRoot, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  const countingProvider = (calls: { n: number }): ImageProvider => ({
    name: "counting",
    isMock: false,
    getCapabilities: () => ({
      supportsNegativePrompt: false,
      supportsSeed: false,
      maxImagesPerCall: 1,
      supportedAspectRatios: ["1:1"],
      hasFastTier: true,
    }),
    generateImage: async (_req, store_) => {
      calls.n += 1;
      const assetId = await store_(Buffer.alloc(2048, 7), "image/png", "png");
      return { status: "succeeded", providerName: "counting", images: [{ assetId, width: 64, height: 64 }] };
    },
  });

  it("runs the provider once even when the same job is processed twice", async () => {
    const repo = new PgImageGenerationRepository(db);
    const id = uuid();
    await repo.create({
      id,
      projectId: PROJECT,
      createdByUserId: USER,
      request: { prompt: "a harbour", aspectRatio: "1:1", quality: "fast" },
    });

    const calls = { n: 0 };
    const deps = { generationRepo: repo, assetStore: store, provider: countingProvider(calls) };

    await processImageGeneration(deps, PROJECT, id);
    // Exactly what a stale-lock re-claim does: the same payload, handed to a second worker.
    await processImageGeneration(deps, PROJECT, id);

    expect(calls.n).toBe(1);
    const row = await repo.get(PROJECT, id);
    expect(row?.status).toBe("succeeded");
    // And the second pass did not restart it either.
    expect(row?.attemptCount).toBe(1);
  });

  it("does not restart work that was already cancelled", async () => {
    const repo = new PgImageGenerationRepository(db);
    const id = uuid();
    await repo.create({
      id,
      projectId: PROJECT,
      createdByUserId: USER,
      request: { prompt: "a harbour", aspectRatio: "1:1", quality: "fast" },
    });
    await repo.requestCancel(PROJECT, id);

    const calls = { n: 0 };
    const deps = { generationRepo: repo, assetStore: store, provider: countingProvider(calls) };

    await processImageGeneration(deps, PROJECT, id);
    await processImageGeneration(deps, PROJECT, id);

    expect(calls.n).toBe(0);
    expect((await repo.get(PROJECT, id))?.status).toBe("cancelled");
  });

  it("still runs a generation that has not been done yet", async () => {
    // A guard that refuses everything would be indistinguishable from a broken worker.
    const repo = new PgImageGenerationRepository(db);
    const id = uuid();
    await repo.create({
      id,
      projectId: PROJECT,
      createdByUserId: USER,
      request: { prompt: "a harbour", aspectRatio: "1:1", quality: "fast" },
    });

    const calls = { n: 0 };
    await processImageGeneration({ generationRepo: repo, assetStore: store, provider: countingProvider(calls) }, PROJECT, id);

    expect(calls.n).toBe(1);
    expect((await repo.get(PROJECT, id))?.status).toBe("succeeded");
  });
});

/**
 * Every ffmpeg invocation is bounded — ADR-128.
 *
 * `runFfmpeg` had no deadline, so a process that never exits left the promise unsettled forever.
 * The worker was lost for the lifetime of the process while pg-boss handed the same render to
 * another worker, which is how a hang became two concurrent ffmpegs writing one project.
 */
describe("the render's ffmpeg deadline", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ffmpeg-deadline-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  it("kills a process that never exits, and says why", async () => {
    // A stand-in for a wedged ffmpeg: a real child process that ignores its input and never
    // finishes. Node is used as the binary so this needs nothing installed.
    const script = join(dir, "hang.mjs");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");

    const started = Date.now();
    await expect(runFfmpegForTest(process.execPath, [script], 400)).rejects.toThrow(/deadline/i);
    // It really stopped waiting, rather than the process happening to exit.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("still resolves for a process that exits cleanly", async () => {
    await expect(runFfmpegForTest(process.execPath, ["-e", "process.exit(0)"], 15_000)).resolves.toBeUndefined();
  });

  it("still rejects with the stderr of a process that fails", async () => {
    await expect(
      runFfmpegForTest(process.execPath, ["-e", "console.error('SOMETHING WENT WRONG'); process.exit(3)"], 15_000)
    ).rejects.toThrow(/SOMETHING WENT WRONG/);
  });
});
