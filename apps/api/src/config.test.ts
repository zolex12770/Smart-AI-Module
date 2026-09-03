import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnvFiles } from "./config.js";

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
