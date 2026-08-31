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
}

export interface VideoProvider {
  readonly name: string;
  readonly isMock: boolean;
  getCapabilities(): VideoProviderCapabilities;
  generateVideo(
    req: VideoGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>
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
