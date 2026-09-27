import { describe, expect, it } from "vitest";
import { ModelRegistry } from "@ai-platform/model-router";
import type { Logger } from "@ai-platform/observability";
import { envSchema, loadConfig, type AppConfig } from "./config.js";
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
/**
 * A configuration with every provider-selecting setting CLEARED, so each test states the one it is
 * about. `loadConfig()` reads the real environment, and a developer who has exported
 * IMAGE_SD_CLI_PATH (or any provider variable) would otherwise change what these tests assert —
 * which is how this suite started failing the moment a local image model became selectable.
 */
const PROVIDER_SETTINGS = [
  "IMAGE_BASE_URL",
  "IMAGE_MODEL",
  "IMAGE_SD_CLI_PATH",
  "IMAGE_SD_MODEL_PATH",
  "VIDEO_PROVIDER",
  "VIDEO_API_TOKEN",
  "VIDEO_MODEL_VERSION",
  "LLM_BASE_URL",
  "LLM_MODEL",
] as const;

const base = (): AppConfig => {
  const config = { ...loadConfig() } as Record<string, unknown>;
  for (const key of PROVIDER_SETTINGS) config[key] = undefined;
  return config as AppConfig;
};

const productionConfig = (over: Partial<AppConfig> = {}): AppConfig =>
  ({ ...base(), NODE_ENV: "production", ...over }) as AppConfig;

const developmentConfig = (over: Partial<AppConfig> = {}): AppConfig =>
  ({ ...base(), NODE_ENV: "development", ALLOW_MOCK_PROVIDERS: false, ...over }) as AppConfig;

/** A test harness or the E2E server: mocks asked for explicitly. */
const mocksAllowedConfig = (over: Partial<AppConfig> = {}): AppConfig =>
  developmentConfig({ ALLOW_MOCK_PROVIDERS: true, ...over } as Partial<AppConfig>);

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

  it("registers NO mock in development either, unless ALLOW_MOCK_PROVIDERS is set", () => {
    // A development server with nothing configured used to answer chat from the stub, which
    // looked like a working product. Now chat reports that no model is configured.
    const registry = new ModelRegistry();
    registerLlmProviders(developmentConfig(), registry, silentLogger);
    expect(registry.list()).toEqual([]);
  });

  it("registers the mock when ALLOW_MOCK_PROVIDERS=true — tests and the E2E server", () => {
    const registry = new ModelRegistry();
    registerLlmProviders(mocksAllowedConfig(), registry, silentLogger);
    expect(registry.list().some((p) => p.isMock)).toBe(true);
  });

  it("refuses ALLOW_MOCK_PROVIDERS=true in production at config load", () => {
    const result = envSchema.safeParse({ ...process.env, NODE_ENV: "production", ALLOW_MOCK_PROVIDERS: "true" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.flatten().fieldErrors)).toMatch(/ALLOW_MOCK_PROVIDERS=true is refused/);
    // And it is accepted where it belongs.
    expect(envSchema.safeParse({ ...process.env, NODE_ENV: "test", ALLOW_MOCK_PROVIDERS: "true" }).success).toBe(true);
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

  it("are NULL in development when nothing is configured — unavailable, never a placeholder", () => {
    expect(selectImageProvider(developmentConfig())).toBeNull();
    expect(selectVideoProvider(developmentConfig())).toBeNull();
  });

  it("are a mock only when ALLOW_MOCK_PROVIDERS=true", () => {
    expect(selectImageProvider(mocksAllowedConfig())?.isMock).toBe(true);
    expect(selectVideoProvider(mocksAllowedConfig())?.isMock).toBe(true);
  });

  it("prefer the real provider over the mock when one is configured, even outside production", () => {
    const withImage = mocksAllowedConfig({
      IMAGE_BASE_URL: "http://127.0.0.1:9/v1",
      IMAGE_MODEL: "img-test",
    } as Partial<AppConfig>);
    expect(selectImageProvider(withImage)?.isMock).toBe(false);
  });

  /**
   * A LOCAL diffusion model is a real provider, so the production rule is "no fake", not "no
   * provider" — ADR-120. These state that distinction, which is exactly what the earlier
   * assertions could not express.
   */
  it("uses a configured local diffusion model in production, because it is not a mock", () => {
    const withLocal = productionConfig({
      IMAGE_SD_CLI_PATH: process.execPath,
      IMAGE_SD_MODEL_PATH: process.execPath,
    } as Partial<AppConfig>);
    const provider = selectImageProvider(withLocal);
    expect(provider).not.toBeNull();
    expect(provider?.isMock).toBe(false);
    expect(provider?.name).toBe("stable-diffusion.cpp");
  });

  it("prefers a local diffusion model over the mock even when mocks are allowed", () => {
    const withLocal = mocksAllowedConfig({
      IMAGE_SD_CLI_PATH: process.execPath,
      IMAGE_SD_MODEL_PATH: process.execPath,
    } as Partial<AppConfig>);
    expect(selectImageProvider(withLocal)?.isMock).toBe(false);
  });

  it("falls back to the mock only when mocks are allowed and no local model is configured", () => {
    expect(selectImageProvider(mocksAllowedConfig())?.isMock).toBe(true);
    expect(selectImageProvider(developmentConfig())).toBeNull();
  });
});
