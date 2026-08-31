import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  runMigrations,
  PgAssetRepository,
  PgVideoProjectRepository,
  PgVideoSceneRepository,
  type DrizzleDb,
} from "@ai-platform/database";
import { fromPglite, JobQueue } from "@ai-platform/jobs";
import type { VideoGenerationRequest, VideoProvider, VideoProviderCapabilities, VideoResult } from "@ai-platform/shared";
import { MockVideoProvider } from "@ai-platform/video-mock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAssetStore } from "./asset-store.js";
import { checkProjectCompletion, createVideoProject, orchestrateVideoProject, processVideoScene } from "./video-orchestration.js";

/**
 * A `VideoProvider` wrapping the real MockVideoProvider (so stored clips are real, valid
 * GIFs, not stub bytes) that deterministically fails for one chosen scene index until
 * explicitly told to stop failing — this is what makes the resumability test below a real
 * simulation of docs/07 §2.3's "scene 37 fails, gets fixed, only scene 37 regenerates"
 * scenario, with an exact count of how many times each scene was actually attempted.
 */
class FlakyVideoProvider implements VideoProvider {
  readonly name = "flaky-mock";
  readonly isMock = true;
  callCountBySceneIndex = new Map<number, number>();
  private readonly inner = new MockVideoProvider();

  constructor(private failingSceneIndex: number | null) {}

  stopFailing(): void {
    this.failingSceneIndex = null;
  }

  getCapabilities(): VideoProviderCapabilities {
    return this.inner.getCapabilities();
  }

  async generateVideo(
    req: VideoGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>
  ): Promise<VideoResult> {
    this.callCountBySceneIndex.set(req.sceneIndex, (this.callCountBySceneIndex.get(req.sceneIndex) ?? 0) + 1);
    if (req.sceneIndex === this.failingSceneIndex) {
      return { status: "failed", error: "Simulated provider failure for this scene.", providerName: this.name };
    }
    return this.inner.generateVideo(req, store);
  }
}

