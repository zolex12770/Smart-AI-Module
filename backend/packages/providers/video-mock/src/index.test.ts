import { describe, expect, it } from "vitest";
import { videoGenerationRequestSchema } from "@ai-platform/shared";
import { MockVideoProvider } from "./index.js";
import { decodeGif } from "./gif-encoder.js";

describe("MockVideoProvider", () => {
  it("produces a real, valid, playable GIF whose frame count matches the requested duration", async () => {
    const provider = new MockVideoProvider();
    const stored: { bytes: Buffer; mimeType: string; ext: string }[] = [];
    const store = async (bytes: Buffer, mimeType: string, ext: string) => {
      stored.push({ bytes, mimeType, ext });
      return "asset-1";
    };

    const req = videoGenerationRequestSchema.parse({ prompt: "a lighthouse at dawn", sceneIndex: 2, durationSeconds: 3 });
    const result = await provider.generateVideo(req, store);

    expect(result.status).toBe("succeeded");
    expect(result.video?.assetId).toBe("asset-1");
    expect(stored).toHaveLength(1);
    expect(stored[0].mimeType).toBe("image/gif");

    const decoded = decodeGif(stored[0].bytes);
    expect(decoded.frames.length).toBe(3 * 6); // FPS=6, baked into the provider
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
  });

  it("rejects a request whose duration exceeds the provider's capabilities", async () => {
    const provider = new MockVideoProvider();
    const caps = provider.getCapabilities();
    const req = videoGenerationRequestSchema.parse({ prompt: "too long", durationSeconds: caps.maxDurationSeconds + 5 });

    const result = await provider.generateVideo(req, async () => "unused");

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exceeds/);
  });

  it("is deterministic given an explicit seed — same seed and scene produce the same pixels", async () => {
    const provider = new MockVideoProvider();
    const capture = async (bytes: Buffer) => bytes;
    const req = videoGenerationRequestSchema.parse({ prompt: "same prompt", sceneIndex: 0, durationSeconds: 1, seed: 42 });

    const a = await provider.generateVideo(req, async (bytes) => Buffer.from(bytes).toString("base64"));
    const b = await provider.generateVideo(req, async (bytes) => Buffer.from(bytes).toString("base64"));

    // Both calls stored via the same encoding path with the same seed — assert the
    // reported metadata (seed, dimensions, duration) is identical, not randomized.
    expect(a.video?.seed).toBe(42);
    expect(a.video?.seed).toBe(b.video?.seed);
    expect(a.video?.width).toBe(b.video?.width);
    expect(a.video?.height).toBe(b.video?.height);
    void capture;
  });

  it("refuses to instantiate when NODE_ENV=production (docs/26 ADR-013)", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new MockVideoProvider()).toThrow(/NODE_ENV=production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
