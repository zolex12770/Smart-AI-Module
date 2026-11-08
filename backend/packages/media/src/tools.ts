import type { AspectRatio, ImageProvider, ToolDefinition } from "@ai-platform/shared";
import { PERMISSION_LEVEL_DEFAULTS } from "@ai-platform/shared";
import type { ToolHandler } from "@ai-platform/shared";
import type { AssetStore } from "./asset-store.js";
import type { SpeechProvider } from "./speech.js";

export interface MediaToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export interface MediaToolDeps {
  imageProvider?: ImageProvider | null;
  speech?: SpeechProvider | null;
  assetStore: AssetStore;
}

/**
 * Exposes image generation and speech synthesis as standard native tools in the ToolRegistry,
 * allowing the autonomous agent and universal orchestrator to invoke media capabilities.
 */
export function createMediaTools(deps: MediaToolDeps): MediaToolEntry[] {
  const tools: MediaToolEntry[] = [];
  const networkDefaults = PERMISSION_LEVEL_DEFAULTS.network;
  const writeLocalDefaults = PERMISSION_LEVEL_DEFAULTS.write_local;

  if (deps.imageProvider) {
    const generateImageTool: MediaToolEntry = {
      definition: {
        id: "media.generate_image",
        name: "Generate Image",
        description:
          "Generates a high-quality visual image matching a descriptive prompt using the configured diffusion engine. " +
          "Returns the stored asset ID, URL, and prompt. Use this whenever the user requests an image, illustration, " +
          "diagram, photo, or visual artwork.",
        origin: { kind: "native", serverId: null, serverVersion: null },
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            aspectRatio: {
              type: "string",
              enum: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"],
            },
            quality: {
              type: "string",
              enum: ["fast", "standard", "high"],
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            assetId: { type: "string" },
            assetUrl: { type: "string" },
            prompt: { type: "string" },
            width: { type: "number" },
            height: { type: "number" },
            seed: { type: "number" },
          },
        },
        permissionLevel: "network",
        riskLevel: networkDefaults.riskLevel,
        requiresApproval: networkDefaults.requiresApproval,
        timeoutMs: 60_000,
        retryPolicy: { maxAttempts: 2, backoff: "fixed", idempotencyRequired: false },
        enabled: true,
      },
      handler: async (args, context) => {
        if (!deps.imageProvider) {
          return { ok: false, error: "Image generation provider is not configured on this deployment." };
        }
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
          return { ok: false, error: "Prompt must not be empty." };
        }
        const aspectRatio = (typeof args.aspectRatio === "string" ? args.aspectRatio : "1:1") as AspectRatio;
        const quality = (typeof args.quality === "string" ? args.quality : "standard") as "fast" | "standard" | "high";

        try {
          const result = await deps.imageProvider.generateImage(
            { prompt, aspectRatio, quality },
            (bytes, mimeType, ext) => deps.assetStore.store(context.projectId, bytes, mimeType, ext, "image"),
            context.signal
          );
          if (result.status !== "succeeded" || !result.images?.length) {
            return { ok: false, error: result.error ?? "Image generation failed without error detail." };
          }
          const img = result.images[0];
          return {
            ok: true,
            output: {
              assetId: img.assetId,
              assetUrl: `/api/v1/assets/${img.assetId}`,
              prompt,
              width: img.width,
              height: img.height,
              seed: img.seed,
            },
          };
        } catch (err: any) {
          return { ok: false, error: `Image generation failed: ${err.message}` };
        }
      },
    };
    tools.push(generateImageTool);
  }

  if (deps.speech) {
    const synthesizeSpeechTool: MediaToolEntry = {
      definition: {
        id: "media.synthesize_speech",
        name: "Synthesize Speech",
        description:
          "Synthesizes human-like spoken audio from a text script using the text-to-speech engine. " +
          "Returns the resulting audio asset ID, URL, and duration. Use this when the user asks for audio narration, " +
          "spoken output, voice explanation, or audio clips.",
        origin: { kind: "native", serverId: null, serverVersion: null },
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            assetId: { type: "string" },
            assetUrl: { type: "string" },
            text: { type: "string" },
          },
        },
        permissionLevel: "write_local",
        riskLevel: writeLocalDefaults.riskLevel,
        requiresApproval: writeLocalDefaults.requiresApproval,
        timeoutMs: 30_000,
        retryPolicy: { maxAttempts: 2, backoff: "fixed", idempotencyRequired: false },
        enabled: true,
      },
      handler: async (args, context) => {
        if (!deps.speech) {
          return { ok: false, error: "Speech synthesis provider is not configured on this deployment." };
        }
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          return { ok: false, error: "Text must not be empty." };
        }

        try {
          const res = await deps.speech.synthesize({ text, signal: context.signal });
          const assetId = await deps.assetStore.store(context.projectId, res.bytes, res.mimeType, res.ext, "audio");
          return {
            ok: true,
            output: {
              assetId,
              assetUrl: `/api/v1/assets/${assetId}`,
              text,
            },
          };
        } catch (err: any) {
          return { ok: false, error: `Speech synthesis failed: ${err.message}` };
        }
      },
    };
    tools.push(synthesizeSpeechTool);
  }

  return tools;
}
