import { describe, expect, it } from "vitest";
import { decodeGif, encodeGif, type GifFrame, type RgbColor } from "./gif-encoder.js";

/**
 * Real round-trip verification: encode with our hand-rolled encoder, decode with a real,
 * general-purpose GIF LZW decoder (not one hard-coded to this encoder's trivial output),
 * and assert every pixel of every frame matches exactly. This is the automated proof that
 * the bytes MockVideoProvider hands back are a genuinely valid GIF, not just
 * "looks plausible."
 */
describe("GIF encoder/decoder round-trip", () => {
  const palette: RgbColor[] = [
    { r: 10, g: 20, b: 30 },
    { r: 200, g: 100, b: 50 },
    { r: 255, g: 255, b: 255 },
    { r: 0, g: 0, b: 0 },
  ];

  function makeFrame(width: number, height: number, fn: (x: number, y: number) => number): GifFrame {
    const indices = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) indices[y * width + x] = fn(x, y);
    }
    return { indices };
  }

  it("round-trips header fields, frame count, and every pixel for a multi-frame animation", () => {
    const width = 20;
    const height = 12;
    const frames: GifFrame[] = [
      makeFrame(width, height, (x, y) => (x + y) % palette.length),
      makeFrame(width, height, (x) => x % palette.length),
      makeFrame(width, height, () => 2),
    ];

    const gif = encodeGif({ width, height, palette, frames, delayCentiseconds: 8, loopCount: 0 });

    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif[gif.length - 1]).toBe(0x3b); // trailer

    const decoded = decodeGif(gif);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.frames).toHaveLength(3);
    expect(decoded.delayCentiseconds).toEqual([8, 8, 8]);

    for (let i = 0; i < frames.length; i++) {
      expect(Array.from(decoded.frames[i])).toEqual(Array.from(frames[i].indices));
    }
  });

  it("round-trips a larger palette requiring a wider LZW code size", () => {
    const width = 16;
    const height = 16;
    const bigPalette: RgbColor[] = Array.from({ length: 200 }, (_, i) => ({
      r: i % 256,
      g: (i * 3) % 256,
      b: (i * 7) % 256,
    }));
    const frame = makeFrame(width, height, (x, y) => (x * 13 + y * 7) % bigPalette.length);

    const gif = encodeGif({ width, height, palette: bigPalette, frames: [frame], delayCentiseconds: 10 });
    const decoded = decodeGif(gif);

    expect(decoded.palette).toHaveLength(256); // GCT rounds up to the next power of two
    expect(Array.from(decoded.frames[0])).toEqual(Array.from(frame.indices));
  });

  it("rejects an out-of-range palette size", () => {
    expect(() =>
      encodeGif({ width: 4, height: 4, palette: [{ r: 0, g: 0, b: 0 }], frames: [], delayCentiseconds: 5 })
    ).toThrow(/palette must have 2-256 colors/);
  });

  it("rejects a frame whose pixel count doesn't match width*height", () => {
    expect(() =>
      encodeGif({
        width: 4,
        height: 4,
        palette,
        frames: [{ indices: new Uint8Array(4) }],
        delayCentiseconds: 5,
      })
    ).toThrow(/expected 16/);
  });
});
