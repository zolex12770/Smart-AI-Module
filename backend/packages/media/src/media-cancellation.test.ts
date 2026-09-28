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
  PgImageGenerationRepository,
  PgVideoProjectRepository,
  PgVideoSceneRepository,
  type PgliteDb,
} from "@ai-platform/database";
import type { ImageProvider, VideoProvider } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import { LocalAssetStore } from "./asset-store.js";
import { processImageGeneration } from "./image-generation.js";
import { checkProjectCompletion, processVideoScene } from "./video-orchestration.js";

/**
 * Cancellation that something actually observes — docs/26_DECISIONS.md ADR-122.
 *
 * `requestCancel` and the `cancelled` status shipped with the image and video repositories and
 * nothing ever read them: no route called the one, no worker checked the other, so the state was
 * unreachable and a user could not stop work they had started. On a billed provider that is money
 * spent after the person asked for it to stop.
 *
 * These assert the property that matters: a cancelled job never reaches the provider.
 */
describe("cancelled media work never reaches the provider", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let store: LocalAssetStore;

  const PROJECT = "project-cancel";
  const USER = "user-cancel";

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "cancel-assets-"));
    const now = new Date();
    await db.insert(organizations).values({ id: "org-c", name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "c@example.com", passwordHash: "x", displayName: "C", createdAt: now, updatedAt: now });
    await db.insert(projects).values({ id: PROJECT, organizationId: "org-c", name: "P", createdAt: now, updatedAt: now });
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

  it("settles a cancelled image generation without calling the provider", async () => {
    const generationRepo = new PgImageGenerationRepository(db);
    const id = uuid();
    await generationRepo.create({
      id,
      projectId: PROJECT,
      createdByUserId: USER,
      request: { prompt: "a harbour", aspectRatio: "1:1", quality: "fast" },
    });
    await generationRepo.requestCancel(PROJECT, id);

    let called = false;
    const provider: ImageProvider = {
      name: "never-called",
      isMock: false,
      getCapabilities: () => ({
        supportsNegativePrompt: false,
        supportsSeed: false,
        maxImagesPerCall: 1,
        supportedAspectRatios: ["1:1"],
        hasFastTier: true,
      }),
      generateImage: async () => {
        called = true;
        return { status: "succeeded", providerName: "never-called", images: [{ assetId: "x", width: 1, height: 1 }] };
      },
    };

    await processImageGeneration({ generationRepo, assetStore: store, provider }, PROJECT, id);

    expect(called).toBe(false);
    const row = await generationRepo.get(PROJECT, id);
    expect(row?.status).toBe("cancelled");
    // Not even an attempt: the work never started.
    expect(row?.attemptCount).toBe(0);
  });

  it("stops an image that is already generating, and settles it as cancelled (audit finding 5)", async () => {
    const generationRepo = new PgImageGenerationRepository(db);
    const id = uuid();
    await generationRepo.create({
      id,
      projectId: PROJECT,
      createdByUserId: USER,
      request: { prompt: "a harbour", aspectRatio: "1:1", quality: "fast" },
    });
    let sawSignal: AbortSignal | undefined;
    const provider: ImageProvider = {
      name: "slow",
      isMock: false,
      getCapabilities: () => ({
        supportsNegativePrompt: false,
        supportsSeed: false,
        maxImagesPerCall: 1,
        supportedAspectRatios: ["1:1"],
        hasFastTier: true,
      }),
      // Like sd-cli under a kill: returns a failure once the signal fires.
      generateImage: (_req, _store, signal) =>
        new Promise((resolve) => {
          sawSignal = signal;
          signal?.addEventListener("abort", () =>
            resolve({ status: "failed", providerName: "slow", error: "stopped: cancelled" })
          );
        }),
    };
    const controller = new AbortController();
    const running = processImageGeneration({ generationRepo, assetStore: store, provider }, PROJECT, id, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    expect((await generationRepo.get(PROJECT, id))?.status).toBe("processing");
    controller.abort();
    await running;

    expect(sawSignal).toBe(controller.signal);
    const row = await generationRepo.get(PROJECT, id);
    expect(row?.status).toBe("cancelled");
    expect(row?.resultAssetId ?? null).toBeNull();
  });

  it("settles a cancelled video scene without calling the provider", async () => {
    const projectRepo = new PgVideoProjectRepository(db);
    const sceneRepo = new PgVideoSceneRepository(db);
    const videoProjectId = uuid();
    await projectRepo.create({
      id: videoProjectId,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "a harbour at dawn",
      targetDurationSeconds: 4,
      sceneClipSeconds: 4,
      sceneCount: 1,
    });
    const [scene] = await sceneRepo.createMany(
      { projectId: PROJECT, videoProjectId },
      [{ id: uuid(), sceneIndex: 0, shotDescription: "a wide shot", durationSeconds: 4 }]
    );
    await projectRepo.requestCancel(PROJECT, videoProjectId);

    let called = false;
    const provider: VideoProvider = {
      name: "never-called",
      isMock: false,
      getCapabilities: () => ({
        maxDurationSeconds: 30,
        supportsSeed: false,
        hasFastTier: true,
        // ADR-150: every provider states its own worst case, so the queue window can be
        // derived from it rather than guessed at in the composition root.
        worstCaseDeadlineMs: 60_000,
      }),
      generateVideo: async () => {
        called = true;
        return {
          status: "succeeded",
          providerName: "never-called",
          video: { assetId: "x", width: 1, height: 1, durationSeconds: 4 },
        };
      },
    };

    await processVideoScene(
      { projectRepo, sceneRepo, assetStore: store, provider, jobQueue: neverEnqueues() },
      { projectId: PROJECT, videoProjectId },
      scene.id
    );

    expect(called).toBe(false);
    const row = await sceneRepo.get({ projectId: PROJECT, videoProjectId }, scene.id);
    expect(row?.status).toBe("cancelled");
  });

  it("settles a scene stopped mid-generation as cancelled when the provider RETURNS a failure (audit, DL-18)", async () => {
    // The local motion provider kills ffmpeg on abort and returns `{status:"failed"}` — it does not
    // throw — and the scene used to be recorded `failed` and queued for a retry.
    const projectRepo = new PgVideoProjectRepository(db);
    const sceneRepo = new PgVideoSceneRepository(db);
    const videoProjectId = uuid();
    await projectRepo.create({
      id: videoProjectId,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "a harbour at dawn",
      targetDurationSeconds: 4,
      sceneClipSeconds: 4,
      sceneCount: 1,
    });
    const [scene] = await sceneRepo.createMany(
      { projectId: PROJECT, videoProjectId },
      [{ id: uuid(), sceneIndex: 0, shotDescription: "a wide shot", durationSeconds: 4 }]
    );
    const provider: VideoProvider = {
      name: "stoppable",
      isMock: false,
      getCapabilities: () => ({ maxDurationSeconds: 30, supportsSeed: false, hasFastTier: true, worstCaseDeadlineMs: 60_000 }),
      generateVideo: (_req, _store, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve({ status: "failed", providerName: "stoppable", error: "ffmpeg was stopped: the scene was cancelled." })
          );
        }),
    };
    const running = processVideoScene(
      { projectRepo, sceneRepo, assetStore: store, provider, jobQueue: neverEnqueues() },
      { projectId: PROJECT, videoProjectId },
      scene.id
    );
    await new Promise((r) => setTimeout(r, 200));
    await projectRepo.requestCancel(PROJECT, videoProjectId);
    await running;

    const row = await sceneRepo.get({ projectId: PROJECT, videoProjectId }, scene.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.retryCount ?? 0).toBe(0);
  }, 20_000);

  it("still runs work that was not cancelled", async () => {
    const generationRepo = new PgImageGenerationRepository(db);
    const id = uuid();
    await generationRepo.create({
      id,
      projectId: PROJECT,
      createdByUserId: USER,
      request: { prompt: "a harbour", aspectRatio: "1:1", quality: "fast" },
    });

    const provider: ImageProvider = {
      name: "real-enough",
      isMock: false,
      getCapabilities: () => ({
        supportsNegativePrompt: false,
        supportsSeed: false,
        maxImagesPerCall: 1,
        supportedAspectRatios: ["1:1"],
        hasFastTier: true,
      }),
      generateImage: async (_req, store_) => {
        const assetId = await store_(Buffer.alloc(2048, 1), "image/png", "png");
        return { status: "succeeded", providerName: "real-enough", images: [{ assetId, width: 64, height: 64 }] };
      },
    };

    await processImageGeneration({ generationRepo, assetStore: store, provider }, PROJECT, id);
    const row = await generationRepo.get(PROJECT, id);
    expect(row?.status).toBe("succeeded");
    expect(row?.attemptCount).toBe(1);
  });

  /**
   * The project's own cancelled status — docs/26_DECISIONS.md ADR-140.
   *
   * `VideoProjectStatus` included `"cancelled"` from the start and nothing could set it. ADR-122
   * gave the SCENES a cancelled status a worker observes; the completion check still only asked
   * "did every scene succeed?", so a user who stopped their render saw `partially_succeeded` and
   * "0 of 2 scene(s) failed to generate" — an invitation to retry the work they had just stopped.
   */
  it("settles a project whose scenes were all cancelled as cancelled, not partially succeeded", async () => {
    const projectRepo = new PgVideoProjectRepository(db);
    const sceneRepo = new PgVideoSceneRepository(db);
    const videoProjectId = uuid();
    await projectRepo.create({
      id: videoProjectId,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "a harbour at dawn",
      targetDurationSeconds: 8,
      sceneClipSeconds: 4,
      sceneCount: 2,
    });
    const scenes = await sceneRepo.createMany(
      { projectId: PROJECT, videoProjectId },
      [
        { id: uuid(), sceneIndex: 0, shotDescription: "a wide shot", durationSeconds: 4 },
        { id: uuid(), sceneIndex: 1, shotDescription: "a close shot", durationSeconds: 4 },
      ]
    );
    const scope = { projectId: PROJECT, videoProjectId };
    for (const scene of scenes) {
      await sceneRepo.updateStatus(scope, scene.id, "cancelled", {});
    }

    await checkProjectCompletion({ projectRepo, sceneRepo, jobQueue: neverEnqueues() }, scope);

    const row = await projectRepo.get(PROJECT, videoProjectId);
    expect(row?.status).toBe("cancelled");
    // And it does not invite a retry of work the user stopped.
    expect(row?.errorMessage ?? "").not.toMatch(/failed to generate/);
    expect(row?.errorMessage ?? "").toMatch(/cancelled/i);
  });

  it("still reports a genuine failure as partially succeeded, and mentions any cancellations", async () => {
    // A guard that turned every mixed outcome into "cancelled" would hide real failures.
    const projectRepo = new PgVideoProjectRepository(db);
    const sceneRepo = new PgVideoSceneRepository(db);
    const videoProjectId = uuid();
    await projectRepo.create({
      id: videoProjectId,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "a harbour at dawn",
      targetDurationSeconds: 12,
      sceneClipSeconds: 4,
      sceneCount: 3,
    });
    const scenes = await sceneRepo.createMany(
      { projectId: PROJECT, videoProjectId },
      [
        { id: uuid(), sceneIndex: 0, shotDescription: "one", durationSeconds: 4 },
        { id: uuid(), sceneIndex: 1, shotDescription: "two", durationSeconds: 4 },
        { id: uuid(), sceneIndex: 2, shotDescription: "three", durationSeconds: 4 },
      ]
    );
    const scope = { projectId: PROJECT, videoProjectId };
    await sceneRepo.updateStatus(scope, scenes[0]!.id, "succeeded", {});
    await sceneRepo.updateStatus(scope, scenes[1]!.id, "failed", { lastError: "the provider refused" });
    await sceneRepo.updateStatus(scope, scenes[2]!.id, "cancelled", {});

    await checkProjectCompletion({ projectRepo, sceneRepo, jobQueue: neverEnqueues() }, scope);

    const row = await projectRepo.get(PROJECT, videoProjectId);
    expect(row?.status).toBe("partially_succeeded");
    expect(row?.errorMessage ?? "").toMatch(/1 of 3 scene\(s\) failed/);
    expect(row?.errorMessage ?? "").toMatch(/1 were cancelled/);
  });
});

/** A queue that must not be reached: a cancelled or failed project enqueues no render. */
function neverEnqueues() {
  return {
    enqueue: async () => {
      throw new Error("checkProjectCompletion must not enqueue a render for a project that did not succeed");
    },
  } as never;
}
