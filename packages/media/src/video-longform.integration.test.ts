import { execFileSync } from "node:child_process";
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
import { MockVideoProvider } from "@ai-platform/video-mock";
import { v4 as uuid } from "uuid";
import { LocalAssetStore } from "./asset-store.js";
import { processVideoRender } from "./video-render.js";
import { ffprobePathFor, measureAudioDurationSeconds } from "./subtitles.js";
import { SapiSpeechProvider, type SpeechProvider } from "./speech.js";

/**
 * docs/26_DECISIONS.md ADR-079/080/081 — the long-form pipeline's audio and subtitle stages,
 * end to end against a real ffmpeg and a real speech synthesiser.
 *
 * The claim under test is the one the product brief actually makes: a prompt becomes an MP4 that
 * has a narration track and a subtitle track, and both are REAL — the audio decodes, the subtitle
 * stream exists in the container, and the caption timings match the audio that was synthesised
 * rather than a words-per-minute guess. Asserting "we called ffmpeg with these arguments" would
 * pass against a build that produces an unplayable file, which is the failure that matters.
 */
const FFMPEG = process.env.FFMPEG_TEST_PATH ?? process.env.FFMPEG_PATH;

function buildSupportsComposition(binary: string): boolean {
  try {
    const codecs = execFileSync(binary, ["-hide_banner", "-codecs"], { encoding: "utf8", timeout: 20_000 });
    const formats = execFileSync(binary, ["-hide_banner", "-formats"], { encoding: "utf8", timeout: 20_000 });
    // The composition stage needs more than the concat stage did: an AAC encoder for the
    // narration and mov_text for the embedded captions.
    return (
      codecs.includes("libx264") &&
      / gif /.test(codecs) &&
      / mp4 /.test(formats) &&
      /\baac\b/.test(codecs) &&
      codecs.includes("mov_text")
    );
  } catch {
    return false;
  }
}

const hasFfmpeg = Boolean(FFMPEG) && buildSupportsComposition(FFMPEG as string);
const hasSpeech = SapiSpeechProvider.isAvailable();

