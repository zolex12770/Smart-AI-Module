import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  organizations,
  projects,
  runMigrations,
  PgAssetRepository,
  PgVideoProjectRepository,
  PgVideoSceneRepository,
  type DrizzleDb,
  type PgliteDb,
} from "@ai-platform/database";
import { fromPglite, JobQueue, type EnqueueOptions } from "@ai-platform/jobs";
import type { VideoGenerationRequest, VideoProvider, VideoProviderCapabilities, VideoResult } from "@ai-platform/shared";
import { MockVideoProvider } from "@ai-platform/video-mock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import { LocalAssetStore } from "./asset-store.js";
import {
  checkProjectCompletion,
  createVideoProject,
  orchestrateVideoProject,
  processVideoScene,
  type VideoProjectScope,
  type VideoSceneJobPayload,
} from "./video-orchestration.js";
import { extensionForMimeType, processVideoRender } from "./video-render.js";

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

/**
 * The real `JobQueue` — real pg-boss, real Postgres — with one added observation: what was
 * actually sent, per queue name. A subclass rather than a hand-written stub, so every count
 * asserted below is a count of sends through the exact path production uses. A stub could not
 * have caught the duplicate-render defect: the bug was in *what* the orchestrator enqueued,
 * not in how the queue delivered it.
 */
class RecordingJobQueue extends JobQueue {
  private readonly sentByQueue = new Map<string, object[]>();

  override async enqueue<T extends object>(
    queueName: string,
    payload: T,
    opts: EnqueueOptions = {}
  ): Promise<string | null> {
    const jobId = await super.enqueue(queueName, payload, opts);
    // Recorded only once the send succeeded — a job that was never queued must not count.
    const sent = this.sentByQueue.get(queueName) ?? [];
    sent.push(payload);
    this.sentByQueue.set(queueName, sent);
    return jobId;
  }

  sendCount(queueName: string): number {
    return this.sentByQueue.get(queueName)?.length ?? 0;
  }
}

/**
 * A real tenant project (ADR-049). `video_projects.project_id` and `assets.project_id` are
 * real FKs, so every row this pipeline writes needs one to exist — the same reason the
 * production code threads `projectId` through instead of defaulting it.
 */
async function seedProject(db: DrizzleDb, name: string): Promise<string> {
  const now = new Date();
  const organizationId = uuid();
  const projectId = uuid();
  await db.insert(organizations).values({ id: organizationId, name: `${name} org`, createdAt: now, updatedAt: now });
  await db.insert(projects).values({ id: projectId, organizationId, name, createdAt: now, updatedAt: now });
  return projectId;
}

