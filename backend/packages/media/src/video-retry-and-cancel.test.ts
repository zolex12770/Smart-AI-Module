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
  PgVideoProjectRepository,
  PgVideoSceneRepository,
  type PgliteDb,
} from "@ai-platform/database";
import { v4 as uuid } from "uuid";
import { LocalAssetStore } from "./asset-store.js";
import { orchestrateVideoProject } from "./video-orchestration.js";
import { processVideoRender } from "./video-render.js";

/**
 * A render that never happened can be retried, and a cancelled one stops — ADR-157.
 *
 * Two states a video project could reach and never leave. `processVideoRender` only runs once
 * every scene has succeeded, so a render failure implies zero failed scenes — and the only Retry
 * control in the product was gated on a failed SCENE, while `orchestrateVideoProject` returned
 * early for any project already marked `succeeded` (which is what a skipped render leaves
 * behind) and released the render slot only for `failed`. `releaseRenderSlot`'s own docstring
 * said it covered "a failed or skipped render"; only half of that was implemented.
 *
 * And `requestCancel` accepts `assembling` — the screen offers Cancel there — while the render
 * never read the flag at all.
 */
const PROJECT = "project-retry";
const USER = "user-retry";

describe("a video whose render did not happen", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let store: LocalAssetStore;
  let projectRepo: PgVideoProjectRepository;
  let sceneRepo: PgVideoSceneRepository;

  const enqueued: string[] = [];
  const queue = () =>
    ({
      enqueue: async (name: string) => {
        enqueued.push(name);
        return uuid();
      },
    }) as never;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "retry-assets-"));
    const now = new Date();
    await db.insert(organizations).values({ id: "org-r", name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "r@example.com", passwordHash: "x", displayName: "R", createdAt: now, updatedAt: now });
    await db.insert(projects).values({ id: PROJECT, organizationId: "org-r", name: "P", createdAt: now, updatedAt: now });
    store = new LocalAssetStore(assetsRoot, new PgAssetRepository(db));
    projectRepo = new PgVideoProjectRepository(db);
    sceneRepo = new PgVideoSceneRepository(db);
    enqueued.length = 0;
  });

  afterEach(async () => {
    await db.$client.close();
    try {
      rmSync(assetsRoot, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  /** A project whose scenes all succeeded — the only state a render is reached from. */
  async function seedRenderedProject(renderStatus: "failed" | "skipped_no_ffmpeg" | "succeeded") {
    const videoProjectId = uuid();
    const scope = { projectId: PROJECT, videoProjectId };
    await projectRepo.create({
      id: videoProjectId,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "a harbour",
      targetDurationSeconds: 4,
      sceneClipSeconds: 4,
      sceneCount: 1,
    });
    const sceneId = uuid();
    await sceneRepo.createMany(scope, [
      { id: sceneId, sceneIndex: 0, shotDescription: "a harbour", narration: null, durationSeconds: 4 },
    ]);
    await sceneRepo.updateStatus(scope, sceneId, "succeeded", {});
    // The render claimed its slot, ran, and settled — which is what leaves the latch set.
    expect(await projectRepo.claimRenderSlot(videoProjectId)).toBe(true);
    await projectRepo.updateRender(PROJECT, videoProjectId, { renderStatus });
    await projectRepo.updateStatus(PROJECT, videoProjectId, "succeeded");
    return { videoProjectId, scope };
  }

  it("re-enqueues the render for a project whose render was skipped for want of ffmpeg", async () => {
    const { scope } = await seedRenderedProject("skipped_no_ffmpeg");

    await orchestrateVideoProject({ projectRepo, sceneRepo, jobQueue: queue() }, scope);

    // The load-bearing assertion: a second render job really was enqueued.
    expect(enqueued).toContain("video.render");
  });

  it("re-enqueues the render for a project whose render failed", async () => {
    const { scope } = await seedRenderedProject("failed");
    await orchestrateVideoProject({ projectRepo, sceneRepo, jobQueue: queue() }, scope);
    expect(enqueued).toContain("video.render");
  });

  it("does nothing for a project that really is finished", async () => {
    // A retry that re-renders a completed video would spend ffmpeg and store a second asset for
    // an identical result — which is what the early return exists to prevent.
    const { scope } = await seedRenderedProject("succeeded");
    await orchestrateVideoProject({ projectRepo, sceneRepo, jobQueue: queue() }, scope);
    expect(enqueued).toEqual([]);
  });

  it("stops a render that was cancelled, instead of assembling the whole video anyway", async () => {
    const { videoProjectId, scope } = await seedRenderedProject("failed");
    await projectRepo.updateRender(PROJECT, videoProjectId, { renderStatus: "pending" });
    await projectRepo.updateStatus(PROJECT, videoProjectId, "assembling");
    expect(await projectRepo.requestCancel(PROJECT, videoProjectId)).toBe(true);

    // `ffmpegPath` points at a real binary name so the availability probe is not what stops it;
    // the cancellation check runs before the first invocation.
    const outcome = await processVideoRender(
      { projectRepo, sceneRepo, assetStore: store, assetRepo: new PgAssetRepository(db) },
      scope
    );

    const after = await projectRepo.get(PROJECT, videoProjectId);
    expect(outcome.assetId).toBeNull();
    // The cancellation is read BEFORE the ffmpeg probe (ADR-157), so this holds whether or not
    // this machine has ffmpeg — and a cancelled project is never recorded as `skipped_no_ffmpeg`
    // and `succeeded`, which is a different claim and the one somebody would have to un-pick.
    expect(after?.status).toBe("cancelled");
    expect(after?.renderStatus).toBe("failed");
  });
});