if (!hasFfmpeg || !hasSpeech) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n  SKIPPING the long-form composition tests: ffmpeg(aac+mov_text)=${hasFfmpeg}, speech=${hasSpeech}.\n` +
      "  Set FFMPEG_TEST_PATH to a general-purpose ffmpeg; speech needs a platform synthesiser.\n"
  );
}

describe.skipIf(!hasFfmpeg || !hasSpeech)("long-form video: narration + subtitles (ADR-079/081)", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let store: LocalAssetStore;
  let projectRepo: PgVideoProjectRepository;
  let sceneRepo: PgVideoSceneRepository;
  let assetRepo: PgAssetRepository;
  let speech: SpeechProvider;

  const PROJECT = "project-longform";
  const USER = "user-longform";

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "longform-assets-"));
    const now = new Date();
    await db.insert(organizations).values({ id: "org-l", name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "l@example.com", passwordHash: "x", displayName: "L", createdAt: now, updatedAt: now });
    await db.insert(projects).values({ id: PROJECT, organizationId: "org-l", name: "P", createdAt: now, updatedAt: now });

    assetRepo = new PgAssetRepository(db);
    store = new LocalAssetStore(assetsRoot, assetRepo);
    projectRepo = new PgVideoProjectRepository(db);
    sceneRepo = new PgVideoSceneRepository(db);
    speech = new SapiSpeechProvider();
  });

  afterEach(async () => {
    await db.$client.close();
    try {
      rmSync(assetsRoot, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  /** Builds a project whose scenes each hold a real clip AND real synthesised narration. */
  async function seedNarratedProject(narrations: string[]) {
    const videoProjectId = uuid();
    await projectRepo.create({
      id: videoProjectId,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "a narrated test render",
      targetDurationSeconds: narrations.length * 2,
      sceneClipSeconds: 2,
      sceneCount: narrations.length,
    });

    const provider = new MockVideoProvider();
    const scenes = await sceneRepo.createMany(
      { projectId: PROJECT, videoProjectId },
      narrations.map((narration, i) => ({
        id: uuid(),
        sceneIndex: i,
        shotDescription: `scene ${i}`,
        narration,
        durationSeconds: 2,
      }))
    );

    for (const scene of scenes) {
      const clip = await provider.generateVideo(
        { prompt: scene.shotDescription, sceneIndex: scene.sceneIndex, durationSeconds: 2, seed: scene.sceneIndex },
        (bytes, mimeType, ext) => store.store(PROJECT, bytes, mimeType, ext, "video")
      );
      expect(clip.status).toBe("succeeded");

      // Real synthesis, through the real provider, stored as a real asset.
      const audio = await speech.synthesize({ text: scene.narration as string });
      expect(audio.bytes.byteLength).toBeGreaterThan(1000);
      const audioAssetId = await store.store(PROJECT, audio.bytes, audio.mimeType, audio.ext, "video");

      await sceneRepo.updateStatus({ projectId: PROJECT, videoProjectId }, scene.id, "succeeded", {
        assetId: clip.video!.assetId,
        audioAssetId,
      });
    }
    return videoProjectId;
  }

  it("produces an MP4 carrying a real audio stream and a real subtitle stream", async () => {
    const videoProjectId = await seedNarratedProject([
      "The first shot shows a wide valley at sunrise.",
      "The camera then moves closer to the river below.",
    ]);

    const outcome = await processVideoRender(
      { projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: FFMPEG },
      { projectId: PROJECT, videoProjectId }
    );

    expect(outcome.renderStatus).toBe("succeeded");
    expect(outcome.audioStatus).toBe("included");
    expect(outcome.subtitleAssetId).toBeTruthy();
    expect(outcome.subtitleVttAssetId).toBeTruthy();

    const asset = await assetRepo.get(PROJECT, outcome.assetId as string);
    expect(asset).toBeTruthy();

    // ffprobe is the arbiter, not our own bookkeeping: it reads the container that was actually
    // written. A file with the right size and no audio stream would pass a bytes-only check.
    const probe = execFileSync(
      ffprobePathFor(FFMPEG as string),
      ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name", "-of", "json", asset!.storagePath],
      { encoding: "utf8", timeout: 30_000 }
    );
    const streams = (JSON.parse(probe).streams ?? []) as Array<{ codec_type: string; codec_name: string }>;
    const kinds = streams.map((s) => s.codec_type);
    expect(kinds).toContain("video");
    expect(kinds).toContain("audio");
    expect(kinds).toContain("subtitle");
    expect(streams.find((s) => s.codec_type === "audio")?.codec_name).toBe("aac");
  }, 180_000);

  it("times the captions from the measured audio, not from a words-per-minute guess", async () => {
    // Two narrations of very different lengths. A constant-rate estimator would give the second
    // cue a start time proportional to the FIRST one's word count; a measured one gives it the
    // first clip's real audio length. The difference is what this asserts.
    const shortLine = "Sunrise.";
    const longLine =
      "The camera drifts slowly across the valley floor, past the river and the old stone bridge, " +
      "while the morning light climbs the far ridge.";
    const videoProjectId = await seedNarratedProject([longLine, shortLine]);

    const outcome = await processVideoRender(
      { projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: FFMPEG },
      { projectId: PROJECT, videoProjectId }
    );

    const srtAsset = await assetRepo.get(PROJECT, outcome.subtitleAssetId as string);
    const srt = (await store.read(srtAsset!)).toString("utf8");

    // Both lines are captioned, in order.
    expect(srt).toContain(longLine);
    expect(srt).toContain(shortLine);
    expect(srt.indexOf(longLine)).toBeLessThan(srt.indexOf(shortLine));

    // The second cue must begin no earlier than the first narration's real duration. The long
    // line takes several seconds to read aloud — well past the 2s scene clip — so a naive
    // implementation that laid cues out on clip boundaries would start it at 00:00:02.
    const scenes = await sceneRepo.listByVideoProject({ projectId: PROJECT, videoProjectId });
    const firstAudio = await assetRepo.get(PROJECT, scenes[0].audioAssetId as string);
    const firstPath = join(assetsRoot, "probe-first.wav");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(firstPath, await store.read(firstAudio!));
    const firstDuration = await measureAudioDurationSeconds(ffprobePathFor(FFMPEG as string), firstPath);
    expect(firstDuration).toBeGreaterThan(2);

    const secondStart = parseSecondCueStart(srt);
    expect(secondStart).toBeGreaterThanOrEqual(Math.floor(firstDuration as number));
  }, 180_000);

  it("still renders, and says so, when there is no narration at all", async () => {
    // The pre-existing behaviour must survive: a deployment with no script stage and no speech
    // provider gets exactly the video it got before, and the outcome does not imply otherwise.
    const videoProjectId = uuid();
    await projectRepo.create({
      id: videoProjectId,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "silent",
      targetDurationSeconds: 2,
      sceneClipSeconds: 2,
      sceneCount: 1,
    });
    const provider = new MockVideoProvider();
    const [scene] = await sceneRepo.createMany(
      { projectId: PROJECT, videoProjectId },
      [{ id: uuid(), sceneIndex: 0, shotDescription: "a shot", durationSeconds: 2 }]
    );
    const clip = await provider.generateVideo(
      { prompt: "a shot", sceneIndex: 0, durationSeconds: 2, seed: 0 },
      (bytes, mimeType, ext) => store.store(PROJECT, bytes, mimeType, ext, "video")
    );
    await sceneRepo.updateStatus({ projectId: PROJECT, videoProjectId }, scene.id, "succeeded", {
      assetId: clip.video!.assetId,
    });

    const outcome = await processVideoRender(
      { projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: FFMPEG },
      { projectId: PROJECT, videoProjectId }
    );

    expect(outcome.renderStatus).toBe("succeeded");
    expect(outcome.audioStatus).toBe("skipped_no_narration");
    // No captions were invented for a video that says nothing.
    expect(outcome.subtitleAssetId).toBeNull();
    expect(outcome.assetId).toBeTruthy();
  }, 120_000);
});

/** Start time, in seconds, of the second SRT cue. */
function parseSecondCueStart(srt: string): number {
  const timings = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) -->/g)];
  expect(timings.length).toBeGreaterThanOrEqual(2);
  const [, hh, mm, ss] = timings[1];
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}
