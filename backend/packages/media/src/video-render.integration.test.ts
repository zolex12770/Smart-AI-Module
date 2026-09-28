import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { MockVideoProvider } from "@ai-platform/video-mock";
import { v4 as uuid } from "uuid";
import { LocalAssetStore } from "./asset-store.js";
import { processVideoRender } from "./video-render.js";

/**
 * docs/26_DECISIONS.md ADR-069 — the ffmpeg render stage, executed for real at last.
 *
 * `processVideoRender` shipped in ADR-030 with an honest note in its own docstring that the
 * ffmpeg-present branch had never been exercised, and the ADR-047 audit confirmed it: no
 * ffmpeg existed in the authoring environment, so only the `skipped_no_ffmpeg` path had ever
 * run. That made the concatenation, the file naming, the asset write and the status
 * transitions all unverified code.
 *
 * This runs the real binary. `FFMPEG_PATH` selects it; the suite skips loudly rather than
 * silently when there is none, and CI supplies one so the branch is covered there.
 */
const FFMPEG = process.env.FFMPEG_TEST_PATH ?? process.env.FFMPEG_PATH;

/**
 * Presence is not enough — the build has to be able to do the work.
 *
 * Found the hard way: the ffmpeg cached on the machine that wrote this is Playwright's
 * screencast build, configured `--disable-everything` with only mjpeg/png/libvpx-vp8 enabled.
 * It runs and reports a version, then cannot open a GIF or encode H.264 — so a mere presence
 * check would have failed these tests against perfectly correct render code. The pipeline
 * needs a GIF demuxer (the mock provider's clip format), libx264 (its output codec) and the
 * mp4 muxer, so that is what is probed.
 */
function buildSupportsRenderPipeline(binary: string): boolean {
  try {
    const codecs = execFileSync(binary, ["-hide_banner", "-codecs"], { encoding: "utf8", timeout: 20_000 });
    const formats = execFileSync(binary, ["-hide_banner", "-formats"], { encoding: "utf8", timeout: 20_000 });
    return codecs.includes("libx264") && / gif /.test(codecs) && / mp4 /.test(formats);
  } catch {
    return false;
  }
}

const hasFfmpeg = Boolean(FFMPEG) && buildSupportsRenderPipeline(FFMPEG as string);

if (!hasFfmpeg) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n  SKIPPING the real ffmpeg render tests: set FFMPEG_TEST_PATH to a GENERAL-PURPOSE ffmpeg\n" +
      "  (built with a gif demuxer, libx264 and the mp4 muxer). A minimal build - Playwright's\n" +
      "  screencast ffmpeg, for instance - runs but cannot perform this pipeline.\n"
  );
}

