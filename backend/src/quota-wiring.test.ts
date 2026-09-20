import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every limit the quota manager understands can actually be set — docs/26_DECISIONS.md ADR-150.
 *
 * `QuotaLimits` has carried `dailyEmbeddingTokenLimit` and `monthlyEmbeddingTokenLimit` since
 * ADR-131. No environment variable could supply them and the composition root did not pass them,
 * so `checkEmbeddingTokens` returned `allowed: true` in every real deployment — a meter that was
 * built, called from all four embedding paths, covered by its own unit tests, and unable to
 * refuse anything. Its unit tests passed because they construct the manager directly with limits
 * the product cannot produce.
 *
 * So the assertion is about the WIRING rather than the behaviour: a field added to `QuotaLimits`
 * and not threaded through the config and the composition root fails here instead of quietly
 * becoming another permanent no-op. It reads the sources, because that is the only place the gap
 * exists — every runtime object involved looks correct.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const QUOTA_MANAGER = join(HERE, "../packages/quota/src/quota-manager.ts");
const CONFIG = join(HERE, "config.ts");
const COMPOSITION_ROOT = join(HERE, "index.ts");

/** The field names declared on the `QuotaLimits` interface. */
function declaredLimits(): string[] {
  const source = readFileSync(QUOTA_MANAGER, "utf8");
  const block = /export interface QuotaLimits \{([\s\S]*?)\n\}/.exec(source);
  if (!block) throw new Error("QuotaLimits interface not found — this test has drifted, not the code.");
  return [...block[1].matchAll(/^\s*(\w+)\?:/gm)].map((m) => m[1]);
}

/** `dailyEmbeddingTokenLimit` -> `DAILY_EMBEDDING_TOKEN_LIMIT`. */
function envNameFor(field: string): string {
  return field.replace(/([A-Z])/g, "_$1").toUpperCase();
}

describe("every configurable quota limit is actually reachable", () => {
  const limits = declaredLimits();

  it("finds the limits at all", () => {
    // A parser that silently found nothing would make everything below vacuous.
    expect(limits.length).toBeGreaterThanOrEqual(8);
    expect(limits).toContain("dailyTokenLimit");
    expect(limits).toContain("dailyEmbeddingTokenLimit");
  });

  it("gives each one an environment variable", () => {
    const config = readFileSync(CONFIG, "utf8");
    const missing = limits.filter((field) => !new RegExp(`\\b${envNameFor(field)}\\s*:`).test(config));
    expect(missing).toEqual([]);
  });

  it("passes each one into the QuotaManager the server actually builds", () => {
    const source = readFileSync(COMPOSITION_ROOT, "utf8");
    const block = /new QuotaManager\([\s\S]*?\n {2}\}\);/.exec(source);
    expect(block).not.toBeNull();
    const missing = limits.filter((field) => !new RegExp(`\\b${field}\\s*:`).test(block![0]));
    expect(missing).toEqual([]);
  });

  it("documents each one in .env.example", () => {
    // The operator-facing half: a limit that exists and is undiscoverable is not configurable.
    const example = readFileSync(join(HERE, "../../.env.example"), "utf8");
    const missing = limits.filter((field) => !example.includes(envNameFor(field)));
    expect(missing).toEqual([]);
  });

  it("fails for a limit that is declared and never wired", () => {
    // The check above is only worth having if it can fail, so the same logic runs against a
    // synthetic pair that does exactly what the embedding limits did.
    const block = "new QuotaManager(usage, {\n    dailyTokenLimit: config.DAILY_TOKEN_LIMIT,\n  });";
    const pretend = ["dailyTokenLimit", "dailyGoatLimit"];
    const missing = pretend.filter((field) => !new RegExp(`\\b${field}\\s*:`).test(block));
    expect(missing).toEqual(["dailyGoatLimit"]);
  });
});
