import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadDotEnvFiles } from "./config.js";

/**
 * The two properties the loader's safety rests on, checked against Node's REAL
 * `process.loadEnvFile` rather than assumed from its docs (docs/26_DECISIONS.md ADR-043):
 * an already-set environment variable is never overwritten by a file, and nothing is loaded
 * under NODE_ENV=test. The candidate-path resolution itself is exercised by the live boot
 * check in the ADR, since it depends on this module's real on-disk location.
 */
describe("loadDotEnvFiles", () => {
  const KEY = "AI_PLATFORM_ENV_TEST_VAR";
  let dir: string;

  afterEach(() => {
    delete process.env[KEY];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing under NODE_ENV=test — a developer's .env can never redirect the test suite", () => {
    expect(loadDotEnvFiles("test")).toEqual([]);
  });

  it("Node's loader never overwrites an already-set variable (real environment wins over the file)", () => {
    dir = mkdtempSync(join(tmpdir(), "envfile-test-"));
    const file = join(dir, ".env");
    writeFileSync(file, `${KEY}=from-file\n`);

    process.env[KEY] = "from-real-env";
    process.loadEnvFile(file);
    expect(process.env[KEY]).toBe("from-real-env");
  });

  it("Node's loader does set a variable that was not already present", () => {
    dir = mkdtempSync(join(tmpdir(), "envfile-test-"));
    const file = join(dir, ".env");
    writeFileSync(file, `${KEY}=from-file\n`);

    expect(process.env[KEY]).toBeUndefined();
    process.loadEnvFile(file);
    expect(process.env[KEY]).toBe("from-file");
  });
});

/**
 * docs/26_DECISIONS.md ADR-045. `.env.example` used to ship `GOOGLE_API_KEY=` with no value;
 * a reader who filled in the documented GEMINI_API_KEY alias instead left that blank line in
 * place, and an empty string is a *present* value to `??` and to `z.string().optional()` — so
 * the blank line silently shadowed their real key and the mock answered with no error
 * anywhere. These check the schema-level fix at the boundary where it belongs.
 */
describe("loadConfig treats an empty environment value as unset", () => {
  const KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DATABASE_URL", "CLAMD_HOST"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("does not let a blank GOOGLE_API_KEY shadow a real key set under the GEMINI_API_KEY alias", () => {
    process.env.GOOGLE_API_KEY = "";
    process.env.GEMINI_API_KEY = "AIza-real-key";
    const config = loadConfig();
    expect(config.GOOGLE_API_KEY).toBeUndefined();
    // The composition root resolves `GOOGLE_API_KEY || GEMINI_API_KEY`, so this is the value
    // that actually reaches GoogleProvider.
    expect(config.GOOGLE_API_KEY || config.GEMINI_API_KEY).toBe("AIza-real-key");
  });

  it("treats a whitespace-only value as unset and trims a pasted key's stray whitespace", () => {
    process.env.ANTHROPIC_API_KEY = "   ";
    process.env.OPENAI_API_KEY = "  sk-real-key	";
    const config = loadConfig();
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config.OPENAI_API_KEY).toBe("sk-real-key");
  });

  it("applies the same rule to non-secret optional variables", () => {
    process.env.DATABASE_URL = "";
    process.env.CLAMD_HOST = "";
    const config = loadConfig();
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.CLAMD_HOST).toBeUndefined();
  });
});

