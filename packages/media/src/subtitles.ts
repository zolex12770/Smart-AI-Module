import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Subtitle generation for the long-form video pipeline — docs/07 Part 2 §2.2, ADR-081.
 *
 * WHY TIMINGS ARE MEASURED, NOT ESTIMATED. The obvious implementation guesses each cue's length
 * from a words-per-minute constant. That drifts: synthesised speech runs at a rate the voice and
 * the requested speed decide, sentences vary, and the error accumulates across a hundred scenes
 * until the subtitles are describing a different part of the video. Since the narration audio is
 * a real file this pipeline just produced, its exact duration can simply be read — so it is.
 *
 * `measureAudioDurationSeconds` is the only part that needs a binary. When narration was skipped
 * there is no audio to measure and cues fall back to the scene's planned duration, which is
 * exact for a silent scene because the scene IS that long.
 */

export interface SubtitleCue {
  /** 1-based, as both SRT and the human reading it expect. */
  index: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface SubtitleSceneInput {
  sceneIndex: number;
  /** Null for a scene with no narration; the cue is then omitted rather than left blank. */
  narration: string | null;
  /** The scene's clip length — the fallback when there is no measurable audio. */
  durationSeconds: number;
  /** Measured narration length, when the audio exists. */
  audioDurationSeconds?: number | null;
}

/**
 * Lays the scenes end to end and gives each its own cue.
 *
 * A scene's slot is the longer of its clip and its narration: if the narration runs past the
 * clip, the render stage extends the clip to cover it (see `video-render.ts`), so the subtitle
 * has to agree with what will actually be composed or every later cue is wrong.
 */
export function buildSubtitleCues(scenes: readonly SubtitleSceneInput[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let cursor = 0;
  let index = 1;

  for (const scene of [...scenes].sort((a, b) => a.sceneIndex - b.sceneIndex)) {
    const audio = scene.audioDurationSeconds ?? 0;
    const slot = Math.max(scene.durationSeconds, audio);
    const text = (scene.narration ?? "").trim();
    if (text !== "") {
      cues.push({
        index: index++,
        startSeconds: cursor,
        // The cue ends when the SPEECH ends, not when the shot does — a caption left on screen
        // through several seconds of silence reads as a stuck player.
        endSeconds: cursor + (audio > 0 ? audio : slot),
        text,
      });
    }
    cursor += slot;
  }

  return cues;
}

/** `HH:MM:SS,mmm` — SRT's format, comma before the milliseconds. */
export function formatSrtTimestamp(totalSeconds: number): string {
  return formatTimestamp(totalSeconds, ",");
}

/** `HH:MM:SS.mmm` — WebVTT's format, which differs from SRT only in that separator. */
export function formatVttTimestamp(totalSeconds: number): string {
  return formatTimestamp(totalSeconds, ".");
}

function formatTimestamp(totalSeconds: number, msSeparator: string): string {
  const clamped = Math.max(0, totalSeconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${msSeparator}${pad(millis, 3)}`;
}

/**
 * SRT. Chosen as the stored format because ffmpeg's `mov_text` encoder reads it directly, so the
 * same file both ships as a sidecar and muxes into the MP4 as a real subtitle track.
 */
export function renderSrt(cues: readonly SubtitleCue[]): string {
  return (
    cues
      .map(
        (cue) =>
          `${cue.index}\n${formatSrtTimestamp(cue.startSeconds)} --> ${formatSrtTimestamp(cue.endSeconds)}\n${escapeCueText(cue.text)}`
      )
      // SRT blocks are separated by a blank line and the file ends with a newline; players
      // differ on how forgiving they are about a missing trailing one.
      .join("\n\n") + (cues.length > 0 ? "\n" : "")
  );
}

/** WebVTT, for a browser `<track>` element — the web player's format, unlike SRT. */
export function renderVtt(cues: readonly SubtitleCue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${cue.index}\n${formatVttTimestamp(cue.startSeconds)} --> ${formatVttTimestamp(cue.endSeconds)}\n${escapeCueText(cue.text)}`
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}${cues.length > 0 ? "\n" : ""}`;
}

/**
 * Narration is model-written text going into a file a browser will parse.
 *
 * A blank line inside a cue would terminate the block early and desynchronise every cue after
 * it, and a literal `-->` would be read as a timing line. Both are collapsed rather than
 * escaped, because neither has any legitimate place in a spoken sentence.
 */
function escapeCueText(text: string): string {
  return text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/-->/g, "→")
    .trim();
}

/**
 * The real duration of an audio or video file, via ffprobe.
 *
 * Returns null rather than throwing when it cannot be determined: a missing duration degrades
 * subtitle timing to the planned-duration fallback, which is a worse subtitle track and not a
 * failed render. Failing the whole job because one probe did not answer would be the wrong trade.
 */
export async function measureAudioDurationSeconds(ffprobePath: string, filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { timeout: 30_000 }
    );
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * `ffprobe` beside a known `ffmpeg`.
 *
 * The two ship together in every distribution, so deriving one from the other means an operator
 * configures a single path (`FFMPEG_PATH`) rather than two that could disagree — a mismatched
 * pair is a confusing failure, since one works and the other does not.
 */
export function ffprobePathFor(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (match) => (match.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"));
}
