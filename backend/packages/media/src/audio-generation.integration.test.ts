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
  PgAudioGenerationRepository,
  type PgliteDb,
} from "@ai-platform/database";
import { v4 as uuid } from "uuid";
import { LocalAssetStore } from "./asset-store.js";
import { processAudioGeneration } from "./audio-generation.js";
import { PiperSpeechProvider } from "./speech-piper.js";
import { ffprobePathFor, measureAudioDurationSeconds } from "./subtitles.js";

/**
 * The audio job, end to end against a real synthesiser and a real database — ADR-114.
 *
 * "The row says succeeded" is not evidence of audio, so this stores the bytes the job produced and
 * asks ffprobe what they are. It also covers the two paths a job must get right besides the happy
 * one: a cancellation that arrives before synthesis starts must spend nothing, and a failing
 * synthesiser must leave a failed row with its reason rather than a stuck `processing`.
 */
const PIPER = process.env.PIPER_PATH;
const VOICE = process.env.PIPER_VOICE;
const FFMPEG = process.env.FFMPEG_TEST_PATH ?? process.env.FFMPEG_PATH;
const hasPiper = PiperSpeechProvider.isAvailable(PIPER, VOICE);

if (!hasPiper) {
  // eslint-disable-next-line no-console
  console.warn("\n  SKIPPING the real audio-generation job test: set PIPER_PATH and PIPER_VOICE.\n");
}

describe.skipIf(!hasPiper)("processAudioGeneration with a real synthesiser", () => {
  let db: PgliteDb;
  let assetsRoot: string;
  let store: LocalAssetStore;
  let assetRepo: PgAssetRepository;
  let generationRepo: PgAudioGenerationRepository;

  const PROJECT = "project-audio";
  const USER = "user-audio";

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    assetsRoot = mkdtempSync(join(tmpdir(), "audio-assets-"));
    const now = new Date();
    await db.insert(organizations).values({ id: "org-a", name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "a@example.com", passwordHash: "x", displayName: "A", createdAt: now, updatedAt: now });
    await db.insert(projects).values({ id: PROJECT, organizationId: "org-a", name: "P", createdAt: now, updatedAt: now });

    assetRepo = new PgAssetRepository(db);
    store = new LocalAssetStore(assetsRoot, assetRepo);
    generationRepo = new PgAudioGenerationRepository(db);
  });

  afterEach(async () => {
    await db.$client.close();
    try {
      rmSync(assetsRoot, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  const speech = () => new PiperSpeechProvider({ binaryPath: PIPER as string, voicePath: VOICE as string });
  /**
   * The repository has no list(): nothing in production needs one, so the test counts rows through
   * the client — media does not depend on drizzle-orm and a test must not be the reason it starts.
   */
  const storedAssetCount = async () => {
    const r = await db.$client.query<{ total: string }>("select count(*)::text as total from assets where project_id = $1", [
      PROJECT,
    ]);
    return Number(r.rows[0]?.total ?? 0);
  };

  it("produces a stored, playable asset and records the MEASURED duration", async () => {
    const id = uuid();
    await generationRepo.create({
      id,
      projectId: PROJECT,
      createdByUserId: USER,
      request: { text: "The platform can speak for itself, and this sentence proves it." },
    });

    const outcome = await processAudioGeneration(
      { generationRepo, assetStore: store, speech: speech(), ffmpegPath: FFMPEG },
      PROJECT,
      id
    );

    expect(outcome.status).toBe("succeeded");
    expect(outcome.assetId).toBeTruthy();

    const row = await generationRepo.get(PROJECT, id);
    expect(row?.status).toBe("succeeded");
    expect(row?.providerName).toBe("piper");
    expect(row?.attemptCount).toBe(1);
    expect(row?.resultAssetId).toBe(outcome.assetId);

    // The asset is real audio, not a row that says so.
    const asset = await assetRepo.get(PROJECT, outcome.assetId as string);
    expect(asset?.kind).toBe("audio");
    expect(asset?.mimeType).toBe("audio/wav");
    const bytes = await store.read(asset!);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");

    if (FFMPEG) {
      const probeDir = mkdtempSync(join(tmpdir(), "audio-probe-"));
      try {
        const path = join(probeDir, "out.wav");
        writeFileSync(path, bytes);
        const measured = await measureAudioDurationSeconds(ffprobePathFor(FFMPEG), path);
        expect(measured).toBeGreaterThan(1);
        // The stored duration is the measured one, not an estimate from the text.
        expect(row?.durationSeconds).toBeGreaterThan(0);
        expect(Math.abs((row?.durationSeconds as number) - (measured as number))).toBeLessThan(0.5);
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
      }
    }
  }, 180_000);

  it("spends nothing when the generation was cancelled before it started", async () => {
    const id = uuid();
    await generationRepo.create({ id, projectId: PROJECT, createdByUserId: USER, request: { text: "Never spoken." } });
    await generationRepo.requestCancel(PROJECT, id);

    const outcome = await processAudioGeneration(
      { generationRepo, assetStore: store, speech: speech(), ffmpegPath: FFMPEG },
      PROJECT,
      id
    );

    expect(outcome.status).toBe("cancelled");
    const row = await generationRepo.get(PROJECT, id);
    expect(row?.status).toBe("cancelled");
    // It never reached the synthesiser, so no attempt and no asset.
    expect(row?.attemptCount).toBe(0);
    expect(row?.resultAssetId).toBeNull();
    expect(await storedAssetCount()).toBe(0);
  }, 60_000);

  it("leaves a failed row carrying the reason when the synthesiser fails", async () => {
    const id = uuid();
    await generationRepo.create({ id, projectId: PROJECT, createdByUserId: USER, request: { text: "Doomed." } });

    const failing = {
      name: "piper",
      isMock: false,
      listVoices: async () => ["broken"],
      synthesize: async () => {
        throw new Error("voice model is corrupt");
      },
    };

    await expect(
      processAudioGeneration({ generationRepo, assetStore: store, speech: failing, ffmpegPath: FFMPEG }, PROJECT, id)
    ).rejects.toThrow(/voice model is corrupt/);

    const row = await generationRepo.get(PROJECT, id);
    // Failed, not stuck in `processing`.
    expect(row?.status).toBe("failed");
    /**
     * The STORED text names the stage and nothing else — ADR-155, asserted here since ADR-161.
     *
     * This line used to read `toContain("voice model is corrupt")`, and it was correct until
     * ADR-155 sanitised what a worker persists: that column is served straight back by
     * `GET /api/v1/audio/:id`, and a synthesiser's own words name the deployment — its paths,
     * its endpoints, its model files. A corrupt voice model is an operator's problem and not
     * the tenant's, so it collapses to the stage sentence while the raw error goes to the log.
     *
     * Nobody noticed the test had gone stale because it only runs where piper is installed, and
     * the default `npm test` skips it. Both halves are asserted now: the throw above still
     * carries the real reason for the caller in-process, and the row does not.
     */
    expect(row?.errorMessage).toContain("Speech synthesis failed");
    expect(row?.errorMessage).not.toContain("voice model is corrupt");
    expect(row?.attemptCount).toBe(1);
    expect(await storedAssetCount()).toBe(0);
  }, 60_000);

  it("refuses a generation id belonging to another project", async () => {
    const id = uuid();
    await generationRepo.create({ id, projectId: PROJECT, createdByUserId: USER, request: { text: "Mine." } });
    await expect(
      processAudioGeneration({ generationRepo, assetStore: store, speech: speech() }, "some-other-project", id)
    ).rejects.toThrow(/Unknown audio generation/);
  }, 60_000);
});
