import type {
  AspectRatio,
  ImageGenerationRequest,
  ImageProvider,
  ImageProviderCapabilities,
  ImageResult,
} from "@ai-platform/shared";

const ASPECT_RATIO_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "3:2": { width: 1024, height: 683 },
  "2:3": { width: 683, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
};

/**
 * Real, deterministic mock image "generation" — docs/26_DECISIONS.md ADR-009: honestly
 * labeled as mock, never disguised as real. Produces an actual valid SVG image (real
 * bytes, renders in any browser/image viewer), not a fake placeholder blob — the file is
 * real; only the "AI-generated" content is a deterministic stand-in. Background color is
 * hashed from the prompt so different prompts are visually distinguishable, which is
 * enough to exercise and demo the whole pipeline (job submission, storage, retrieval)
 * honestly. A real provider adapter (docs/05_IMAGE_GENERATION_RESEARCH.md) is a drop-in
 * later — this interface is designed against that research, not guessed.
 */
export class MockImageProvider implements ImageProvider {
  readonly name = "mock";
  readonly isMock = true;

  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "MockImageProvider cannot be instantiated when NODE_ENV=production (docs/26_DECISIONS.md ADR-013)."
      );
    }
  }

  getCapabilities(): ImageProviderCapabilities {
    return {
      supportsNegativePrompt: true,
      supportsSeed: true,
      maxImagesPerCall: 1,
      supportedAspectRatios: Object.keys(ASPECT_RATIO_DIMENSIONS) as AspectRatio[],
      hasFastTier: true,
    };
  }

  async generateImage(
    req: ImageGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>
  ): Promise<ImageResult> {
    // Simulate real, non-zero latency (docs/05 §1: even "fast" tiers take seconds) so the
    // async job pipeline this always runs through (docs/07 §1.6) is genuinely exercised,
    // not short-circuited by an instant resolve.
    await sleep(300 + Math.random() * 400);

    const { width, height } = ASPECT_RATIO_DIMENSIONS[req.aspectRatio];
    const seed = req.seed ?? hashToSeed(req.prompt);
    const svg = renderPlaceholderSvg({ prompt: req.prompt, negativePrompt: req.negativePrompt, width, height, seed });
    const assetId = await store(Buffer.from(svg, "utf8"), "image/svg+xml", "svg");

    return {
      status: "succeeded",
      images: [{ assetId, width, height, seed }],
      providerName: this.name,
      providerMeta: { mock: true, quality: req.quality },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashToSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function renderPlaceholderSvg(opts: {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  seed: number;
}): string {
  const hue = opts.seed % 360;
  const bg = `hsl(${hue}, 55%, 30%)`;
  const bg2 = `hsl(${(hue + 40) % 360}, 55%, 45%)`;
  const escapedPrompt = escapeXml(truncate(opts.prompt, 220));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}" viewBox="0 0 ${opts.width} ${opts.height}">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bg}" />
      <stop offset="100%" stop-color="${bg2}" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)" />
  <rect x="0" y="0" width="100%" height="64" fill="rgba(0,0,0,0.55)" />
  <text x="20" y="40" font-family="monospace" font-size="24" fill="#ffffff" font-weight="bold">MOCK IMAGE — not a real generation</text>
  <foreignObject x="20" y="90" width="${opts.width - 40}" height="${opts.height - 160}">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: sans-serif; color: #ffffff; font-size: 22px; line-height: 1.4; text-shadow: 0 1px 3px rgba(0,0,0,0.6);">
      ${escapedPrompt}
    </div>
  </foreignObject>
  <text x="20" y="${opts.height - 20}" font-family="monospace" font-size="14" fill="rgba(255,255,255,0.8)">seed=${opts.seed} · ${opts.width}x${opts.height}</text>
</svg>`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
