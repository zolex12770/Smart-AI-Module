import { execFileSync } from "node:child_process";
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
  PgVideoProjectRepository,
  PgVideoSceneRepository,
  type PgliteDb,
} from "@ai-platform/database";
import { MockVideoProvider } from "@ai-platform/video-mock";
import { v4 as uuid } from "uuid";
import { LocalAssetStore } from "./asset-store.js";
import { processVideoRender } from "./video-render.js";
import { ffprobePathFor, measureAudioDurationSeconds } from "./subtitles.js";

/**
 * docs/26_DECISIONS.md ADR-081 — that the composed MP4, its narration track and its captions sit
 * on ONE timeline.
 *
 * THE BUG THIS EXISTS FOR. The render concatenated the per-scene narration WAVs back to back with
 * no reference to scene boundaries, and muxed the result against a video whose scenes kept their
 * own clip lengths. A 1s shot carrying 6s of narration therefore handed scene 2 a start time of
 * 6s in the audio and 1s in the picture, and the error compounded with every scene — while
 * `buildSubtitleCues` laid its cues out on a third grid that matched neither. The output still
 * played, still had an audio stream and still had captions, so every assertion the suite made at
 * the time passed. Only the durations tell the truth, which is why this asks ffprobe for them.
 *
 * The fixture deliberately makes the three candidate answers far apart: the sum of the per-scene
 * slots (right), the sum of the clip lengths (the old picture timeline) and the sum of the
 * narration lengths (the old audio timeline) differ by seconds, not by rounding.
 */
const FFMPEG = process.env.FFMPEG_TEST_PATH ?? process.env.FFMPEG_PATH;

/**
 * Presence is not capability — the Playwright screencast build that lives on some dev machines
 * runs and reports a version but cannot open a GIF or encode H.264. This stage additionally needs
 * an AAC encoder for the narration and the `tpad`/`apad`/`anullsrc` filters that hold the last
 * frame and fill a slot with silence.
 */
function buildSupportsTimelineComposition(binary: string): boolean {
  try {
    const codecs = execFileSync(binary, ["-hide_banner", "-codecs"], { encoding: "utf8", timeout: 20_000 });
    const formats = execFileSync(binary, ["-hide_banner", "-formats"], { encoding: "utf8", timeout: 20_000 });
    const filters = execFileSync(binary, ["-hide_banner", "-filters"], { encoding: "utf8", timeout: 20_000 });
    return (
      codecs.includes("libx264") &&
      / gif /.test(codecs) &&
      / mp4 /.test(formats) &&
      /\baac\b/.test(codecs) &&
      / tpad /.test(filters) &&
      / apad /.test(filters) &&
      / anullsrc /.test(filters)
    );
  } catch {
    return false;
  }
}

const hasFfmpeg = Boolean(FFMPEG) && buildSupportsTimelineComposition(FFMPEG as string);

if (!hasFfmpeg) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n  SKIPPING the timeline composition test: no ffmpeg with libx264 + gif + mp4 + aac + tpad/apad/anullsrc.\n" +
      "  Set FFMPEG_TEST_PATH to a general-purpose build to run it.\n"
  );
}

const PROBE_TOLERANCE_SECONDS = 0.4;