describe("Long-form video pipeline resumability (real PGlite Postgres + real pg-boss)", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let queue: RecordingJobQueue;
  let projectRepo: PgVideoProjectRepository;
  let sceneRepo: PgVideoSceneRepository;
  let assetRepo: PgAssetRepository;
  let assetStore: LocalAssetStore;
  let provider: FlakyVideoProvider;
  let tenantId: string;
  let otherTenantId: string;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "video-pipeline-test-"));
    tenantId = await seedProject(db, "video pipeline");
    otherTenantId = await seedProject(db, "another tenant");
    projectRepo = new PgVideoProjectRepository(db);
    sceneRepo = new PgVideoSceneRepository(db);
    assetRepo = new PgAssetRepository(db);
    assetStore = new LocalAssetStore(assetsRoot, assetRepo);
    provider = new FlakyVideoProvider(1); // scene index 1 fails until stopFailing()

    queue = new RecordingJobQueue({ db: fromPglite(db.$client), backend: "pglite", superviseIntervalSeconds: 1, maintenanceIntervalSeconds: 1 });
    await queue.start();
    await queue.ensureQueue("video.generate_scene", { retryLimit: 0, expireInSeconds: 30 });
    // The render queue has to exist for the completion check's send to succeed; no worker is
    // registered for it, so a claimed render stays queued and observable instead of running.
    await queue.ensureQueue("video.render", { retryLimit: 0, expireInSeconds: 30 });
    await queue.registerWorker<VideoSceneJobPayload>("video.generate_scene", async (payload) => {
      // The scope travels in the payload: a worker holding only a scene id would have no
      // tenant to scope its reads to (ADR-049), which is why the payload carries both ids.
      await processVideoScene(
        { projectRepo, sceneRepo, jobQueue: queue, assetStore, provider },
        { projectId: payload.projectId, videoProjectId: payload.videoProjectId },
        payload.sceneId
      );
    });
  });

  afterEach(async () => {
    await queue.stop().catch(() => {});
    await db.$client.close();
    rmSync(assetsRoot, { recursive: true, force: true });
  });

  it("only the permanently-failed scene regenerates when orchestration is re-run — every succeeded scene is left untouched", async () => {
    const project = await createVideoProject(
      { projectRepo, sceneRepo },
      {
        projectId: tenantId,
        videoProjectId: "proj-1",
        createdByUserId: null, // system-initiated: no authenticated user in this test
        request: { prompt: "a lighthouse in a storm", targetDurationSeconds: 16, sceneClipSeconds: 4 },
      }
    );
    expect(project.sceneCount).toBe(4); // 16s / 4s clips = 4 scenes: indices 0-3
    const scope: VideoProjectScope = { projectId: tenantId, videoProjectId: project.id };

    await orchestrateVideoProject({ projectRepo, sceneRepo, jobQueue: queue }, scope);
    await waitForProjectStatus(projectRepo, scope, ["partially_succeeded", "assembling", "succeeded"]);

    const afterFirstRun = await sceneRepo.listByVideoProject(scope);
    const scene0 = afterFirstRun.find((s) => s.sceneIndex === 0)!;
    const scene1 = afterFirstRun.find((s) => s.sceneIndex === 1)!;
    const scene2 = afterFirstRun.find((s) => s.sceneIndex === 2)!;
    const scene3 = afterFirstRun.find((s) => s.sceneIndex === 3)!;

    expect(scene0.status).toBe("succeeded");
    expect(scene1.status).toBe("failed"); // the deliberately-flaky scene
    expect(scene2.status).toBe("succeeded");
    expect(scene3.status).toBe("succeeded");

    const projectAfterFirstRun = await projectRepo.get(tenantId, project.id);
    expect(projectAfterFirstRun?.status).toBe("partially_succeeded");

    // Every clip the provider produced is owned by the tenant that asked for the video, and
    // by nobody else — the threaded projectId is what makes the asset servable later.
    const clip = await assetRepo.get(tenantId, scene0.assetId!);
    expect(clip?.projectId).toBe(tenantId);
    expect(clip?.kind).toBe("video");
    expect(await assetRepo.get(otherTenantId, scene0.assetId!)).toBeUndefined();

    const succeededAssetIdsBefore = { 0: scene0.assetId, 2: scene2.assetId, 3: scene3.assetId };
    const succeededUpdatedAtBefore = { 0: scene0.updatedAt.getTime(), 2: scene2.updatedAt.getTime(), 3: scene3.updatedAt.getTime() };
    expect(provider.callCountBySceneIndex.get(0)).toBe(1);
    expect(provider.callCountBySceneIndex.get(2)).toBe(1);
    expect(provider.callCountBySceneIndex.get(3)).toBe(1);
    expect(provider.callCountBySceneIndex.get(1)).toBe(1);

    // "Fix" the failure and re-run orchestration — only scene 1 should be re-submitted.
    provider.stopFailing();
    await orchestrateVideoProject({ projectRepo, sceneRepo, jobQueue: queue }, scope);
    await waitForProjectStatus(projectRepo, scope, ["assembling", "succeeded"]);

    const afterRetry = await sceneRepo.listByVideoProject(scope);
    for (const s of afterRetry) expect(s.status).toBe("succeeded");

    // The three already-succeeded scenes were never re-submitted to the provider.
    expect(provider.callCountBySceneIndex.get(0)).toBe(1);
    expect(provider.callCountBySceneIndex.get(2)).toBe(1);
    expect(provider.callCountBySceneIndex.get(3)).toBe(1);
    // Only the previously-failed scene got a second attempt.
    expect(provider.callCountBySceneIndex.get(1)).toBe(2);
    // ...and exactly one render was enqueued for the whole run, by whichever scene settled last.
    expect(queue.sendCount("video.render")).toBe(1);

    const finalScenes = await sceneRepo.listByVideoProject(scope);
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
    const project = await createVideoProject(
      { projectRepo, sceneRepo },
      {
        projectId: tenantId,
        videoProjectId: "proj-2",
        createdByUserId: null,
        request: { prompt: "a quiet forest", targetDurationSeconds: 4, sceneClipSeconds: 4 },
      }
    );
    const scope: VideoProjectScope = { projectId: tenantId, videoProjectId: project.id };

    await checkProjectCompletion({ projectRepo, sceneRepo, jobQueue: queue }, scope);

    const stillGenerating = await projectRepo.get(tenantId, project.id);
    expect(stillGenerating?.status).toBe("generating_scenes"); // unchanged — nothing was enqueued yet
    expect(stillGenerating?.renderRequestedAt).toBeNull(); // and no render slot was claimed
    expect(queue.sendCount("video.render")).toBe(0);
  });
});

