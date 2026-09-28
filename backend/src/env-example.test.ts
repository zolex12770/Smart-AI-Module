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
});
