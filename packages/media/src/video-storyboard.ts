import type { VideoProjectRequest } from "@ai-platform/shared";

export interface PlannedScene {
  sceneIndex: number;
  shotDescription: string;
  durationSeconds: number;
}

/**
 * Deterministic, rule-based storyboard planner — the docs/07 §2.2 stage 1 (script) + stage
 * 2 (storyboard) pipeline collapsed into one step, standing in for a real LLM call the same
 * way the agent-core planner does (docs/26_DECISIONS.md ADR-018): honestly labeled as a
 * real constraint, not disguised as narrative reasoning. It deterministically decomposes a
 * prompt + target duration into `ceil(targetDurationSeconds / sceneClipSeconds)` scenes,
 * each no longer than `sceneClipSeconds` (the last scene absorbs the remainder) — the exact
 * mechanism docs/07 §2.2 stage 2 describes, just without an LLM writing the per-scene shot
 * descriptions. Swapping in a real LLM call later changes only this function's body; every
 * downstream stage (scene generation, resumability, assembly) reads `PlannedScene[]` and
 * doesn't know or care how it was produced.
 */
export function planScenes(request: VideoProjectRequest): PlannedScene[] {
  const sceneCount = Math.ceil(request.targetDurationSeconds / request.sceneClipSeconds);
  const scenes: PlannedScene[] = [];
  let remaining = request.targetDurationSeconds;

  for (let i = 0; i < sceneCount; i++) {
    const durationSeconds = Math.min(request.sceneClipSeconds, remaining);
    scenes.push({
      sceneIndex: i,
      shotDescription: `Scene ${i + 1} of ${sceneCount}: ${request.prompt}`,
      durationSeconds,
    });
    remaining -= durationSeconds;
  }

  return scenes;
}