describe.skipIf(!hasFfmpeg)("processVideoRender with a REAL ffmpeg (ADR-069)", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let store: LocalAssetStore;
  let projectRepo: PgVideoProjectRepository;
  let sceneRepo: PgVideoSceneRepository;
  let assetRepo: PgAssetRepository;

  const PROJECT = "project-render";
  const USER = "user-render";

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "render-assets-"));

    const now = new Date();
    await db.insert(organizations).values({ id: "org-r", name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "r@example.com", passwordHash: "x", displayName: "R", createdAt: now, updatedAt: now });
    await db
      .insert(projects)
      .values({ id: PROJECT, organizationId: "org-r", name: "P", createdAt: now, updatedAt: now });

    assetRepo = new PgAssetRepository(db);
    store = new LocalAssetStore(assetsRoot, assetRepo);
    projectRepo = new PgVideoProjectRepository(db);
    sceneRepo = new PgVideoSceneRepository(db);
  });

  afterEach(async () => {
    await db.$client.close();
    try {
      rmSync(assetsRoot, { recursive: true, force: true });
    } catch {
      /* windows may hold a handle briefly */
    }
  });

  /** Builds a project whose scenes each hold a real generated clip. */
  async function seedProjectWithClips(sceneCount: number) {
    const videoProjectId = uuid();
    await projectRepo.create({
      id: videoProjectId,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "a test render",
      targetDurationSeconds: sceneCount * 2,
      sceneClipSeconds: 2,
      sceneCount,
    });

    const provider = new MockVideoProvider();
    const scenes = await sceneRepo.createMany(
      { projectId: PROJECT, videoProjectId },
      Array.from({ length: sceneCount }, (_, i) => ({
        id: uuid(),
        sceneIndex: i,
        shotDescription: `scene ${i}`,
        durationSeconds: 2,
      }))
    );

    for (const scene of scenes) {
      // Real generated bytes, through the real provider and the real asset store.
      const result = await provider.generateVideo(
        { prompt: scene.shotDescription, sceneIndex: scene.sceneIndex, durationSeconds: 2, seed: scene.sceneIndex },
        (bytes, mimeType, ext) => store.store(PROJECT, bytes, mimeType, ext, "video")
      );
      expect(result.status).toBe("succeeded");
      await sceneRepo.updateStatus({ projectId: PROJECT, videoProjectId }, scene.id, "succeeded", {
        assetId: result.video!.assetId,
      });
    }
    return videoProjectId;
  }

  it("concatenates real clips into a real final asset on disk", async () => {
    const videoProjectId = await seedProjectWithClips(3);

    await processVideoRender(
      { projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: FFMPEG },
      { projectId: PROJECT, videoProjectId }
    );

    const project = await projectRepo.get(PROJECT, videoProjectId);
    expect(project?.renderStatus).toBe("succeeded");
    expect(project?.renderAssetId).toBeTruthy();

    // The claim that matters: a real file exists, is non-trivial, and is readable back
    // through the asset store rather than by guessing at a path.
    const asset = await assetRepo.get(PROJECT, project!.renderAssetId!);
    expect(asset).toBeTruthy();
    expect(existsSync(asset!.storagePath)).toBe(true);
    const bytes = await store.read(asset!);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(asset!.sizeBytes).toBe(bytes.byteLength);
  });

  /**
   * DL-19: the MP4 alone does not play in a browser without H.264/AAC (measured in the
   * Playwright Chromium), so a WebM rendition ships beside it. A build that cannot encode it
   * must still ship the MP4 and say why the WebM is missing.
   */
  it("stores a VP9 WebM rendition beside the MP4 when this ffmpeg can encode one", async () => {
    const videoProjectId = await seedProjectWithClips(2);
    const outcome = await processVideoRender(
      { projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: FFMPEG },
      { projectId: PROJECT, videoProjectId }
    );
    const project = await projectRepo.get(PROJECT, videoProjectId);
    expect(project?.renderStatus).toBe("succeeded");
    expect(project?.renderAssetId).toBeTruthy();

    const encoders = execFileSync(FFMPEG!, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 20_000 });
    if (!/libvpx-vp9/.test(encoders) || !/libopus/.test(encoders)) {
      expect(project?.renderWebmAssetId).toBeNull();
      expect(outcome.webmAssetId).toBeNull();
      expect(outcome.webmError).toBeTruthy();
      return;
    }

    expect(outcome.webmError).toBeNull();
    expect(project?.renderWebmAssetId).toBe(outcome.webmAssetId);
    const webm = await assetRepo.get(PROJECT, project!.renderWebmAssetId!);
    expect(webm?.mimeType).toBe("video/webm");
    expect(webm!.id).not.toBe(project!.renderAssetId);

    // Decoded end to end, and the stream really is VP9 — not the MP4's bytes under a new name.
    const { spawnSync } = await import("node:child_process");
    const decode = spawnSync(FFMPEG!, ["-hide_banner", "-i", webm!.storagePath, "-f", "null", "-"], { encoding: "utf8" });
    expect(decode.status).toBe(0);
    expect(decode.stderr).toMatch(/Input #0, matroska,webm/);
    expect(decode.stderr).toMatch(/Video: vp9/);
  });

  /**
   * DL-24, from the audit of DL-19: the MP4 and both caption files were stored BEFORE the WebM
   * step, so a cancel observed at that step left three assets referenced by nothing. Now nothing
   * is stored until every ffmpeg step has run.
   */
  it("stores nothing when the render is cancelled just before its last ffmpeg step", async () => {
    // A wrapper that logs each ffmpeg call, so the test can cancel at an exact step.
    const dir = mkdtempSync(join(tmpdir(), "ffmpeg-wrap-"));
    const log = join(dir, "calls.log");
    const wrapper = join(dir, "ffmpeg");
    writeFileSync(wrapper, `#!/bin/sh\necho x >> "${log}"\nexec "${FFMPEG}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
    try {
      // A normal run, to learn how many ffmpeg calls a render makes.
      const measured = await seedProjectWithClips(2);
      writeFileSync(log, "");
      await processVideoRender({ projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: wrapper }, { projectId: PROJECT, videoProjectId: measured });
      const total = calls();
      expect(total).toBeGreaterThan(2);

      const videoProjectId = await seedProjectWithClips(2);
      writeFileSync(log, "");
      // The cancel request appears once every call but the last (the WebM encode) has run.
      const cancelling = new Proxy(projectRepo, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return async (projectId: string, id: string) => {
              const row = await target.get(projectId, id);
              return row && calls() >= total - 1 ? { ...row, cancelRequestedAt: new Date() } : row;
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const stored = vi.spyOn(store, "store");
      const outcome = await processVideoRender(
        { projectRepo: cancelling, sceneRepo, assetRepo, assetStore: store, ffmpegPath: wrapper },
        { projectId: PROJECT, videoProjectId }
      );
      expect(outcome.renderStatus).toBe("failed");
      expect((await projectRepo.get(PROJECT, videoProjectId))?.status).toBe("cancelled");
      expect(stored).not.toHaveBeenCalled();
      expect(calls()).toBe(total - 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces a container ffmpeg itself can read back — not merely a non-empty file", async () => {
    const videoProjectId = await seedProjectWithClips(2);
    await processVideoRender(
      { projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: FFMPEG },
      { projectId: PROJECT, videoProjectId }
    );

    const project = await projectRepo.get(PROJECT, videoProjectId);
    const asset = await assetRepo.get(PROJECT, project!.renderAssetId!);

    // Round-tripping through the encoder is the check that distinguishes "wrote bytes" from
    // "wrote a valid video": ffmpeg refuses to decode a malformed container.
    const { spawn } = await import("node:child_process");
    const exitCode = await new Promise<number | null>((resolve) => {
      const probe = spawn(FFMPEG!, ["-v", "error", "-i", asset!.storagePath, "-f", "null", "-"], { shell: false });
      probe.once("error", () => resolve(null));
      probe.once("close", (code) => resolve(code));
    });
    expect(exitCode).toBe(0);
  });

  it("records a real failure rather than a success when a scene's bytes are missing", async () => {
    const videoProjectId = await seedProjectWithClips(2);
    // Simulate a lost asset: the row survives, the object does not.
    const scenes = await sceneRepo.listByVideoProject({ projectId: PROJECT, videoProjectId });
    const asset = await assetRepo.get(PROJECT, scenes[0].assetId!);
    rmSync(asset!.storagePath, { force: true });

    await processVideoRender(
      { projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: FFMPEG },
      { projectId: PROJECT, videoProjectId }
    ).catch(() => undefined);

    const project = await projectRepo.get(PROJECT, videoProjectId);
    // Never "succeeded" with a missing input — that is the honesty rule the whole render
    // stage was written around (ADR-030).
    expect(project?.renderStatus).not.toBe("succeeded");
    expect(project?.renderAssetId).toBeNull();
  });

  it("still reports skipped_no_ffmpeg — honestly — when the binary is absent", async () => {
    const videoProjectId = await seedProjectWithClips(1);
    await processVideoRender(
      { projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: "definitely-not-a-real-binary" },
      { projectId: PROJECT, videoProjectId }
    );

    const project = await projectRepo.get(PROJECT, videoProjectId);
    expect(project?.renderStatus).toBe("skipped_no_ffmpeg");
    // The distinction that matters: no asset is invented to stand in for the missing render.
    expect(project?.renderAssetId).toBeNull();
    expect(project?.renderError).toMatch(/ffmpeg/i);
  });
});
