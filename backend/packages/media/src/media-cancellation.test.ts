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
import { processVideoScene } from "./video-orchestration.js";

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
      getCapabilities: () => ({ maxDurationSeconds: 30, supportsSeed: false, hasFastTier: true }),
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
      { projectRepo, sceneRepo, assetStore: store, provider },
      { projectId: PROJECT, videoProjectId },
      scene.id
    );

    expect(called).toBe(false);
    const row = await sceneRepo.get({ projectId: PROJECT, videoProjectId }, scene.id);
    expect(row?.status).toBe("cancelled");
  });

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
});
