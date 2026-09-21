import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBED_TIMEOUT_MS } from "@ai-platform/llm-local";
import { DEFAULT_RENDER_BUDGET_MS } from "@ai-platform/media";

/**
 * Every claim window is above the deadline of the work it bounds — ADR-128, ADR-150, ADR-159.
 *
 * pg-boss re-claims a job whose `expireInSeconds` elapses, on the assumption the worker died; a
 * worker that is merely SLOW is indistinguishable from a dead one, so a window narrower than the
 * work it covers means the provider is called twice and the usage row's idempotency key hides
 * the second charge rather than preventing it. ADR-128 fixed the image window and wrote the rule
 * down, and the file named for it covered only the terminal-state guard — the WINDOWS themselves
 * had no test at all, which is how three of them were still wrong:
 *
 *  - `video.generate_scene` assumed the Replicate provider's 10 minutes while a local deployment
 *    gets `ImageMotionVideoProvider`, whose worst case is an image generation PLUS an ffmpeg run.
 *  - `video.render` was sized for one ffmpeg call; a render makes 2N+4 of them.
 *  - `document.ingest` gave 120 seconds to an embedding call that had no timeout at all.
 *
 * This reads the composition root, because the defect is in the arithmetic there rather than in
 * anything a request can reach: every value below is a constant chosen at boot.
 */
const INDEX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

/** The `expireInSeconds` expression a queue was ensured with. */
function windowExpressionFor(queue: string): string {
  const pattern = new RegExp(
    `ensureQueueWithDeadLetter\\(\\s*"${queue.replace(/\./g, "\\.")}"\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)`
  );
  const match = pattern.exec(INDEX);
  if (!match) throw new Error(`No ensureQueueWithDeadLetter call for "${queue}" — this test has drifted.`);
  const expire = /expireInSeconds:\s*([^,\n}]+)/.exec(match[1]);
  if (!expire) throw new Error(`"${queue}" was ensured with no expireInSeconds.`);
  return expire[1].trim();
}

describe("queue claim windows", () => {
  it("finds the queue definitions at all", () => {
    // A parser that matched nothing would make every assertion below vacuous.
    expect(windowExpressionFor("image.generate")).toBeTruthy();
    expect(windowExpressionFor("video.render")).toBeTruthy();
  });

  it("derives the image window from the image provider's own deadline", () => {
    // Not a literal: ADR-128's defect was a 60-second constant against providers allowed 180 and
    // 600, so every real generation outran its claim window.
    expect(windowExpressionFor("image.generate")).toContain("imageProviderDeadlineMs");
  });

  it("derives the scene window from the SELECTED video provider, not a constant", () => {
    const expression = windowExpressionFor("video.generate_scene");
    expect(expression).toContain("videoSceneDeadlineMs");
    expect(expression).not.toMatch(/^\d+$/);
    // And that variable really asks the provider rather than assuming Replicate's ten minutes.
    expect(INDEX).toMatch(/videoSceneDeadlineMs\s*=\s*videoProvider\?\.getCapabilities\(\)\.worstCaseDeadlineMs/);
  });

  it("sizes the render window against the WHOLE render's budget", () => {
    const expression = windowExpressionFor("video.render");
    expect(expression).toContain("DEFAULT_RENDER_BUDGET_MS");
    // One ffmpeg call's ceiling is not the render's: a render makes 2N+4 of them.
    expect(expression).not.toContain("DEFAULT_FFMPEG_TIMEOUT_MS");
  });

  it("sizes the ingest window against the embedding provider's deadline", () => {
    expect(windowExpressionFor("document.ingest")).toContain("DEFAULT_EMBED_TIMEOUT_MS");
  });

  it("leaves real headroom above each deadline, in the direction that matters", () => {
    // The rule ADR-128 states: the provider must always give up first. These are the two whose
    // constants this test can evaluate directly.
    const renderWindowSeconds = Math.ceil(DEFAULT_RENDER_BUDGET_MS / 1000) + 300;
    expect(renderWindowSeconds).toBeGreaterThan(DEFAULT_RENDER_BUDGET_MS / 1000);

    const ingestWindowSeconds = Math.ceil(DEFAULT_EMBED_TIMEOUT_MS / 1000) + 120;
    expect(ingestWindowSeconds).toBeGreaterThan(DEFAULT_EMBED_TIMEOUT_MS / 1000);
    // And the headroom is for the upload and the database write that follow, not a rounding
    // artefact — a minute or more in both cases.
    expect(ingestWindowSeconds - DEFAULT_EMBED_TIMEOUT_MS / 1000).toBeGreaterThanOrEqual(60);
  });
});
