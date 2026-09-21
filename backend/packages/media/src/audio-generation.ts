import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioGeneration, AudioGenerationRepository } from "@ai-platform/database";
import type { AssetStore } from "./asset-store.js";
import type { SpeechProvider } from "./speech.js";
import { describeFailureForCaller } from "./failure-message.js";
import { ffprobePathFor, measureAudioDurationSeconds } from "./subtitles.js";

/**
 * Turning a speech request into a real, stored, measured audio asset — ADR-114.
 *
 * The same job-worker split as image generation (`processImageGeneration`): the route records a
 * pending row and returns, and this runs behind the queue, so a slow synthesiser never holds an
 * HTTP connection open and a retry is the queue's business rather than the caller's.
 *
 * Two things are deliberate:
 *
 *  - **The duration is MEASURED, with ffprobe, from the bytes that were produced** — never
 *    estimated from the text's length. A words-per-minute guess is exactly the kind of number that
 *    looks right in a list and is wrong in the player, and this platform already made that mistake
 *    once in subtitles (ADR-081). Where no ffmpeg is configured the column stays null, which reads
 *    as "not measured" rather than as a fabricated figure.
 *  - **Cancellation is observed before the synthesiser is started and honoured while it runs.** A
 *    request cancelled while queued must not spend a worker at all.
 */
export interface AudioGenerationDeps {
  generationRepo: AudioGenerationRepository;
  assetStore: AssetStore;
  speech: SpeechProvider;
  /** Where the RAW failure goes, since the stored one is bounded (ADR-155). */
  logger?: { error(obj: unknown, msg: string): void };
  /** Enables duration measurement. Without it the produced audio is still stored. */
  ffmpegPath?: string;
}

export interface AudioGenerationOutcome {
  status: AudioGeneration["status"];
  assetId: string | null;
  durationSeconds: number | null;
}

export async function processAudioGeneration(
  deps: AudioGenerationDeps,
  projectId: string,
  generationId: string,
  signal?: AbortSignal
): Promise<AudioGenerationOutcome> {
  const generation = await deps.generationRepo.get(projectId, generationId);
  if (!generation) throw new Error(`Unknown audio generation "${generationId}" in project "${projectId}".`);

  // Cancelled before a worker picked it up: settle it without spending a synthesiser.
  if (generation.cancelRequestedAt) {
    await deps.generationRepo.updateStatus(projectId, generationId, "cancelled", {
      errorMessage: "Cancelled before synthesis started.",
    });
    return { status: "cancelled", assetId: null, durationSeconds: null };
  }

  /**
   * Already finished — docs/26_DECISIONS.md ADR-128, extended here by ADR-150.
   *
   * ADR-128 wrote this guard for images and said exactly why: pg-boss re-claims a job whose
   * `expireInSeconds` elapses, on the assumption the worker died, and a worker that is merely
   * SLOW is indistinguishable from a dead one. The guard was then added to one of the four
   * processors. Audio's claim window is a fixed 300s while a local Piper synthesis of a long
   * script has no such bound, so a re-claim calls the synthesiser a second time — and the usage
   * row's `audio.generate:<id>` idempotency key deduplicates the RECORD, not the work, so the
   * second call is paid for and invisible.
   */
  if (generation.status === "succeeded" || generation.status === "cancelled") {
    return {
      status: generation.status,
      assetId: generation.resultAssetId ?? null,
      durationSeconds: generation.durationSeconds ?? null,
    };
  }

  await deps.generationRepo.updateStatus(projectId, generationId, "processing", { incrementAttempt: true });

  try {
    const result = await deps.speech.synthesize({
      text: generation.request.text,
      voice: generation.request.voice,
      speed: generation.request.speed,
      signal,
    });

    let durationSeconds: number | null = null;
    if (deps.ffmpegPath) {
      const dir = await mkdtemp(join(tmpdir(), "audio-measure-"));
      try {
        const probePath = join(dir, `speech.${result.ext}`);
        await writeFile(probePath, result.bytes);
        durationSeconds = await measureAudioDurationSeconds(ffprobePathFor(deps.ffmpegPath), probePath);
      } catch {
        // A measurement failure is not a generation failure: the audio exists and is served.
        durationSeconds = null;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    // The bytes belong to the project that asked for them — the only scope they can be served under.
    const assetId = await deps.assetStore.store(projectId, result.bytes, result.mimeType, result.ext, "audio");

    await deps.generationRepo.updateStatus(projectId, generationId, "succeeded", {
      providerName: deps.speech.name,
      voiceName: generation.request.voice ?? (await firstVoice(deps.speech)),
      resultAssetId: assetId,
      ...(durationSeconds !== null ? { durationSeconds } : {}),
    });
    return { status: "succeeded", assetId, durationSeconds };
  } catch (err) {
    const cancelled = signal?.aborted === true;
    // ADR-155 — a synthesiser's error names its endpoint or a binary path, and this column is
    // served back to the tenant. The detail goes to the log.
    deps.logger?.error({ project_id: projectId, generation_id: generationId, err }, "speech synthesis failed");
    await deps.generationRepo.updateStatus(projectId, generationId, cancelled ? "cancelled" : "failed", {
      providerName: deps.speech.name,
      errorMessage: describeFailureForCaller("speech", err),
    });
    // Rethrown so the queue sees a failure and applies its own retry and dead-letter policy.
    throw err;
  }
}

/** The provider's default voice, for the record. Never fails the generation. */
async function firstVoice(speech: SpeechProvider): Promise<string | undefined> {
  try {
    const voices = await speech.listVoices();
    return voices[0];
  } catch {
    return undefined;
  }
}