/**
 * The two duplicate-work defects the audit found, each pinned by a test that fails against
 * the previous implementation. No scene worker is registered here: scene rows stay exactly
 * where each test puts them, so what is asserted is the orchestrator's own decision to
 * enqueue (or not) rather than a race with a worker.
 */
describe("Duplicate-work guards (real PGlite Postgres + real pg-boss)", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let queue: RecordingJobQueue;
  let projectRepo: PgVideoProjectRepository;
  let sceneRepo: PgVideoSceneRepository;
  let assetStore: LocalAssetStore;
  let tenantId: string;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "video-guards-test-"));
    tenantId = await seedProject(db, "video guards");
    projectRepo = new PgVideoProjectRepository(db);
    sceneRepo = new PgVideoSceneRepository(db);
    assetStore = new LocalAssetStore(assetsRoot, new PgAssetRepository(db));

    queue = new RecordingJobQueue({ db: fromPglite(db.$client), backend: "pglite" });
    await queue.start();
    await queue.ensureQueue("video.generate_scene", { retryLimit: 0, expireInSeconds: 30 });
    await queue.ensureQueue("video.render", { retryLimit: 0, expireInSeconds: 30 });
  });

  afterEach(async () => {
    await queue.stop().catch(() => {});
    await db.$client.close();
    rmSync(assetsRoot, { recursive: true, force: true });
  });

  /** Creates a project and drives every scene to `succeeded` with a real, owned asset. */
  async function projectWithAllScenesSucceeded(videoProjectId: string): Promise<VideoProjectScope> {
    const project = await createVideoProject(
      { projectRepo, sceneRepo },
      {
        projectId: tenantId,
        videoProjectId,
        createdByUserId: null,
        request: { prompt: "a harbour at dawn", targetDurationSeconds: 8, sceneClipSeconds: 4 },
      }
    );
    const scope: VideoProjectScope = { projectId: tenantId, videoProjectId: project.id };
    for (const scene of await sceneRepo.listByVideoProject(scope)) {
      const assetId = await assetStore.store(tenantId, Buffer.from("GIF89a-clip"), "image/gif", "gif", "video");
      await sceneRepo.updateStatus(scope, scene.id, "succeeded", { assetId });
    }
    return scope;
  }

  it("two concurrent completion checks enqueue exactly ONE render", async () => {
    const scope = await projectWithAllScenesSucceeded("proj-concurrent");
    const deps = { projectRepo, sceneRepo, jobQueue: queue };

    // Both calls read the scene list before either writes — the exact interleaving that made
    // the previous read-then-write version enqueue two renders for one project, and the
    // reason the guard has to be `claimRenderSlot`'s single conditional UPDATE.
    await Promise.all([checkProjectCompletion(deps, scope), checkProjectCompletion(deps, scope)]);

    expect(queue.sendCount("video.render")).toBe(1);
    const project = await projectRepo.get(scope.projectId, scope.videoProjectId);
    expect(project?.status).toBe("assembling");
    expect(project?.renderRequestedAt).not.toBeNull(); // the slot is held by the one winner
  });

  it("a retry does not re-enqueue scenes that are still pending or processing", async () => {
    const project = await createVideoProject(
      { projectRepo, sceneRepo },
      {
        projectId: tenantId,
        videoProjectId: "proj-retry",
        createdByUserId: null,
        request: { prompt: "a slow train", targetDurationSeconds: 16, sceneClipSeconds: 4 },
      }
    );
    const scope: VideoProjectScope = { projectId: tenantId, videoProjectId: project.id };
    const deps = { projectRepo, sceneRepo, jobQueue: queue };

    await orchestrateVideoProject(deps, scope);
    expect(queue.sendCount("video.generate_scene")).toBe(4);
    const afterFirst = await sceneRepo.listByVideoProject(scope);
    expect(afterFirst.every((s) => s.status === "pending" && s.jobId !== null)).toBe(true);

    // One scene has been picked up by a worker in the meantime; the rest are still queued.
    await sceneRepo.updateStatus(scope, afterFirst[0].id, "processing");

    await orchestrateVideoProject(deps, scope);

    // Still four. Re-submitting a queued scene would run the provider twice for it and write
    // two usage rows for one clip; redelivering a job that already exists is pg-boss's job.
    expect(queue.sendCount("video.generate_scene")).toBe(4);
    const afterRetry = await sceneRepo.listByVideoProject(scope);
    expect(afterRetry.map((s) => s.jobId)).toEqual(afterFirst.map((s) => s.jobId));
  });

  it("a retry does not re-run a project that already succeeded", async () => {
    const scope = await projectWithAllScenesSucceeded("proj-done");
    const deps = { projectRepo, sceneRepo, jobQueue: queue };

    // Settle it exactly as a finished render would: one render enqueued, then a real final asset.
    await checkProjectCompletion(deps, scope);
    const renderAssetId = await assetStore.store(tenantId, Buffer.from("fake-mp4"), "video/mp4", "mp4", "video");
    await projectRepo.updateRender(scope.projectId, scope.videoProjectId, {
      renderStatus: "succeeded",
      renderAssetId,
    });
    await projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "succeeded");

    const delivered = (await projectRepo.get(scope.projectId, scope.videoProjectId))!;

    await orchestrateVideoProject(deps, scope);

    expect(queue.sendCount("video.render")).toBe(1); // not a second render
    expect(queue.sendCount("video.generate_scene")).toBe(0); // and nothing regenerated
    const afterRetry = (await projectRepo.get(scope.projectId, scope.videoProjectId))!;
    expect(afterRetry.status).toBe("succeeded"); // still succeeded, not knocked back to `assembling`
    expect(afterRetry.renderAssetId).toBe(renderAssetId);
    expect(afterRetry.updatedAt.getTime()).toBe(delivered.updatedAt.getTime()); // nothing wrote to the row at all

    // The sharp edge of the same rule: a stale worker settling one scene as `failed` *after*
    // the video was delivered must not make a retry quietly regenerate a clip for a video
    // that already shipped. Without the "already succeeded" guard the scene list is consulted
    // regardless of the project's own state, and that scene is re-submitted.
    const [firstScene] = await sceneRepo.listByVideoProject(scope);
    await sceneRepo.updateStatus(scope, firstScene.id, "failed", { lastError: "late duplicate settle" });

    await orchestrateVideoProject(deps, scope);

    expect(queue.sendCount("video.generate_scene")).toBe(0);
    expect((await projectRepo.get(scope.projectId, scope.videoProjectId))?.status).toBe("succeeded");
  });

  it("a retry CAN re-attempt a render that failed — the slot is a guard, not a one-shot latch", async () => {
    const scope = await projectWithAllScenesSucceeded("proj-render-failed");
    const deps = { projectRepo, sceneRepo, jobQueue: queue };

    await checkProjectCompletion(deps, scope);
    expect(queue.sendCount("video.render")).toBe(1);

    // The render job ran and failed (e.g. ffmpeg exited non-zero), exactly as processVideoRender
    // records it.
    await projectRepo.updateRender(scope.projectId, scope.videoProjectId, {
      renderStatus: "failed",
      renderError: "ffmpeg exited with code 1",
    });
    await projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "failed", {
      errorMessage: "Rendering failed: ffmpeg exited with code 1",
    });

    await orchestrateVideoProject(deps, scope);

    expect(queue.sendCount("video.render")).toBe(2);
    expect(queue.sendCount("video.generate_scene")).toBe(0); // no scene needed regenerating
    expect((await projectRepo.get(scope.projectId, scope.videoProjectId))?.status).toBe("assembling");
  });

  it("without ffmpeg the render is honestly skipped — no fabricated video, scenes still succeeded", async () => {
    const scope = await projectWithAllScenesSucceeded("proj-no-ffmpeg");
    const assetRepo = new PgAssetRepository(db);

    await processVideoRender(
      {
        projectRepo,
        sceneRepo,
        assetRepo,
        assetStore,
        // A path that cannot exist, so the ffmpeg-absent branch is taken deterministically
        // even on a machine that does have ffmpeg installed.
        ffmpegPath: join(assetsRoot, "definitely-not-ffmpeg"),
      },
      scope
    );

    const project = await projectRepo.get(scope.projectId, scope.videoProjectId);
    expect(project?.renderStatus).toBe("skipped_no_ffmpeg");
    expect(project?.renderError).toMatch(/ffmpeg was not found on PATH/);
    expect(project?.renderAssetId).toBeNull(); // nothing was fabricated to stand in for the MP4
    expect(project?.status).toBe("succeeded"); // every scene really did generate
  });
});

