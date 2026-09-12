import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dotEnvCandidatePaths, loadConfig, loadDotEnvFiles } from "./config.js";

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

  it("resolves every candidate INSIDE the repository, from src/ and from dist/", () => {
    // The repo root is located independently of the paths under test -- by walking up for the
    // package.json that declares the workspaces -- so this compares the loader's arithmetic
    // against the real tree rather than against itself. `../../../.env` passed every other test
    // in this file while resolving to the parent of the repository.
    let repoRoot = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(repoRoot, "package.json")) || !readFileSync(join(repoRoot, "package.json"), "utf8").includes('"workspaces"')) {
      const up = dirname(repoRoot);
      expect(up).not.toBe(repoRoot);
      repoRoot = up;
    }

    const candidates = dotEnvCandidatePaths();
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.startsWith(repoRoot + sep)).toBe(true);
    }
    // And one of them must be the repo root itself, which is what .env.example documents.
    expect(candidates).toContain(join(repoRoot, ".env"));
    expect(candidates).toContain(join(repoRoot, "backend", ".env"));
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

/**
 * docs/26_DECISIONS.md ADR-085. Naming a video provider is an explicit statement that this
 * deployment generates real video, so a half-configured one must not quietly degrade into "no
 * capability": the operator who typed the variable would get a 501 with nothing anywhere
 * saying why, and in production, where the mock is forbidden (ADR-013), the capability would
 * simply vanish. `process.exit` is substituted here because stopping the boot IS the behaviour
 * under test — there is no other way to observe a process exiting from inside it.
 */
describe("loadConfig refuses a half-configured video provider", () => {
  const KEYS = ["VIDEO_PROVIDER", "VIDEO_API_TOKEN", "VIDEO_MODEL_VERSION"];
  const VERSION = "9f747673945c62801b13b84701c783929c0ee784e4748ec062204894dda1a351";
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
    vi.restoreAllMocks();
  });

  function expectBootRefusal(): void {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("BOOT REFUSED");
    }) as never);
    expect(() => loadConfig()).toThrow("BOOT REFUSED");
  }

  it("accepts the complete set", () => {
    process.env.VIDEO_PROVIDER = "replicate";
    process.env.VIDEO_API_TOKEN = "r8_TESTONLY_not_a_real_token";
    process.env.VIDEO_MODEL_VERSION = VERSION;

    const config = loadConfig();
    expect(config.VIDEO_PROVIDER).toBe("replicate");
    expect(config.VIDEO_MODEL_VERSION).toBe(VERSION);
  });

  it("stops the boot when the token is missing", () => {
    process.env.VIDEO_PROVIDER = "replicate";
    process.env.VIDEO_MODEL_VERSION = VERSION;

    expectBootRefusal();
  });

  it("stops the boot when the model version is blank — the .env.example copy-paste case", () => {
    process.env.VIDEO_PROVIDER = "replicate";
    process.env.VIDEO_API_TOKEN = "r8_TESTONLY_not_a_real_token";
    process.env.VIDEO_MODEL_VERSION = "   ";

    expectBootRefusal();
  });

  it("stops the boot on a provider name nothing implements, rather than ignoring it", () => {
    process.env.VIDEO_PROVIDER = "runway";
    process.env.VIDEO_API_TOKEN = "key";
    process.env.VIDEO_MODEL_VERSION = "gen4_turbo";

    expectBootRefusal();
  });

  it("leaves video unconfigured, and the boot untouched, when none of the three is set", () => {
    const config = loadConfig();

    expect(config.VIDEO_PROVIDER).toBeUndefined();
    expect(config.VIDEO_API_TOKEN).toBeUndefined();
    expect(config.VIDEO_MODEL_VERSION).toBeUndefined();
  });
});

