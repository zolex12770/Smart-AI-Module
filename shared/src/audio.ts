import { z } from "zod";

/**
 * Text-to-speech as a first-class capability — docs/26_DECISIONS.md ADR-114.
 *
 * Narration existed only inside the long-form video pipeline, so a user could not ask this
 * platform for audio; the brief requires generating audio from the interface and getting a real,
 * playable file back. The request is deliberately small: the text, and two optional controls that
 * every synthesiser has some form of.
 */
export const audioGenerationRequestSchema = z.object({
  /**
   * Bounded at both ends. Empty text would synthesise silence and still spend a worker; the
   * ceiling keeps one request's share of a synthesiser proportionate — piper's cost is linear in
   * characters, and 5000 is several minutes of speech.
   */
  text: z.string().min(1).max(5000),
  /** Provider-specific voice id. Omitted means the deployment's configured default. */
  voice: z.string().min(1).max(120).optional(),
  /** 1.0 is the voice's natural rate. Providers that cannot vary rate ignore it. */
  speed: z.number().min(0.25).max(4).optional(),
});
export type AudioGenerationRequest = z.infer<typeof audioGenerationRequestSchema>;

export const audioGenerationStatusSchema = z.enum(["pending", "processing", "succeeded", "failed", "cancelled"]);
export type AudioGenerationStatus = z.infer<typeof audioGenerationStatusSchema>;