/**
 * The render's input extension comes from the asset's own declared type. It used to be
 * parsed out of `storagePath`, which only the AssetStore that wrote it may interpret
 * (ADR-040) — under `CloudStorageAssetStore` that field is a `gs://` URI, not a filename.
 */
describe("extensionForMimeType", () => {
  it("maps the mock provider's real GIF clips and the rendered MP4", () => {
    expect(extensionForMimeType("image/gif")).toBe("gif");
    expect(extensionForMimeType("video/mp4")).toBe("mp4");
  });

  it("ignores media-type parameters and casing", () => {
    expect(extensionForMimeType("VIDEO/MP4; codecs=avc1.42E01E")).toBe("mp4");
  });

  it("falls back to bin for an unknown type rather than guessing", () => {
    expect(extensionForMimeType("application/x-unknown")).toBe("bin");
  });
});

async function waitForProjectStatus(
  projectRepo: PgVideoProjectRepository,
  scope: VideoProjectScope,
  terminalStatuses: string[],
  timeoutMs = 15_000
): Promise<void> {
  const start = Date.now();
  while (true) {
    const project = await projectRepo.get(scope.projectId, scope.videoProjectId);
    if (project && terminalStatuses.includes(project.status)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for video project ${scope.videoProjectId} to reach one of [${terminalStatuses.join(", ")}] (last status: ${project?.status})`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