describe.skipIf(!hasFfmpeg)("long-form video: one timeline for picture, narration and captions", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let store: LocalAssetStore;
  let projectRepo: PgVideoProjectRepository;
  let sceneRepo: PgVideoSceneRepository;
  let assetRepo: PgAssetRepository;
  let probeDir: string;

  const PROJECT = "project-timeline";
  const USER = "user-timeline";

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "timeline-assets-"));
    probeDir = mkdtempSync(join(tmpdir(), "timeline-probe-"));
    const now = new Date();
    await db.insert(organizations).values({ id: "org-t", name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "t@example.com", passwordHash: "x", displayName: "T", createdAt: now, updatedAt: now });
    await db.insert(projects).values({ id: PROJECT, organizationId: "org-t", name: "P", createdAt: now, updatedAt: now });

    assetRepo = new PgAssetRepository(db);
    store = new LocalAssetStore(assetsRoot, assetRepo);
    projectRepo = new PgVideoProjectRepository(db);
    sceneRepo = new PgVideoSceneRepository(db);
  });

  afterEach(async () => {
    await db.$client.close();
    for (const dir of [assetsRoot, probeDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows may briefly hold a handle */
      }
    }
  });

  interface SceneFixture {
    /** Seconds asked of the mock provider. It quantises to whole frames, so the clip is close, not equal. */
    clipSeconds: number;
    /** Null for a shot nobody speaks over — the case that used to shift every later scene earlier. */
    narration: { text: string; seconds: number } | null;
  }

  /**
   * Seeds a project whose scenes hold real GIF clips from the mock provider and real WAV narration.
   *
   * The narration is synthesised here as PCM rather than through `SpeechProvider`, for two
   * reasons: this test is about the render's arithmetic, so the audio's LENGTH has to be an input
   * it chooses rather than whatever a voice happened to take; and a platform synthesiser is not
   * available on every machine, which would gate a render-stage test behind an unrelated
   * dependency. The bytes are a genuine RIFF/WAVE file either way — ffprobe reads them, ffmpeg
   * resamples them, and the slot arithmetic cannot tell where they came from.
   */
  async function seedProject(fixtures: SceneFixture[]) {
    const videoProjectId = uuid();
    await projectRepo.create({
      id: videoProjectId,
      projectId: PROJECT,
      createdByUserId: USER,
      prompt: "a render whose narration outruns its shots",
      targetDurationSeconds: fixtures.reduce((total, f) => total + f.clipSeconds, 0),
      sceneClipSeconds: 2,
      sceneCount: fixtures.length,
    });

    const provider = new MockVideoProvider();
    const scenes = await sceneRepo.createMany(
      { projectId: PROJECT, videoProjectId },
      fixtures.map((fixture, i) => ({
        id: uuid(),
        sceneIndex: i,
        shotDescription: `scene ${i}`,
        narration: fixture.narration?.text ?? null,
        durationSeconds: fixture.clipSeconds,
      }))
    );

    const expected: Array<{ clipSeconds: number; narrationSeconds: number }> = [];

    for (const scene of scenes) {
      const fixture = fixtures[scene.sceneIndex];
      const clip = await provider.generateVideo(
        {
          prompt: scene.shotDescription,
          sceneIndex: scene.sceneIndex,
          durationSeconds: fixture.clipSeconds,
          seed: scene.sceneIndex,
        },
        (bytes, mimeType, ext) => store.store(PROJECT, bytes, mimeType, ext, "video")
      );
      expect(clip.status).toBe("succeeded");

      let audioAssetId: string | undefined;
      let narrationSeconds = 0;
      if (fixture.narration) {
        const wav = pcmWav(fixture.narration.seconds);
        audioAssetId = await store.store(PROJECT, wav, "audio/wav", "wav", "video");
        narrationSeconds = await probeDuration(join(probeDir, `narration_${scene.sceneIndex}.wav`), wav);
      }

      await sceneRepo.updateStatus({ projectId: PROJECT, videoProjectId }, scene.id, "succeeded", {
        assetId: clip.video!.assetId,
        ...(audioAssetId ? { audioAssetId } : {}),
      });

      // The clip's REAL length, read back from the GIF the provider wrote — the mock renders whole
      // frames at 6fps, so a 1s request is a 1.02s clip, and an expectation built from the request
      // would be wrong before the render even started.
      const clipAsset = await assetRepo.get(PROJECT, clip.video!.assetId);
      const clipSeconds = await probeDuration(
        join(probeDir, `clip_${scene.sceneIndex}.gif`),
        await store.read(clipAsset!)
      );
      expected.push({ clipSeconds, narrationSeconds });
    }

    return { videoProjectId, expected };
  }

  /** Writes `bytes` somewhere ffprobe can open it and returns the duration it reports. */
  async function probeDuration(path: string, bytes: Buffer): Promise<number> {
    writeFileSync(path, bytes);
    const seconds = await measureAudioDurationSeconds(ffprobePathFor(FFMPEG as string), path);
    expect(seconds, `ffprobe could not measure ${path}`).not.toBeNull();
    return seconds as number;
  }

  it("gives every scene a max(clip, narration) slot, so the output is as long as the slots are", async () => {
    const { videoProjectId, expected } = await seedProject([
      // Scene 0: a short shot under a long line. This is the case that used to push scene 1's
      // narration over the tail of scene 0's picture.
      { clipSeconds: 1, narration: { text: "The valley opens slowly beneath a long, unhurried sunrise.", seconds: 6 } },
      // Scene 1: a long, silent shot. Its slot has to be filled with silence or everything after
      // it slides earlier in the audio.
      { clipSeconds: 3, narration: null },
      // Scene 2: a short shot under a line that outruns it again, so the drift would compound.
      { clipSeconds: 1, narration: { text: "And the river answers.", seconds: 2.5 } },
    ]);

    const slots = expected.map((e) => Math.max(e.clipSeconds, e.narrationSeconds));
    const expectedTotal = slots.reduce((a, b) => a + b, 0);
    const sumOfClips = expected.reduce((total, e) => total + e.clipSeconds, 0);
    const sumOfNarrations = expected.reduce((total, e) => total + e.narrationSeconds, 0);

    // The fixture must be able to tell the three answers apart, or this test proves nothing. If a
    // future edit makes the clips and narration similar lengths, this fails loudly rather than
    // quietly becoming vacuous.
    expect(expectedTotal - sumOfClips).toBeGreaterThan(3);
    expect(Math.abs(expectedTotal - sumOfNarrations)).toBeGreaterThan(2);

    const outcome = await processVideoRender(
      { projectRepo, sceneRepo, assetRepo, assetStore: store, ffmpegPath: FFMPEG },
      { projectId: PROJECT, videoProjectId }
    );

    expect(outcome.renderStatus).toBe("succeeded");
    expect(outcome.audioStatus).toBe("included");

    const asset = await assetRepo.get(PROJECT, outcome.assetId as string);
    const streams = probeStreams(asset!.storagePath);
    const video = streams.find((s) => s.codec_type === "video");
    const audio = streams.find((s) => s.codec_type === "audio");
    expect(video).toBeTruthy();
    expect(audio).toBeTruthy();

    const videoSeconds = Number(video!.duration);
    const audioSeconds = Number(audio!.duration);

    // The composed video is the sum of the SLOTS — not of the clips (the picture would end while
    // three narrations were still being spoken) and not of the narrations (scene 1's silent shot
    // would have been dropped from the timeline entirely).
    expect(videoSeconds).toBeCloseTo(expectedTotal, 0);
    expect(Math.abs(videoSeconds - expectedTotal)).toBeLessThan(PROBE_TOLERANCE_SECONDS);
    expect(Math.abs(videoSeconds - sumOfClips)).toBeGreaterThan(1);
    expect(Math.abs(videoSeconds - sumOfNarrations)).toBeGreaterThan(1);

    // And the narration track is exactly as long as the picture: a shorter one means a scene's
    // silence was never generated, and every line after it is early.
    expect(Math.abs(audioSeconds - videoSeconds)).toBeLessThan(PROBE_TOLERANCE_SECONDS);

    // The captions are laid out on that same grid. Scene 2's line is the one the old code got
    // most wrong — it started at the sum of the two earlier NARRATIONS (6s) instead of at the sum
    // of the two earlier slots.
    const srtAsset = await assetRepo.get(PROJECT, outcome.subtitleAssetId as string);
    const cueStarts = parseCueStarts((await store.read(srtAsset!)).toString("utf8"));
    expect(cueStarts).toHaveLength(2); // scene 1 is silent, so it gets no cue
    expect(cueStarts[0]).toBeCloseTo(0, 2);
    expect(Math.abs(cueStarts[1] - (slots[0] + slots[1]))).toBeLessThan(PROBE_TOLERANCE_SECONDS);
    // The last cue must still fall inside the video it captions.
    expect(cueStarts[1]).toBeLessThan(videoSeconds);
  }, 240_000);
});

/** The container's streams, as ffprobe reports them — including each one's own duration. */
function probeStreams(path: string): Array<{ codec_type: string; codec_name: string; duration: string }> {
  const probe = execFileSync(
    ffprobePathFor(FFMPEG as string),
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name,duration", "-of", "json", path],
    { encoding: "utf8", timeout: 30_000 }
  );
  return JSON.parse(probe).streams ?? [];
}

/** Every cue's start time in seconds, in file order. */
function parseCueStarts(srt: string): number[] {
  return [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) -->/g)].map(
    ([, hh, mm, ss, ms]) => Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000
  );
}

/**
 * A real 16-bit mono RIFF/WAVE file of exactly `seconds`, holding a quiet tone.
 *
 * A tone rather than digital silence so the file cannot be mistaken for an empty one by anything
 * downstream that trims silence, and written by hand so its duration is exact: the whole point of
 * this suite is comparing measured durations, and audio whose length is decided by a synthesiser
 * could not anchor an expectation.
 */
function pcmWav(seconds: number, sampleRate = 22_050): Buffer {
  const sampleCount = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 6000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