describe("Long-form video pipeline resumability (real PGlite Postgres + real pg-boss)", () => {
  let db: DrizzleDb;
  let assetsRoot: string;
  let queue: JobQueue;
  let projectRepo: PgVideoProjectRepository;
  let sceneRepo: PgVideoSceneRepository;
  let assetStore: LocalAssetStore;
  let provider: FlakyVideoProvider;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "video-pipeline-test-"));
    projectRepo = new PgVideoProjectRepository(db);
    sceneRepo = new PgVideoSceneRepository(db);
    assetStore = new LocalAssetStore(assetsRoot, new PgAssetRepository(db));
    provider = new FlakyVideoProvider(1); // scene index 1 fails until stopFailing()

    queue = new JobQueue({ db: fromPglite(db.$client), backend: "pglite", superviseIntervalSeconds: 1, maintenanceIntervalSeconds: 1 });
    await queue.start();
    await queue.ensureQueue("video.generate_scene", { retryLimit: 0, expireInSeconds: 30 });
    await queue.registerWorker<{ sceneId: string }>("video.generate_scene", async ({ sceneId }) => {
      await processVideoScene({ projectRepo, sceneRepo, jobQueue: queue, assetStore, provider }, sceneId);
    });
  });

  afterEach(async () => {
    await queue.stop().catch(() => {});
    await db.$client.close();
    rmSync(assetsRoot, { recursive: true, force: true });
  });

  it("only the permanently-failed scene regenerates when orchestration is re-run — every succeeded scene is left untouched", async () => {
    const project = await createVideoProject({ projectRepo, sceneRepo }, "proj-1", {
      prompt: "a lighthouse in a storm",
      targetDurationSeconds: 16,
      sceneClipSeconds: 4,
    });
    expect(project.sceneCount).toBe(4); // 16s / 4s clips = 4 scenes: indices 0-3

    await orchestrateVideoProject({ projectRepo, sceneRepo, jobQueue: queue }, project.id);
    await waitForProjectStatus(projectRepo, project.id, ["partially_succeeded", "assembling", "succeeded"]);

    const afterFirstRun = await sceneRepo.listByProject(project.id);
    const scene0 = afterFirstRun.find((s) => s.sceneIndex === 0)!;
    const scene1 = afterFirstRun.find((s) => s.sceneIndex === 1)!;
    const scene2 = afterFirstRun.find((s) => s.sceneIndex === 2)!;
    const scene3 = afterFirstRun.find((s) => s.sceneIndex === 3)!;

    expect(scene0.status).toBe("succeeded");
    expect(scene1.status).toBe("failed"); // the deliberately-flaky scene
    expect(scene2.status).toBe("succeeded");
    expect(scene3.status).toBe("succeeded");

    const projectAfterFirstRun = await projectRepo.get(project.id);
    expect(projectAfterFirstRun?.status).toBe("partially_succeeded");

    const succeededAssetIdsBefore = { 0: scene0.assetId, 2: scene2.assetId, 3: scene3.assetId };
    const succeededUpdatedAtBefore = { 0: scene0.updatedAt.getTime(), 2: scene2.updatedAt.getTime(), 3: scene3.updatedAt.getTime() };
    expect(provider.callCountBySceneIndex.get(0)).toBe(1);
    expect(provider.callCountBySceneIndex.get(2)).toBe(1);
    expect(provider.callCountBySceneIndex.get(3)).toBe(1);
    expect(provider.callCountBySceneIndex.get(1)).toBe(1);

    // "Fix" the failure and re-run orchestration — only scene 1 should be re-submitted.
    provider.stopFailing();
    await orchestrateVideoProject({ projectRepo, sceneRepo, jobQueue: queue }, project.id);
    await waitForProjectStatus(projectRepo, project.id, ["assembling", "succeeded"]);

    const afterRetry = await sceneRepo.listByProject(project.id);
    for (const s of afterRetry) expect(s.status).toBe("succeeded");

    // The three already-succeeded scenes were never re-submitted to the provider.
    expect(provider.callCountBySceneIndex.get(0)).toBe(1);
    expect(provider.callCountBySceneIndex.get(2)).toBe(1);
    expect(provider.callCountBySceneIndex.get(3)).toBe(1);
    // Only the previously-failed scene got a second attempt.
    expect(provider.callCountBySceneIndex.get(1)).toBe(2);

    const finalScenes = await sceneRepo.listByProject(project.id);
    const final0 = finalScenes.find((s) => s.sceneIndex === 0)!;
    const final2 = finalScenes.find((s) => s.sceneIndex === 2)!;
    const final3 = finalScenes.find((s) => s.sceneIndex === 3)!;
    expect(final0.assetId).toBe(succeededAssetIdsBefore[0]);
    expect(final2.assetId).toBe(succeededAssetIdsBefore[2]);
    expect(final3.assetId).toBe(succeededAssetIdsBefore[3]);
    expect(final0.updatedAt.getTime()).toBe(succeededUpdatedAtBefore[0]);
    expect(final2.updatedAt.getTime()).toBe(succeededUpdatedAtBefore[2]);
    expect(final3.updatedAt.getTime()).toBe(succeededUpdatedAtBefore[3]);
  }, 20_000);

  it("checkProjectCompletion is a no-op while any scene is still pending/processing", async () => {
    const project = await createVideoProject({ projectRepo, sceneRepo }, "proj-2", {
      prompt: "a quiet forest",
      targetDurationSeconds: 4,
      sceneClipSeconds: 4,
    });
    await checkProjectCompletion({ projectRepo, sceneRepo, jobQueue: queue }, project.id);
    const stillPlanning = await projectRepo.get(project.id);
    expect(stillPlanning?.status).toBe("generating_scenes"); // unchanged — nothing was enqueued yet
  });
});

async function waitForProjectStatus(
  projectRepo: PgVideoProjectRepository,
  projectId: string,
  terminalStatuses: string[],
  timeoutMs = 15_000
): Promise<void> {
  const start = Date.now();
  while (true) {
    const project = await projectRepo.get(projectId);
    if (project && terminalStatuses.includes(project.status)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for project ${projectId} to reach one of [${terminalStatuses.join(", ")}] (last status: ${project?.status})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
