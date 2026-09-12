import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

/**
 * A real secret-leakage test (docs/21_TESTING_STRATEGY.md §2.8) — captures actual log
 * output through a real Pino instance (not a mocked logger) and asserts a fake
 * secret-shaped value injected into a log call never appears in the emitted JSON, and
 * that the redaction censor does. This is the concrete, automatable half of docs/13
 * §1.4 ("never log raw API keys/secrets") — the other half (no call site *tries* to log
 * one) is a code-review discipline this test can't substitute for.
 */
function captureLogger(name: string) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger(name, destination);
  return { logger, lines };
}

describe("createLogger — secret redaction", () => {
  it("redacts a top-level apiKey field", () => {
    const { logger, lines } = captureLogger("test");
    logger.info({ apiKey: "sk-real-secret-value-12345" }, "provider call");

    const output = lines.join("\n");
    expect(output).not.toContain("sk-real-secret-value-12345");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts a nested authorization header", () => {
    const { logger, lines } = captureLogger("test");
    logger.info({ req: { headers: { authorization: "Bearer super-secret-token" } } }, "incoming request");

    const output = lines.join("\n");
    expect(output).not.toContain("super-secret-token");
  });

  it("redacts provider API key env-var-shaped fields at any nesting depth", () => {
    const { logger, lines } = captureLogger("test");
    logger.info({ config: { ANTHROPIC_API_KEY: "sk-ant-real-value" } }, "boot config");

    const output = lines.join("\n");
    expect(output).not.toContain("sk-ant-real-value");
  });

  it("does NOT redact ordinary, non-secret fields (redaction isn't overly broad)", () => {
    const { logger, lines } = captureLogger("test");
    logger.info({ request_id: "req-1", provider: "mock", latency_ms: 42 }, "provider call completed");

    const output = lines.join("\n");
    expect(output).toContain("req-1");
    expect(output).toContain("mock");
    expect(output).toContain("42");
  });
});
