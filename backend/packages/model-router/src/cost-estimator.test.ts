import { describe, expect, it } from "vitest";
import { estimateLlmCostUsd, estimatePromptTokens } from "./cost-estimator.js";

describe("estimatePromptTokens", () => {
  it("approximates ~4 characters per token", () => {
    expect(estimatePromptTokens("a".repeat(400))).toBe(100);
  });

  it("never returns zero, even for empty input", () => {
    expect(estimatePromptTokens("")).toBe(1);
  });
});

describe("estimateLlmCostUsd", () => {
  it("computes real cost math against the researched Anthropic rate", () => {
    // claude-sonnet-5: $2/$10 per million input/output tokens.
    const cost = estimateLlmCostUsd("anthropic", "claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(12, 5);
  });

  it("computes real cost math against the researched OpenAI rate", () => {
    // gpt-5.6-terra: $2/$12 per million input/output tokens.
    const cost = estimateLlmCostUsd("openai", "gpt-5.6-terra", { inputTokens: 500_000, outputTokens: 100_000 });
    expect(cost).toBeCloseTo(1 + 1.2, 5);
  });

  it("computes real cost math against the researched Google rate", () => {
    // gemini-3.5-flash: $1.50/$9 per million input/output tokens.
    const cost = estimateLlmCostUsd("google", "gemini-3.5-flash", { inputTokens: 2_000_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(3, 5);
  });

  it("returns null (not a fabricated number) for an unpriced provider/model", () => {
    expect(estimateLlmCostUsd("mock", "mock-1", { inputTokens: 100, outputTokens: 100 })).toBeNull();
    expect(estimateLlmCostUsd("anthropic", "claude-opus-5", { inputTokens: 100, outputTokens: 100 })).toBeNull();
  });

  // Was `.toBe(0)`. ADR-045 changed the answer deliberately: zero usage on a priced model is
  // missing telemetry, not a free call, and "$0.00, priced" is a fabricated figure of exactly
  // the kind the rest of this module refuses to produce. The original point of the test — no
  // divide-by-zero, no throw — still holds.
  it("returns null rather than a fabricated $0 for zero usage on a priced model", () => {
    expect(estimateLlmCostUsd("anthropic", "claude-sonnet-5", { inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

/**
 * docs/26_DECISIONS.md ADR-045 — a real call always consumes tokens, so all-zero usage means
 * the telemetry was missing, not that the call was free. Pricing it at $0 would write a
 * confident "priced, $0.00" row into the usage ledger.
 */
describe("estimateLlmCostUsd with missing telemetry", () => {
  it("returns null, not 0, for a priced model reporting zero tokens", () => {
    expect(estimateLlmCostUsd("google", "gemini-3.5-flash", { inputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it("still prices a call that reported only output tokens", () => {
    expect(estimateLlmCostUsd("google", "gemini-3.5-flash", { inputTokens: 0, outputTokens: 1_000_000 })).toBe(9);
  });
});

