import { z } from "zod";

/**
 * docs/06_VIDEO_GENERATION_RESEARCH.md: every real provider caps a single call at
 * roughly 5-25 seconds — there is no synchronous "generate a whole video" API anywhere.
 * `VideoProvider` therefore only ever generates one short clip; long-form assembly
 * (docs/07 Part 2) is a separate orchestration layer built on top, never a provider
 * capability itself.
 */
export const videoGenerationRequestSchema = z.object({
  prompt: z.string().min(1),
  sceneIndex: z.number().int().nonnegative().default(0),
  durationSeconds: z.number().positive().default(4),
  seed: z.number().int().optional(),
});
export type VideoGenerationRequest = z.infer<typeof videoGenerationRequestSchema>;

export interface GeneratedVideo {
  assetId: string;
  width: number;
  height: number;
  durationSeconds: number;
  seed?: number;
}

export interface VideoResult {
  status: "succeeded" | "failed";
  video?: GeneratedVideo;
  error?: string;
  providerName: string;
  providerMeta?: Record<string, unknown>;
}

export interface VideoProviderCapabilities {
  /** Hard ceiling for a single `generateVideo` call — docs/06's real-world range is 5-25s. */
  maxDurationSeconds: number;
  supportsSeed: boolean;
  hasFastTier: boolean;
  /**
   * The provider's own worst-case wall clock for one scene — docs/26_DECISIONS.md ADR-150.
   *
   * `video.generate_scene`'s claim window was a fixed 900s, justified in the composition root by
   * "it sits above the provider's own 10-minute deadline so the provider always gives up first".
   * That is true of the Replicate provider and false of the one a local deployment actually gets:
   * `ImageMotionVideoProvider` generates a still first and then runs ffmpeg, so its worst case is
   * the image deadline PLUS the ffmpeg deadline — 1200s by default, comfortably past the window.
   * The claim then expires mid-generation, a second worker starts, and the billed provider runs
   * twice for one scene.
   *
   * Stated by the provider rather than assumed by the caller, so a provider that changes its
   * timeout cannot silently invalidate the window sized against it.
   */
  worstCaseDeadlineMs: number;
}

export interface VideoProvider {
  readonly name: string;
  readonly isMock: boolean;
  getCapabilities(): VideoProviderCapabilities;
  /**
   * `signal` — docs/26_DECISIONS.md ADR-157.
   *
   * The Replicate adapter already accepted one as an untyped third parameter, with a comment
   * explaining that it "keeps this assignable to VideoProvider while letting a caller that HAS a
   * cancellation token stop a prediction that is still billing". No caller had one, because the
   * interface did not carry it — so the one adapter that can cancel a running, billing
   * prediction could never be told to.
   */
  generateVideo(
    req: VideoGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>,
    signal?: AbortSignal
  ): Promise<VideoResult>;
}

/**
 * User-facing request for a whole long-form video project (docs/07 Part 2 §2.1) — distinct
 * from `VideoGenerationRequest`, which is the per-scene request the orchestrator builds
 * once a project is decomposed into scenes.
 */
export const videoProjectRequestSchema = z.object({
  prompt: z.string().min(1),
  targetDurationSeconds: z.number().int().min(4).max(1800).default(20),
  sceneClipSeconds: z.number().int().min(2).max(30).default(4),
});
export type VideoProjectRequest = z.infer<typeof videoProjectRequestSchema>;
