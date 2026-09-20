import { describe, expect, it } from "vitest";
import { buildSubtitleCues, formatSrtTimestamp, formatVttTimestamp, renderSrt, renderVtt } from "./subtitles.js";

/**
 * The subtitle renderer had NO unit test — docs/26_DECISIONS.md ADR-098.
 *
 * It was covered only through the ffmpeg integration suites, whose fixtures use whole-second
 * durations, so the one input class that breaks it never appeared: a duration measured by
 * ffprobe, which routinely lands a few ten-thousandths under a whole second.
 *
 * The seconds field was floored while the milliseconds field was rounded independently, so any
 * fractional part >= 0.9995 rendered `,1000` — a four-digit millisecond field that is not a valid
 * cue timestamp. ffmpeg's `mov_text` muxer and most players stop at the malformed cue and take
 * the remainder of the track with them, which is a silently truncated subtitle track rather than
 * an error.
 */
describe("timestamp formatting", () => {
  it("never renders a four-digit millisecond field", () => {
    for (const t of [9.9996, 0.9999, 59.99999, 3599.9996, 1.4999, 61.9995, 0.99951]) {
      expect(formatSrtTimestamp(t)).toMatch(/^\d{2}:\d{2}:\d{2},\d{3}$/);
      expect(formatVttTimestamp(t)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    }
  });

  it("carries into the next second, minute and hour", () => {
    expect(formatSrtTimestamp(9.9996)).toBe("00:00:10,000");
    expect(formatSrtTimestamp(59.9999)).toBe("00:01:00,000");
    expect(formatSrtTimestamp(3599.9999)).toBe("01:00:00,000");
  });

  it("renders ordinary values exactly", () => {
    expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(1.5)).toBe("00:00:01,500");
    expect(formatSrtTimestamp(3661.25)).toBe("01:01:01,250");
    expect(formatVttTimestamp(3661.25)).toBe("01:01:01.250");
  });

  it("clamps a negative time rather than emitting a negative field", () => {
    expect(formatSrtTimestamp(-5)).toBe("00:00:00,000");
  });
});

describe("rendered cue files stay parseable at the boundary", () => {
  // The whole point of the carry: a real cue built from measured durations must still render a
  // file a muxer will accept end to end, not just a well-formed single timestamp.
  const scenes = [
    { sceneIndex: 0, narration: "First scene.", durationSeconds: 4.9999 },
    { sceneIndex: 1, narration: "Second scene.", durationSeconds: 5.0001 },
  ];

  it("SRT has a valid time line for every cue", () => {
    const srt = renderSrt(buildSubtitleCues(scenes));
    const timeLines = srt.split(/\r?\n/).filter((l) => l.includes("-->"));
    expect(timeLines).toHaveLength(2);
    for (const line of timeLines) {
      expect(line).toMatch(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
    }
  });

  it("VTT has a valid time line for every cue", () => {
    const vtt = renderVtt(buildSubtitleCues(scenes));
    const timeLines = vtt.split(/\r?\n/).filter((l) => l.includes("-->"));
    expect(timeLines).toHaveLength(2);
    for (const line of timeLines) {
      expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/);
    }
  });

  it("cues never overlap or run backwards", () => {
    const cues = buildSubtitleCues(scenes);
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i].endSeconds).toBeGreaterThan(cues[i].startSeconds);
      if (i > 0) expect(cues[i].startSeconds).toBeGreaterThanOrEqual(cues[i - 1].endSeconds);
    }
  });
});
