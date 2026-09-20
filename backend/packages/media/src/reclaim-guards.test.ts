import { mkdtempSync, rmSync } from "node:fs";
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
  PgAudioGenerationRepository,
  PgVideoProjectRepository,
  PgVideoSceneRepository,
  type PgliteDb,
} from "@ai-platform/database";
import type { VideoProvider } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import { LocalAssetStore } from "./asset-store.js";
import { processAudioGeneration } from "./audio-generation.js";
import { processVideoScene } from "./video-orchestration.js";
import { processVideoRender } from "./video-render.js";
import type { SpeechProvider } from "./speech.js";

/**
 * The guard ADR-128 wrote for images, on the three processors that did not get it — ADR-150.
 *
 * pg-boss re-claims a job whose `expireInSeconds` elapses, on the assumption that the worker
 * died; a worker that is merely SLOW is indistinguishable from a dead one. ADR-128 fixed the
 * image path — window sized from the provider's own deadline, plus a terminal-state guard that
 * makes a re-claim harmless — and `grep -n "status ===" media/src/*.ts` then returned that guard
 * at image-generation.ts and nowhere else. Audio, video scenes and the render each called their
 * provider again, and each charge carries a stable idempotency key that deduplicates the usage
 * ROW rather than the work, so the second spend was invisible rather than prevented.
 */
const PROJECT = "project-guard";
const USER = "user-guard";
const VIDEO_PROJECT = "video-project-guard";

