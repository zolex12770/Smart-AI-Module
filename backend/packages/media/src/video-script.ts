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

/**
 * How long the storyboard stage may take, unless the operator says otherwise
 * (VIDEO_SCRIPT_TIMEOUT_MS).
 *
 * It was 25 seconds while the stage ran inside `POST /api/v1/videos`: a person pressing a button
 * should not conclude the page is broken. The stage now runs in the `video.plan` job, so that
 * argument is gone, and 25 s was measured failing on the reference local runtime (qwen2.5:7b on
 * four CPU cores) in the autonomous-completion pass. Three minutes is generous for a handful of
 * shots on that runtime, and still bounded.
 */
export const DEFAULT_VIDEO_SCRIPT_TIMEOUT_MS = 180_000;

export interface ScriptedScene extends PlannedScene {
  /** What the camera sees. Fed to the video provider as its prompt. */
  shotDescription: string;
  /** What is said over it. Fed to the speech provider; null when there is no script stage. */
  narration: string | null;
}

/** What the storyboard call cost, for the caller's ledger — ADR-150. */
export interface ScriptUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface VideoScript {
  title: string;
  scenes: ScriptedScene[];
  /** The provider that wrote it, and what it cost. Null on the deterministic path. */
  provider?: string | null;
  usage?: ScriptUsage | null;
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
  /**
   * How many shots the model actually described, before any padding — ADR-137.
   *
   * Equal to `scenes.length` when the reply was complete. Lower when the model wrote fewer shots
   * than the requested duration needs and the remainder was filled by cycling the ones it did
   * write. On the deterministic path it is 0: nothing was authored at all.
   */
  scenesWritten: number;
}

/** The chat surface this stage needs, named structurally so backend/packages/media stays router-free. */
export interface ScriptModel {
  streamChat(
    request: {
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      /** Grammar-constrained JSON where the provider has it — see `ChatRequest.responseFormat`. */
      responseFormat?: "json_object";
    },
    /**
     * Cancellation, because this call happens inside an HTTP request — ADR-137.
     *
     * The interface declared no way to stop the call, so the storyboard stage had no deadline of
     * any kind: `POST /api/v1/videos` was measured at 74.6 seconds for a five-scene brief on a
     * local model, and there was no upper bound at all — a wedged provider held the request open
     * until something else gave up. The router has always taken a signal; this is the shape that
     * lets it reach one.
     */
    options?: { signal?: AbortSignal }
  ): AsyncIterable<ChatStreamEvent>;
}

export interface WriteScriptDeps {
  /** Absent means no chat provider is configured; the deterministic path is then the only one. */
  model?: ScriptModel;
  /**
   * Wall-clock ceiling for the storyboard call (ADR-137). On expiry the deterministic planner
   * produces the scenes and the project records that it did — a slow model costs the user a
   * mechanical storyboard, never a request that never returns.
   */
  timeoutMs?: number;
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

