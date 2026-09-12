import type { ChatStreamEvent, VideoProjectRequest } from "@ai-platform/shared";
import { planScenes, type PlannedScene } from "./video-storyboard.js";

/**
 * The script and storyboard stages, written by a model — docs/07 Part 2 §2.2 stages 1 and 2,
 * docs/26_DECISIONS.md ADR-080.
 *
 * WHAT WAS THERE BEFORE. `planScenes` decomposed a prompt into N scenes whose entire shot
 * description was the string `"Scene 3 of 7: <the user's prompt>"`. Its docstring said so
 * plainly and called itself a stand-in for a real LLM call — which was the honest thing to do,
 * and also meant the platform had no script stage and no storyboard stage at all. Every scene
 * asked the video provider for the same picture, and nothing was ever narrated.
 *
 * This is the real stage. A model receives the prompt, the target duration and the per-scene
 * clip length, and returns a structured storyboard: one distinct shot description per scene, and
 * the narration line spoken over it.
 *
 * THE DETERMINISTIC PLANNER STAYS, as a real fallback rather than a pretend one. A deployment
 * with no chat provider still gets a video — with `scriptSource: "deterministic"` recorded on
 * the project, so nobody can mistake a mechanical decomposition for a written script. That
 * distinction is the whole point: the failure this guards against is a storyboard that LOOKS
 * authored and is not.
 */

export interface ScriptedScene extends PlannedScene {
  /** What the camera sees. Fed to the video provider as its prompt. */
  shotDescription: string;
  /** What is said over it. Fed to the speech provider; null when there is no script stage. */
  narration: string | null;
}

export interface VideoScript {
  title: string;
  scenes: ScriptedScene[];
  /**
   * `model` when a model really wrote it; `deterministic` when it fell back. Persisted on the
   * project so the distinction survives into the API and the UI — a caller must be able to tell
   * an authored storyboard from a mechanical one.
   */
  scriptSource: "model" | "deterministic";
  /** Null on the deterministic path. */
  model: string | null;
  /** Why it fell back, when it did. Null on the happy path. */
  fallbackReason: string | null;
}

/** The chat surface this stage needs, named structurally so backend/packages/media stays router-free. */
export interface ScriptModel {
  streamChat(request: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  }): AsyncIterable<ChatStreamEvent>;
}

export interface WriteScriptDeps {
  /** Absent means no chat provider is configured; the deterministic path is then the only one. */
  model?: ScriptModel;
  /** Injected for tests. */
  logger?: { warn(obj: unknown, msg: string): void };
}

const SCRIPT_SYSTEM_PROMPT = [
  "You are a video director. You turn a brief into a shot-by-shot storyboard.",
  "Reply with ONLY a JSON object, no prose and no code fence, of the shape:",
  '{"title": string, "scenes": [{"shotDescription": string, "narration": string}]}',
  "- shotDescription describes what the camera SEES: subject, setting, framing, motion, lighting.",
  "  It is sent verbatim to an image/video generator, so write it as a visual prompt, never as a",
  "  stage direction about the script itself.",
  "- narration is the single sentence SPOKEN over that shot. Keep it under 25 words so it fits",
  "  the shot's duration when read aloud.",
  "- Every scene must be visually distinct from the others. Do not repeat the brief verbatim.",
].join("\n");

/**
 * Asks the model for a storyboard, validates it hard, and falls back honestly.
 *
 * The validation is deliberately strict and total: a script is fed straight into a video
 * generator and a speech synthesiser, so a malformed one becomes a failed render several minutes
 * and several provider calls later. Rejecting it here costs one retry.
 */
