import { describe, expect, it } from "vitest";
import { ModelRegistry } from "@ai-platform/model-router";
import type { Logger } from "@ai-platform/observability";
import { loadConfig, type AppConfig } from "./config.js";
import { registerLlmProviders, selectImageProvider, selectVideoProvider } from "./providers.js";

/**
 * No fake implementation is reachable in production — docs/26_DECISIONS.md ADR-101,
 * product brief §32.
 *
 * This replaces a CI gate that could not work. It was
 * `grep -rn "new Mock" backend/src --include=*.ts | grep -v "NODE_ENV" | grep -v test`, and it
 * was wrong in BOTH directions:
 *
 *  - The LLM guard is `if (config.NODE_ENV !== "production") {` on the line ABOVE the
 *    construction, so the construction line contains neither "NODE_ENV" nor "test" and survived
 *    both filters. The step exited 1 on correct code, which means the `security` job could never
 *    pass — falsifying the workflow's own claim that "every step below was chosen to match a
 *    command that IS run locally".
 *  - And a trailing `// NODE_ENV` comment would have defeated it, so it did not reliably catch
 *    the thing it existed for either.
 *
 * Asserting the BEHAVIOUR cannot be fooled by where a line break falls. Both directions are
 * checked, because a test that only proves "no mock in production" would also pass if the
 * factories returned nothing at all.
 */
const base = (): AppConfig => {
  const config = loadConfig();
  return { ...config };
};

const productionConfig = (over: Partial<AppConfig> = {}): AppConfig =>
  ({ ...base(), NODE_ENV: "production", ...over }) as AppConfig;

const developmentConfig = (over: Partial<AppConfig> = {}): AppConfig =>
  ({ ...base(), NODE_ENV: "development", ...over }) as AppConfig;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

describe("LLM providers", () => {
  it("registers NO mock provider under NODE_ENV=production", () => {
    const registry = new ModelRegistry();
    registerLlmProviders(
      productionConfig({ LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_MODEL: "local-test" }),
      registry,
      silentLogger
    );
    expect(registry.list().length).toBeGreaterThan(0);
    expect(registry.list().filter((p) => p.isMock)).toEqual([]);
  });

  it("registers nothing at all in production when no runtime is configured, rather than falling back to the mock", () => {
    const registry = new ModelRegistry();
    registerLlmProviders(productionConfig(), registry, silentLogger);
    // Zero is correct: the route layer then answers a real capability error, and ADR-060's boot
    // check refuses to serve chat at all. What must never happen is a mock quietly taking over.
    expect(registry.list().filter((p) => p.isMock)).toEqual([]);
  });

  it("DOES register the mock outside production — the zero-configuration local loop", () => {
    const registry = new ModelRegistry();
    registerLlmProviders(developmentConfig(), registry, silentLogger);
    expect(registry.list().some((p) => p.isMock)).toBe(true);
  });
});

describe("image and video providers", () => {
  it("are null in production when no credentials are configured", () => {
    expect(selectImageProvider(productionConfig())).toBeNull();
    expect(selectVideoProvider(productionConfig())).toBeNull();
  });

  it("are never a mock in production, even so", () => {
    // The three-state shape (real / none / mock) is what makes this worth asserting separately:
    // "no provider" and "a fake provider" are both falsy-ish outcomes that read alike in a log.
    for (const provider of [selectImageProvider(productionConfig()), selectVideoProvider(productionConfig())]) {
      expect(provider?.isMock ?? false).toBe(false);
    }
  });

  it("ARE a mock outside production, so the local loop needs no credentials", () => {
    expect(selectImageProvider(developmentConfig())?.isMock).toBe(true);
    expect(selectVideoProvider(developmentConfig())?.isMock).toBe(true);
  });

  it("prefer the real provider over the mock when one is configured, even outside production", () => {
    const withImage = developmentConfig({
      IMAGE_BASE_URL: "http://127.0.0.1:9/v1",
      IMAGE_MODEL: "img-test",
    } as Partial<AppConfig>);
    expect(selectImageProvider(withImage)?.isMock).toBe(false);
  });
});
