import { describe, expect, it } from "vitest";
import { MockImageProvider } from "./index.js";

describe("MockImageProvider", () => {
  it("generates a real, valid SVG image and stores it via the provided store function", async () => {
    const provider = new MockImageProvider();
    const stored: { bytes: Buffer; mimeType: string; ext: string }[] = [];
    const store = async (bytes: Buffer, mimeType: string, ext: string) => {
      stored.push({ bytes, mimeType, ext });
      return "asset-123";
    };

    const result = await provider.generateImage({ prompt: "a red bicycle", aspectRatio: "1:1", quality: "fast" }, store);

    expect(result.status).toBe("succeeded");
    expect(result.images).toHaveLength(1);
    expect(result.images![0].assetId).toBe("asset-123");
    expect(result.images![0].width).toBe(1024);
    expect(result.images![0].height).toBe(1024);

    expect(stored).toHaveLength(1);
    expect(stored[0].mimeType).toBe("image/svg+xml");
    const svgText = stored[0].bytes.toString("utf8");
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("MOCK IMAGE");
    expect(svgText).toContain("a red bicycle");
  });

  it("is deterministic — the same prompt without an explicit seed produces the same seed every time", async () => {
    const provider = new MockImageProvider();
    const store = async () => "id";

    const r1 = await provider.generateImage({ prompt: "a blue whale", aspectRatio: "1:1", quality: "fast" }, store);
    const r2 = await provider.generateImage({ prompt: "a blue whale", aspectRatio: "1:1", quality: "fast" }, store);

    expect(r1.images![0].seed).toBe(r2.images![0].seed);
  });

  it("maps aspect ratios to real dimensions", async () => {
    const provider = new MockImageProvider();
    const store = async () => "id";

    const result = await provider.generateImage({ prompt: "x", aspectRatio: "16:9", quality: "fast" }, store);
    expect(result.images![0].width).toBe(1024);
    expect(result.images![0].height).toBe(576);
  });

  it("reports real capabilities", () => {
    const provider = new MockImageProvider();
    const caps = provider.getCapabilities();
    expect(caps.supportedAspectRatios).toContain("1:1");
    expect(caps.hasFastTier).toBe(true);
  });
});
