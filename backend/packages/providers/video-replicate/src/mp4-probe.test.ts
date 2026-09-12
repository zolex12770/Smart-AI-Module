import { describe, expect, it } from "vitest";
import { buildMp4 } from "./mp4-fixtures.js";
import { probeMp4 } from "./mp4-probe.js";

/**
 * The probe is what stops `GeneratedVideo.width`/`height`/`durationSeconds` from being three
 * numbers nobody measured, so these run it against real container bytes (see mp4-fixtures.ts)
 * and, just as importantly, against bytes it must REFUSE to read. A probe that returns
 * plausible numbers for a file it did not understand is worse than one that returns nothing.
 */
describe("probeMp4", () => {
  it("reads the real display size and duration out of a version 0 header", () => {
    const mp4 = buildMp4({ tracks: [{ width: 1280, height: 720 }], durationSeconds: 4, timescale: 600 });

    expect(probeMp4(mp4)).toEqual({ width: 1280, height: 720, durationSeconds: 4 });
  });

  it("reads a version 1 header, where the 64-bit time fields shift every offset after them", () => {
    const mp4 = buildMp4({ tracks: [{ width: 848, height: 480 }], durationSeconds: 2.5, timescale: 1000, version: 1 });

    expect(probeMp4(mp4)).toEqual({ width: 848, height: 480, durationSeconds: 2.5 });
  });

  it("skips a soundtrack: the first track with a picture is the one that has the dimensions", () => {
    // An audio track declares 0x0 in its tkhd. Taking "the first trak" blindly would report a
    // video as having no size at all, which is the shape of a real muxing order.
    const mp4 = buildMp4({
      tracks: [
        { width: 0, height: 0 },
        { width: 1920, height: 1080 },
      ],
      durationSeconds: 8,
    });

    expect(probeMp4(mp4)).toMatchObject({ width: 1920, height: 1080 });
  });

  it("reports the duration as unknown rather than as 194 days when the header says it is unknown", () => {
    const v0 = buildMp4({ tracks: [{ width: 640, height: 360 }] });
    const v1 = buildMp4({ tracks: [{ width: 640, height: 360 }], version: 1 });

    // Dimensions are still real; only the duration is missing, and only the duration is dropped.
    expect(probeMp4(v0)).toEqual({ width: 640, height: 360, durationSeconds: null });
    expect(probeMp4(v1)).toEqual({ width: 640, height: 360, durationSeconds: null });
  });

  it("returns null for bytes that are not an MP4 at all", () => {
    expect(probeMp4(Buffer.from("this is not a video, it is a sentence"))).toBeNull();
    expect(probeMp4(Buffer.alloc(0))).toBeNull();
    // A WebM's leading EBML bytes: a real container, but not one this probe claims to read.
    expect(probeMp4(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]))).toBeNull();
  });

  it("refuses a truncated download instead of reading past the end of the buffer", () => {
    const mp4 = buildMp4({ tracks: [{ width: 1280, height: 720 }], durationSeconds: 4 });
    // Cut inside `moov`: the box header still declares its full length, which no longer exists.
    const truncated = mp4.subarray(0, mp4.length - 100);

    expect(probeMp4(truncated)).toBeNull();
  });

  it("does not resynchronise past a box whose declared size is impossible", () => {
    const mp4 = buildMp4({ tracks: [{ width: 1280, height: 720 }], durationSeconds: 4 });
    const corrupted = Buffer.from(mp4);
    corrupted.writeUInt32BE(0x7fff_ffff, 0); // the leading `ftyp` now claims 2 GiB

    expect(probeMp4(corrupted)).toBeNull();
  });
});
