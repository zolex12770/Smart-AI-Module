import { describe, expect, it, vi } from "vitest";
import type { ImageProvider, ToolInvocationContext } from "@ai-platform/shared";
import { createMediaTools } from "./tools.js";
import type { AssetStore } from "./asset-store.js";
import type { SpeechProvider } from "./speech.js";

describe("createMediaTools", () => {
  const dummyContext: ToolInvocationContext = {
    projectId: "proj-123",
    agentRunId: "run-456",
    signal: new AbortController().signal,
  };

  it("returns empty array when no providers are configured", () => {
    const assetStore = {} as AssetStore;
    const tools = createMediaTools({ assetStore });
    expect(tools).toHaveLength(0);
  });

  describe("media.generate_image", () => {
    it("registers generate_image when imageProvider is present", async () => {
      const mockAssetStore: AssetStore = {
        store: vi.fn().mockResolvedValue("asset-img-001"),
        retrieve: vi.fn(),
        remove: vi.fn(),
      };

      const mockImageProvider: ImageProvider = {
        name: "test-image-provider",
        isMock: false,
        getCapabilities: () => ({
          supportsNegativePrompt: true,
          supportsSeed: true,
          maxImagesPerCall: 1,
          supportedAspectRatios: ["1:1", "16:9"],
          hasFastTier: true,
        }),
        generateImage: vi.fn().mockResolvedValue({
          status: "succeeded",
          images: [
            {
              assetId: "asset-img-001",
              width: 1024,
              height: 1024,
              seed: 42,
            },
          ],
          providerName: "test-image-provider",
        }),
      };

      const tools = createMediaTools({
        imageProvider: mockImageProvider,
        assetStore: mockAssetStore,
      });

      expect(tools).toHaveLength(1);
      const [tool] = tools;
      expect(tool.definition.id).toBe("media.generate_image");
      expect(tool.definition.name).toBe("Generate Image");
      expect(tool.definition.permissionLevel).toBe("network");

      // Execution with empty prompt fails
      const emptyRes = await tool.handler({ prompt: "   " }, dummyContext);
      expect(emptyRes.ok).toBe(false);
      expect(emptyRes.error).toContain("empty");

      // Execution with valid prompt succeeds
      const successRes = await tool.handler(
        { prompt: "a lighthouse at sunrise", aspectRatio: "16:9" },
        dummyContext
      );
      expect(successRes.ok).toBe(true);
      expect(successRes.output).toEqual({
        assetId: "asset-img-001",
        assetUrl: "/api/v1/assets/asset-img-001",
        prompt: "a lighthouse at sunrise",
        width: 1024,
        height: 1024,
        seed: 42,
      });

      // Error handling when provider fails
      (mockImageProvider.generateImage as any).mockRejectedValueOnce(
        new Error("Rate limit exceeded")
      );
      const failRes = await tool.handler(
        { prompt: "a lighthouse at sunrise" },
        dummyContext
      );
      expect(failRes.ok).toBe(false);
      expect(failRes.error).toContain("Rate limit exceeded");
    });
  });

  describe("media.synthesize_speech", () => {
    it("registers synthesize_speech when speech provider is present", async () => {
      const mockAssetStore: AssetStore = {
        store: vi.fn().mockResolvedValue("asset-audio-001"),
        retrieve: vi.fn(),
        remove: vi.fn(),
      };

      const mockSpeech: SpeechProvider = {
        name: "test-speech",
        synthesize: vi.fn().mockResolvedValue({
          bytes: Buffer.from("RIFF dummy audio"),
          mimeType: "audio/wav",
          ext: "wav",
        }),
      };

      const tools = createMediaTools({
        speech: mockSpeech,
        assetStore: mockAssetStore,
      });

      expect(tools).toHaveLength(1);
      const [tool] = tools;
      expect(tool.definition.id).toBe("media.synthesize_speech");
      expect(tool.definition.name).toBe("Synthesize Speech");
      expect(tool.definition.permissionLevel).toBe("write_local");

      // Empty text rejection
      const emptyRes = await tool.handler({ text: "" }, dummyContext);
      expect(emptyRes.ok).toBe(false);
      expect(emptyRes.error).toContain("empty");

      // Successful synthesis
      const res = await tool.handler(
        { text: "Nirnay AI cross-module orchestration" },
        dummyContext
      );
      expect(res.ok).toBe(true);
      expect(res.output).toEqual({
        assetId: "asset-audio-001",
        assetUrl: "/api/v1/assets/asset-audio-001",
        text: "Nirnay AI cross-module orchestration",
      });
      expect(mockAssetStore.store).toHaveBeenCalledWith(
        "proj-123",
        expect.any(Buffer),
        "audio/wav",
        "wav",
        "audio"
      );

      // Error handling
      (mockSpeech.synthesize as any).mockRejectedValueOnce(
        new Error("Engine offline")
      );
      const failRes = await tool.handler({ text: "Hello" }, dummyContext);
      expect(failRes.ok).toBe(false);
      expect(failRes.error).toContain("Engine offline");
    });
  });
});