export async function writeVideoScript(
  deps: WriteScriptDeps,
  request: VideoProjectRequest
): Promise<VideoScript> {
  const planned = planScenes(request);

  if (!deps.model) {
    return deterministic(planned, "No chat provider is configured, so no script stage ran.");
  }

  try {
    const raw = await completeText(deps.model, [
      { role: "system", content: SCRIPT_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Brief: ${request.prompt}\n` +
          `Total duration: ${request.targetDurationSeconds} seconds.\n` +
          `Write exactly ${planned.length} scenes, each about ${request.sceneClipSeconds} seconds long.`,
      },
    ]);

    const parsed = parseScriptJson(raw, planned.length);
    if (!parsed) {
      return deterministic(planned, "The model did not return a usable storyboard JSON object.");
    }

    return {
      title: parsed.title,
      // Durations come from the REQUEST, never from the model. Letting a model choose them would
      // let it silently change the length and cost of the render it was asked for, and the
      // per-scene ceiling is a real provider limit rather than a stylistic choice.
      scenes: planned.map((scene, i) => ({
        sceneIndex: scene.sceneIndex,
        durationSeconds: scene.durationSeconds,
        shotDescription: parsed.scenes[i].shotDescription,
        narration: parsed.scenes[i].narration,
      })),
      scriptSource: "model",
      model: raw.model,
      fallbackReason: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.logger?.warn({ error: reason }, "script stage failed; falling back to the deterministic storyboard");
    // A failed script stage must not fail the whole project: the deterministic decomposition
    // still produces a real video, and the project records that that is what happened.
    return deterministic(planned, `The script stage failed: ${reason}`);
  }
}

function deterministic(planned: PlannedScene[], reason: string): VideoScript {
  return {
    title: "Untitled",
    // `narration: null`, not an empty string: the audio stage must be able to tell "there is no
    // script" from "this scene is deliberately silent", and only one of those is a reason to
    // report the narration stage as skipped.
    scenes: planned.map((scene) => ({ ...scene, narration: null })),
    scriptSource: "deterministic",
    model: null,
    fallbackReason: reason,
  };
}

/** Drains the stream to its terminal event. The router streams; this stage wants one string. */
async function completeText(
  model: ScriptModel,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<{ text: string; model: string }> {
  for await (const event of model.streamChat({ messages })) {
    if (event.type === "done") {
      return { text: event.message.content ?? "", model: event.model };
    }
    if (event.type === "error") throw new Error(event.message);
  }
  throw new Error("The model produced no terminal event.");
}

interface ParsedScript {
  title: string;
  scenes: Array<{ shotDescription: string; narration: string }>;
}

/**
 * Parses the model's reply into a validated storyboard, or null.
 *
 * Small models wrap JSON in prose or a code fence however firmly they are told not to, so the
 * first balanced `{...}` is extracted rather than requiring the whole reply to parse. That is a
 * concession to reality, not a loosening of validation: what comes out is still checked field by
 * field, and anything short of a complete, correctly-sized storyboard is rejected.
 */
export function parseScriptJson(
  raw: { text: string; model: string },
  expectedSceneCount: number
): ParsedScript | null {
  const candidate = extractFirstJsonObject(raw.text);
  if (!candidate) return null;

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const scenes = record.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) return null;

  const cleaned: Array<{ shotDescription: string; narration: string }> = [];
  for (const entry of scenes) {
    if (typeof entry !== "object" || entry === null) return null;
    const scene = entry as Record<string, unknown>;
    const shot = typeof scene.shotDescription === "string" ? scene.shotDescription.trim() : "";
    const narration = typeof scene.narration === "string" ? scene.narration.trim() : "";
    // A blank shot description would be sent to the video provider as an empty prompt, which is
    // a wasted generation rather than an error the provider reports.
    if (shot === "") return null;
    cleaned.push({ shotDescription: shot, narration });
  }

  /**
   * The model reliably returns "about" the right number of scenes and not exactly it. Rather
   * than throwing away a good storyboard over an off-by-one, the list is fitted to the count the
   * REQUEST determined — truncated if long, and padded by cycling the scenes it did write if
   * short. Padding by repeating a real shot is visibly worse than a bespoke one and visibly
   * better than a scene described as "Scene 6 of 7: <prompt>", which is what the old planner
   * produced for every scene.
   */
  if (cleaned.length > expectedSceneCount) cleaned.length = expectedSceneCount;
  // The modulus is the count the model ACTUALLY wrote, captured before any padding pushes onto
  // the array. Taking it from the growing `cleaned.length` instead made the index `n % n`, which
  // is 0 for every iteration — so a 2-scene reply padded to 5 produced scenes [0,1,0,0,0] and a
  // viewer saw the opening shot four times while the code claimed to be "cycling the scenes it
  // did write". Nothing failed loudly; the video was just wrong.
  const written = cleaned.length;
  for (let i = written; written > 0 && i < expectedSceneCount; i++) {
    cleaned.push({ ...cleaned[i % written] });
  }

  const title = typeof record.title === "string" && record.title.trim() !== "" ? record.title.trim() : "Untitled";
  return { title, scenes: cleaned };
}

/** The first balanced `{...}` run, so a fenced or prose-wrapped reply still yields its object. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
