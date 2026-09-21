import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "@ai-platform/observability";
import { SECRET_CONFIG_KEYS } from "./config.js";

/**
 * Every credential-shaped config key really redacts — docs/26_DECISIONS.md ADR-155.
 *
 * `LOG_REDACT_PATHS` was a hand-maintained list in the observability package and had drifted
 * seven fields behind `config.ts`: `LLM_API_KEY`, `VIDEO_API_TOKEN`, `IMAGE_API_KEY`,
 * `SPEECH_API_KEY`, `EMBEDDING_API_KEY`, `BOOTSTRAP_ADMIN_PASSWORD` and `DATABASE_URL` were all
 * live configuration and none of them was redacted. Its own test asserted the names the list
 * already had, so a field added to the schema later could never be caught by it.
 *
 * This iterates the DERIVED set instead, through a real logger writing real output, so the day
 * somebody adds `FOO_API_KEY` to the schema it is covered without anyone editing a list.
 */
function captureLog(fn: (log: ReturnType<typeof createLogger>) => void): string {
  let output = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  fn(createLogger("redaction-test", sink, SECRET_CONFIG_KEYS));
  return output;
}

const SECRET = "s3cret-value-that-must-never-appear";

describe("log redaction covers the configuration's own secrets", () => {
  it("derives a non-trivial set of secret keys from the schema", () => {
    // A filter that matched nothing would make every assertion below vacuous.
    expect(SECRET_CONFIG_KEYS.length).toBeGreaterThanOrEqual(8);
    for (const expected of [
      "ANTHROPIC_API_KEY",
      "LLM_API_KEY",
      "VIDEO_API_TOKEN",
      "IMAGE_API_KEY",
      "SPEECH_API_KEY",
      "EMBEDDING_API_KEY",
      "BOOTSTRAP_ADMIN_PASSWORD",
      "DATABASE_URL",
    ]) {
      expect(SECRET_CONFIG_KEYS).toContain(expected);
    }
  });

  it("redacts every one of them at the top level", () => {
    for (const key of SECRET_CONFIG_KEYS) {
      const output = captureLog((log) => log.info({ [key]: SECRET }, "boot"));
      expect(output, `${key} was logged in full`).not.toContain(SECRET);
      expect(output).toContain("[REDACTED]");
    }
  });

  it("redacts every one of them one level down, which is how config is usually logged", () => {
    for (const key of SECRET_CONFIG_KEYS) {
      const output = captureLog((log) => log.info({ config: { [key]: SECRET } }, "boot"));
      expect(output, `config.${key} was logged in full`).not.toContain(SECRET);
    }
  });

  it("still logs the ordinary fields around them", () => {
    // A redactor that censored everything would satisfy the assertions above and make the logs
    // useless, which is the other way to fail this.
    const output = captureLog((log) => log.info({ DATABASE_URL: SECRET, project_id: "p1" }, "boot"));
    expect(output).toContain("p1");
    expect(output).toContain("boot");
  });

  it("redacts a session cookie, which is a bearer credential like any key", () => {
    const output = captureLog((log) => log.info({ req: { headers: { cookie: SECRET } } }, "request"));
    expect(output).not.toContain(SECRET);
  });
});