describe("a re-claimed media job does not pay twice", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let store: LocalAssetStore;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "guard-assets-"));
    const now = new Date();
    await db.insert(organizations).values({ id: "org-g", name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "g@example.com", passwordHash: "x", displayName: "G", createdAt: now, updatedAt: now });
    await db.insert(projects).values({ id: PROJECT, organizationId: "org-g", name: "P", createdAt: now, updatedAt: now });
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

  // --- audio ---------------------------------------------------------------------------

  const countingSpeech = (calls: { n: number }): SpeechProvider => ({
    name: "counting-speech",
    isMock: false,
    listVoices: async () => [],
    synthesize: async () => {
      calls.n += 1;
      return { bytes: Buffer.alloc(1024, 3), mimeType: "audio/wav", ext: "wav" };
    },
  });

  it("synthesises once even when the same audio job is processed twice", async () => {
    const repo = new PgAudioGenerationRepository(db);
    const id = uuid();
    await repo.create({
      id,
      projectId: PROJECT,
      createdByUserId: USER,
      request: { text: "hello there", speed: 1 },
    });

    const calls = { n: 0 };
    const deps = { generationRepo: repo, assetStore: store, speech: countingSpeech(calls) };

    await processAudioGeneration(deps, PROJECT, id);
    // Exactly what a stale-lock re-claim does: the same payload, handed to a second worker.
    const second = await processAudioGeneration(deps, PROJECT, id);

    expect(calls.n).toBe(1);
    expect(second.status).toBe("succeeded");
    // The second pass reports the finished work rather than reporting nothing.
    expect(second.assetId).not.toBeNull();
    expect((await repo.get(PROJECT, id))?.attemptCount).toBe(1);
  });

  it("still synthesises a request that has not been done yet", async () => {
    // A guard that refuses everything is indistinguishable from a broken worker.
    const repo = new PgAudioGenerationRepository(db);
    const id = uuid();
    await repo.create({
      id,
      projectId: PROJECT,
      createdByUserId: USER,
      request: { text: "hello there", speed: 1 },
    });

    const calls = { n: 0 };
    const outcome = await processAudioGeneration(
      { generationRepo: repo, assetStore: store, speech: countingSpeech(calls) },
      PROJECT,
      id
    );

    expect(calls.n).toBe(1);
    expect(outcome.status).toBe("succeeded");
  });

  // --- video scenes --------------------------------------------------------------------

  const scope = { projectId: PROJECT, videoProjectId: VIDEO_PROJECT };

  const seedVideoProject = async () => {
    const projectRepo = new PgVideoProjectRepository(db);
    const sceneRepo = new PgVideoSceneRepository(db);
    await projectRepo.create({
      id: VIDEO_PROJECT,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "a harbour at dawn",
      targetDurationSeconds: 8,
      sceneClipSeconds: 4,
      sceneCount: 1,
    });
    const sceneId = uuid();
    await sceneRepo.createMany(scope, [
      { id: sceneId, sceneIndex: 0, shotDescription: "a harbour", narration: null, durationSeconds: 4 },
    ]);
    return { projectRepo, sceneRepo, sceneId };
  };

  /** A queue that records rather than runs — the render enqueue is not what is under test. */
  const recordingQueue = () =>
    ({
      enqueue: async () => uuid(),
      publish: async () => uuid(),
    }) as never;

  const countingVideo = (calls: { n: number }, behaviour: "ok" | "throw" = "ok"): VideoProvider => ({
    name: "counting-video",
    isMock: false,
    getCapabilities: () => ({
      maxDurationSeconds: 30,
      supportsSeed: true,
      hasFastTier: true,
      worstCaseDeadlineMs: 60_000,
    }),
    generateVideo: async (_req, store_) => {
      calls.n += 1;
      if (behaviour === "throw") throw new Error("provider exploded");
      const assetId = await store_(Buffer.alloc(2048, 9), "video/mp4", "mp4");
      return { status: "succeeded", providerName: "counting-video", video: { assetId, width: 512, height: 288, durationSeconds: 4 } };
    },
  });

  it("generates a scene once even when the same job is processed twice", async () => {
    const { projectRepo, sceneRepo, sceneId } = await seedVideoProject();
    const calls = { n: 0 };
    const deps = {
      projectRepo,
      sceneRepo,
      jobQueue: recordingQueue(),
      assetStore: store,
      provider: countingVideo(calls),
    };

    await processVideoScene(deps, scope, sceneId);
    await processVideoScene(deps, scope, sceneId);

    expect(calls.n).toBe(1);
    expect((await sceneRepo.get(scope, sceneId))?.status).toBe("succeeded");
  });

  it("rethrows a scene failure so the queue can retry and dead-letter it", async () => {
    /**
     * The catch recorded the scene as `failed` and returned normally, so pg-boss marked the job
     * COMPLETED: `retryLimit: 1` never retried anything and the dead-letter queue never received
     * a single video scene. A provider outage lost every scene of every project in it, silently.
     */
    const { projectRepo, sceneRepo, sceneId } = await seedVideoProject();
    const calls = { n: 0 };
    const deps = {
      projectRepo,
      sceneRepo,
      jobQueue: recordingQueue(),
      assetStore: store,
      provider: countingVideo(calls, "throw"),
    };

    await expect(processVideoScene(deps, scope, sceneId)).rejects.toThrow(/exploded/);

    // The scene is still recorded as failed — the throw is in addition to the bookkeeping,
    // not instead of it.
    const scene = await sceneRepo.get(scope, sceneId);
    expect(scene?.status).toBe("failed");
    expect(scene?.lastError).toMatch(/exploded/);
  });

  // --- the render ----------------------------------------------------------------------

  it("does not re-compose a render that already succeeded", async () => {
    const { projectRepo } = await seedVideoProject();
    // A real asset row: `render_asset_id` is a foreign key, so the finished state has to be
    // one the database would actually hold.
    const renderedAssetId = await store.store(PROJECT, Buffer.alloc(1024, 1), "video/mp4", "mp4", "video");
    await projectRepo.updateRender(PROJECT, VIDEO_PROJECT, {
      renderStatus: "succeeded",
      renderAssetId: renderedAssetId,
    });

    // `ffmpegPath` names a binary that does not exist: if the guard were missing, the render
    // would reach `isFfmpegAvailable` and report `skipped_no_ffmpeg` instead.
    const outcome = await processVideoRender(
      {
        projectRepo,
        sceneRepo: new PgVideoSceneRepository(db),
        assetStore: store,
        assetRepo: new PgAssetRepository(db),
        ffmpegPath: join(tmpdir(), "definitely-not-ffmpeg"),
      },
      scope
    );

    expect(outcome.renderStatus).toBe("succeeded");
    expect(outcome.assetId).toBe(renderedAssetId);
    // And the row was not rewritten to `processing` on the way past.
    expect((await projectRepo.get(PROJECT, VIDEO_PROJECT))?.renderStatus).toBe("succeeded");
  });
});
