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

  it("handles zero usage without dividing by zero or erroring", () => {
    expect(estimateLlmCostUsd("anthropic", "claude-sonnet-5", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
