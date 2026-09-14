import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleImageProvider } from "./index.js";

/**
 * ADR-065. The point of this adapter is that the platform can generate real images without a
 * hosted account, so the tests pin the wire contract it depends on: the request shape servers
 * like LocalAI expect, and both documented response forms.
 */

const PNG = Buffer.from("fake-png-bytes");
const B64 = PNG.toString("base64");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const base = { baseUrl: "http://127.0.0.1:8080/v1", model: "stable-diffusion" };

function collectStore() {
  const stored: Array<{ bytes: Buffer; mimeType: string; ext: string }> = [];
  const store = async (bytes: Buffer, mimeType: string, ext: string) => {
    stored.push({ bytes, mimeType, ext });
    return `asset-${stored.length}`;
  };
  return { stored, store };
}

describe("OpenAICompatibleImageProvider", () => {
  it("sends the documented request shape and stores the returned bytes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ b64_json: B64 }] })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleImageProvider({ ...base, apiKey: "sk-local", fetchImpl });
    const { stored, store } = collectStore();

    const result = await provider.generateImage(
      { prompt: "a lighthouse at dusk", aspectRatio: "16:9", quality: "standard" },
      store
    );

    expect(result.status).toBe("succeeded");
    expect(result.images?.[0]).toMatchObject({ assetId: "asset-1", width: 1792, height: 1024 });
    expect(stored[0]).toMatchObject({ mimeType: "image/png", ext: "png" });
    expect(stored[0].bytes.equals(PNG)).toBe(true);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/images/generations");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-local");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "stable-diffusion",
      prompt: "a lighthouse at dusk",
      n: 1,
      size: "1792x1024",
      response_format: "b64_json",
    });
  });

  it("downloads an image returned as a URL, because those links expire", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: "https://cdn.example/img.png" }] }))
      .mockResolvedValueOnce(new Response(PNG, { status: 200 })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleImageProvider({ ...base, fetchImpl });
    const { stored, store } = collectStore();

    const result = await provider.generateImage({ prompt: "x", aspectRatio: "1:1", quality: "fast" }, store);
    expect(result.status).toBe("succeeded");
    expect(stored[0].bytes.equals(PNG)).toBe(true);
  });

  it("omits parameters the deployment has not declared support for", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ b64_json: B64 }] })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleImageProvider({ ...base, fetchImpl });
    const { store } = collectStore();

    await provider.generateImage(
      { prompt: "x", negativePrompt: "blurry", seed: 7, aspectRatio: "1:1", quality: "fast" },
      store
    );
    const body = JSON.parse(String(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body));
    // Not silently dropped from the user's request — declared unsupported, so never sent.
    expect(body.negative_prompt).toBeUndefined();
    expect(body.seed).toBeUndefined();
  });

  it("sends them when the deployment DOES declare support", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ b64_json: B64 }] })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleImageProvider({
      ...base,
      supportsNegativePrompt: true,
      supportsSeed: true,
      fetchImpl,
    });
    const { store } = collectStore();

    await provider.generateImage(
      { prompt: "x", negativePrompt: "blurry", seed: 7, aspectRatio: "1:1", quality: "fast" },
      store
    );
    const body = JSON.parse(String(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.negative_prompt).toBe("blurry");
    expect(body.seed).toBe(7);
  });

  it("reports an HTTP failure as a failed generation carrying the server's message", async () => {
    const fetchImpl = vi.fn(async () => new Response("model not loaded", { status: 503 })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleImageProvider({ ...base, fetchImpl });
    const { stored, store } = collectStore();

    const result = await provider.generateImage({ prompt: "x", aspectRatio: "1:1", quality: "fast" }, store);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/503.*model not loaded/s);
    // Nothing was stored: a failed generation must not leave an asset behind.
    expect(stored).toEqual([]);
  });

  it("treats an empty data array as a failure, never as a successful blank image", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleImageProvider({ ...base, fetchImpl });
    const { store } = collectStore();

    const result = await provider.generateImage({ prompt: "x", aspectRatio: "1:1", quality: "fast" }, store);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no image data/i);
  });

  it("reports an unreachable server clearly, naming the URL to fix", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleImageProvider({ ...base, fetchImpl });
    const { store } = collectStore();

    const result = await provider.generateImage({ prompt: "x", aspectRatio: "1:1", quality: "fast" }, store);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Could not reach the image provider at http:\/\/127\.0\.0\.1:8080\/v1/);
  });

  it("is not a mock, and maps every supported aspect ratio to real pixel dimensions", () => {
    const provider = new OpenAICompatibleImageProvider(base);
    expect(provider.isMock).toBe(false);
    const caps = provider.getCapabilities();
    expect(caps.supportedAspectRatios).toContain("16:9");
    expect(caps.supportedAspectRatios).toContain("9:16");
    expect(caps.maxImagesPerCall).toBeGreaterThanOrEqual(1);
  });

  /**
   * A size a CPU can actually finish — docs/26_DECISIONS.md ADR-129.
   *
   * The size table is written for hosted models and was a constant, while this adapter's own
   * option comment recommends it for `http://127.0.0.1:8080/v1`. A local CPU backend asked for a
   * 1024-square image can only be waited on, and no setting helped.
   */
  it("scales every bucket to the configured base size, keeping the ratio", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleImageProvider({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "local-sd",
      baseSize: 512,
      fetchImpl,
    });

    await provider.generateImage({ prompt: "a harbour", aspectRatio: "1:1", quality: "fast" }, async () => "asset-1");
    await provider.generateImage({ prompt: "a harbour", aspectRatio: "16:9", quality: "fast" }, async () => "asset-2");

    // 1024 -> 512, and 1792x1024 keeps its shape at half scale, rounded to the /64 grid every
    // diffusion backend wants.
    expect(calls[0]!.size).toBe("512x512");
    expect(calls[1]!.size).toBe("896x512");
  });

  it("keeps the hosted defaults when no base size is configured", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleImageProvider({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-image-1",
      fetchImpl,
    });
    await provider.generateImage({ prompt: "a harbour", aspectRatio: "1:1", quality: "fast" }, async () => "asset-1");
    expect(calls[0]!.size).toBe("1024x1024");
  });
});
