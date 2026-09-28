import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every variable the backend reads is documented in both env templates. LLM_WARMUP, METRICS_PORT
 * and METRICS_TOKEN were read by config.ts and written down nowhere an operator would look.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const configKeys = [...read("./config.ts").matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);

describe("env templates", () => {
  it("finds the config schema's keys", () => {
    expect(configKeys.length).toBeGreaterThan(50);
    expect(configKeys).toContain("DATABASE_URL");
  });

  for (const template of ["../../.env.example", "../.env.example"]) {
    it(`${template.replace(/^[./]+/, "")} names every variable config.ts reads`, () => {
      const text = read(template);
      const missing = configKeys.filter((key) => !new RegExp(`\\b${key}=`).test(text));
      expect(missing).toEqual([]);
    });
  }

  it("keeps the two templates byte-identical, as their header says", () => {
    // They had drifted (ALLOW_MOCK_PROVIDERS documented in one, not the other) while the header
    // told readers a test kept them identical. Now one does.
    expect(read("../.env.example")).toBe(read("../../.env.example"));
  });

  it("keeps docs/ENVIRONMENT.md generated from them", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/generate-env-docs.mjs", import.meta.url)), "--check"], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
