import type { VideoGenerationRequest, VideoProvider, VideoProviderCapabilities, VideoResult } from "@ai-platform/shared";
import { encodeGif, type GifFrame, type RgbColor } from "./gif-encoder.js";

const WIDTH = 160;
const HEIGHT = 90;
const FPS = 6;
const MAX_DURATION_SECONDS = 8; // docs/06: real per-call ceilings range 5-25s; mid-range is representative

/**
 * Real, deterministic mock "video" generation (docs/26_DECISIONS.md ADR-030), mirroring
 * image-mock's honesty pattern (ADR-009/ADR-028): produces an actual valid, playable
 * animated GIF — not a fake blob with a `.mp4` extension — because there is no practical
 * way to hand-encode a real MP4/WebM bitstream without a real video encoder. The clip
 * visibly animates (a marker sweeps left-to-right, a progress bar fills) so it's obviously
 * a real per-frame render, not a static image mislabeled as a clip. See gif-encoder.ts for
 * why GIF specifically, and docs/26_DECISIONS.md ADR-030 for the full reasoning, including
 * why prompt text is not rendered into the pixels (no bundled bitmap font).
 */
export class MockVideoProvider implements VideoProvider {
  readonly name = "mock";
  readonly isMock = true;

  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "MockVideoProvider cannot be instantiated when NODE_ENV=production (docs/26_DECISIONS.md ADR-013)."
      );
    }
  }

  getCapabilities(): VideoProviderCapabilities {
    return { maxDurationSeconds: MAX_DURATION_SECONDS, supportsSeed: true, hasFastTier: true };
  }

  async generateVideo(
    req: VideoGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>
  ): Promise<VideoResult> {
    if (req.durationSeconds > MAX_DURATION_SECONDS) {
      return {
        status: "failed",
        error: `Requested duration ${req.durationSeconds}s exceeds this provider's ${MAX_DURATION_SECONDS}s per-call ceiling (docs/06).`,
        providerName: this.name,
      };
    }

    // Real, non-zero latency (docs/07 §1.6 "mock-provider parity") — video generation is
    // slower than image generation across every real provider surveyed, so the mock's
    // simulated latency scales with requested duration rather than being a flat constant.
    await sleep(400 + req.durationSeconds * 150 + Math.random() * 300);

    const seed = req.seed ?? hashToSeed(`${req.prompt}::${req.sceneIndex}`);
    const frameCount = Math.max(1, Math.round(req.durationSeconds * FPS));
    const { palette, frames } = renderClip({ seed, frameCount, sceneIndex: req.sceneIndex });

    const gif = encodeGif({
      width: WIDTH,
      height: HEIGHT,
      palette,
      frames,
      delayCentiseconds: Math.round(100 / FPS),
      loopCount: 0,
    });

    const assetId = await store(gif, "image/gif", "gif");

    return {
      status: "succeeded",
      video: { assetId, width: WIDTH, height: HEIGHT, durationSeconds: frameCount / FPS, seed },
      providerName: this.name,
      providerMeta: { mock: true, frameCount, format: "gif" },
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

function hslToRgb(h: number, s: number, l: number): RgbColor {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

const PALETTE_INDEX = {
  bgA: 0,
  bgB: 1,
  marker: 2,
  progressFilled: 3,
  progressEmpty: 4,
  border: 5,
} as const;

function renderClip(opts: {
  seed: number;
  frameCount: number;
  sceneIndex: number;
}): { palette: RgbColor[]; frames: GifFrame[] } {
  const hue = opts.seed % 360;
  const palette: RgbColor[] = [
    hslToRgb(hue, 0.5, 0.28), // bgA
    hslToRgb((hue + 30) % 360, 0.5, 0.4), // bgB
    hslToRgb((hue + 180) % 360, 0.85, 0.55), // marker (complementary, high contrast)
    { r: 255, g: 255, b: 255 }, // progress filled
    { r: 60, g: 60, b: 60 }, // progress empty
    { r: 0, g: 0, b: 0 }, // border
  ];

  const frames: GifFrame[] = [];
  const markerSize = 12;
  const progressBarTop = HEIGHT - 8;
  const progressBarBottom = HEIGHT - 3;

  for (let f = 0; f < opts.frameCount; f++) {
    const t = opts.frameCount === 1 ? 0 : f / (opts.frameCount - 1);
    const indices = new Uint8Array(WIDTH * HEIGHT);
    const markerX = Math.round(t * (WIDTH - markerSize));
    const markerY = Math.round(HEIGHT / 2 - markerSize / 2) + Math.round(4 * Math.sin(t * Math.PI * 2 + opts.sceneIndex));
    const progressFillWidth = Math.round(t * (WIDTH - 4));

    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        let index: number;
        if (x < 2 || x >= WIDTH - 2 || y < 2 || y >= HEIGHT - 2) {
          index = PALETTE_INDEX.border;
        } else if (y >= progressBarTop && y <= progressBarBottom) {
          index = x - 2 <= progressFillWidth ? PALETTE_INDEX.progressFilled : PALETTE_INDEX.progressEmpty;
        } else if (x >= markerX && x < markerX + markerSize && y >= markerY && y < markerY + markerSize) {
          index = PALETTE_INDEX.marker;
        } else {
          index = (x + y) % 17 < 9 ? PALETTE_INDEX.bgA : PALETTE_INDEX.bgB;
        }
        indices[y * WIDTH + x] = index;
      }
    }
    frames.push({ indices });
  }

  return { palette, frames };
}