  const timeoutMs = deps.timeoutMs ?? DEFAULT_VIDEO_SCRIPT_TIMEOUT_MS;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: SCRIPT_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Brief: ${request.prompt}\n` +
          `Total duration: ${request.targetDurationSeconds} seconds.\n` +
          `Write exactly ${planned.length} scenes, each about ${request.sceneClipSeconds} seconds long.`,
      },
    ];
    let raw = await completeText(deps.model, messages, controller.signal);
    let parsed = parseScriptJson(raw, planned.length);
    /**
     * One corrective round — measured, not assumed. A real qwen2.5:7b storyboard for "how bees
     * make honey" came back well-formed in a direct call and unusable through the job (its reply
     * began `{ "title": "Bees Making Honey Explainer", "scenes": [ ...`), and the video then
     * rendered with no narration, no audio and no subtitles. JSON mode removes most syntax
     * failures where the provider has it; this covers the rest, and providers without it, at the
     * cost of one more call inside the same deadline. Both calls are metered.
     */
    let usage = raw.usage;
    if (!parsed && raw.finishReason !== "length") {
      deps.logger?.warn({ error: describeUnusableReply(raw) }, "script stage reply unusable; asking the model once more");
      let retry: Awaited<ReturnType<typeof completeText>>;
      try {
        retry = await completeText(
          deps.model,
          [
            ...messages,
            { role: "assistant", content: raw.text },
            {
              role: "user",
              content:
                "That reply could not be parsed as the JSON object described (check quotes inside strings are escaped, " +
                "and that the object is complete). Reply again with ONLY the corrected JSON object.",
            },
          ],
          controller.signal
        );
      } catch (error) {
        // The first call completed and was paid for, so a failed retry still carries its cost out
        // — the catch below would report the stage as free.
        const why = controller.signal.aborted
          ? `the retry exceeded the ${Math.round(timeoutMs / 1000)}s deadline`
          : error instanceof Error ? error.message : String(error);
        const reason = `${describeUnusableReply(raw)} A corrective retry failed: ${why}.`;
        deps.logger?.warn({ error: reason }, "script stage failed; falling back to the deterministic storyboard");
        return { ...deterministic(planned, reason), provider: raw.provider, usage };
      }
      usage = { inputTokens: usage.inputTokens + retry.usage.inputTokens, outputTokens: usage.outputTokens + retry.usage.outputTokens };
      raw = retry;
      parsed = parseScriptJson(raw, planned.length);
    }
    if (!parsed) {
      const reason = describeUnusableReply(raw);
      // Logged as well as stored: the thrown-error path below always logged, and this one — the
      // likelier of the two on a small local model — left its only trace on the project row.
      deps.logger?.warn({ error: reason, finish_reason: raw.finishReason }, "script stage reply unusable; falling back to the deterministic storyboard");
      // The call happened and the tokens were spent, so the cost is carried out even though the
      // storyboard is the mechanical one (ADR-150). Reporting a fallback as free would understate
      // the bill in exactly the case a model is behaving badly and being retried.
      return {
        ...deterministic(planned, reason),
        provider: raw.provider,
        usage,
      };
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
      provider: raw.provider,
      usage,
      fallbackReason: null,
      scenesWritten: parsed.scenesWritten,
    };
  } catch (error) {
    const reason = controller.signal.aborted
      ? `The script stage exceeded its ${Math.round(timeoutMs / 1000)}s deadline.`
      : error instanceof Error
        ? error.message
        : String(error);
    deps.logger?.warn({ error: reason }, "script stage failed; falling back to the deterministic storyboard");
    // A failed script stage must not fail the whole project: the deterministic decomposition
    // still produces a real video, and the project records that that is what happened.
    return deterministic(planned, `The script stage failed: ${reason}`);
  } finally {
    clearTimeout(deadline);
  }
}

function deterministic(planned: PlannedScene[], reason: string): VideoScript {
  return {
    title: "Untitled",
    // No model call reached a terminal event on this path, so there is nothing to charge for.
    provider: null,
    usage: null,
    // `narration: null`, not an empty string: the audio stage must be able to tell "there is no
    // script" from "this scene is deliberately silent", and only one of those is a reason to
    // report the narration stage as skipped.
    scenes: planned.map((scene) => ({ ...scene, narration: null })),
    scriptSource: "deterministic",
    model: null,
    fallbackReason: reason,
    // Nothing was authored: every shot here is the mechanical decomposition.
    scenesWritten: 0,
  };
}

/** Drains the stream to its terminal event. The router streams; this stage wants one string. */
/**
 * Why an unusable reply was unusable — ADR-161.
 *
 * Every parse failure used to be reported as "The model did not return a usable storyboard JSON
 * object", which names the one cause an operator can do nothing about and hides the two they
 * can. The fifth audit's real run recorded exactly that sentence for two consecutive video
 * projects; asked the same prompt directly, the same qwen2.5:7b returned clean, parseable JSON
 * every time. The message sent the investigation at the model's formatting for twenty minutes
 * when the reply had in fact been cut short.
 *
 * So the three cases are separated, and the model's own words are carried out with them —
 * bounded, because this string is persisted on the project row and rendered in the UI.
 */
function describeUnusableReply(raw: { text: string; finishReason?: string }): string {
  const text = raw.text.trim();
  if (text === "") {
    return `The model returned an empty reply (finish reason: ${raw.finishReason ?? "unknown"}).`;
  }
  if (raw.finishReason === "length") {
    return (
      "The model's storyboard reply was cut off by the output-token limit before the JSON " +
      `object closed. It began: "${excerpt(text)}"`
    );
  }
  return `The model did not return a usable storyboard JSON object. It replied: "${excerpt(text)}"`;
}

/** First 200 characters, on one line — enough to recognise the shape, short enough to store. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

async function completeText(
  model: ScriptModel,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  signal?: AbortSignal
): Promise<{ text: string; model: string; provider: string; usage: ScriptUsage; finishReason?: string }> {
  for await (const event of model.streamChat({ messages, responseFormat: "json_object" }, { signal })) {
    if (event.type === "done") {
      // The provider and the token counts are carried out (ADR-150) so the caller can write the
      // usage row this call never had: the storyboard spends real LLM tokens on every video and
      // `grep -rn "usage|quota" backend/packages/media/src` returned two prose comments.
      return {
        text: event.message.content ?? "",
        model: event.model,
        provider: event.provider,
        usage: { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens },
        // The provider has always reported this and the stage has always thrown it away, which
        // is how a truncated reply came to be indistinguishable from a badly formatted one.
        ...(event.finishReason !== undefined ? { finishReason: String(event.finishReason) } : {}),
      };
    }
    if (event.type === "error") throw new Error(event.message);
  }
  throw new Error("The model produced no terminal event.");
}

interface ParsedScript {
  title: string;
  scenes: Array<{ shotDescription: string; narration: string }>;
  /** Shots the model really described, before padding cycled them to fill the duration. */
  scenesWritten: number;
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
  /**
   * `scenesWritten` leaves this function now — docs/26_DECISIONS.md ADR-137.
   *
   * The count was computed here, used for the modulus, and discarded, while the caller reported
   * `scriptSource: "model"` and "Written by <model>" unconditionally. So a reply that described
   * two shots for a five-scene video was presented as a five-shot authored storyboard, and the
   * three duplicates were indistinguishable from deliberate repetition. Padding by cycling real
   * shots is a reasonable thing to do; claiming a model wrote them is not.
   */
  return { title, scenes: cleaned, scenesWritten: written };
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
