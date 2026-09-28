import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * next.config.mjs is evaluated twice: by `next build` and again, at runtime, by `next start`.
 * The two environments need not match — the rewrites are fixed at build time, the rest is
 * re-read. These tests load the file under each environment.
 */
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value as string);
  // @ts-expect-error -- a plain .mjs config with a JSDoc type, no declaration file.
  const mod = (await import("../next.config.mjs")) as { default: unknown };
  return mod.default as {
    compress?: boolean;
    experimental?: { proxyTimeout?: number };
    rewrites?: () => Promise<Array<{ source: string; destination: string }>>;
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config.mjs", () => {
  it("keeps a proxied stream open for up to an hour even when NEXT_PUBLIC_API_PROXY_TARGET is unset at runtime", async () => {
    // A stream silent for 40 s was cut at exactly 30 s through `next start` when this value
    // was only set alongside the rewrites.
    const config = await loadConfig({ NEXT_PUBLIC_API_PROXY_TARGET: "" });
    expect(config.experimental?.proxyTimeout).toBeGreaterThanOrEqual(3_600_000);
  });

  it("proxies /api/* to the API, uncompressed, in same-origin mode", async () => {
    const config = await loadConfig({ NEXT_PUBLIC_API_PROXY_TARGET: "https://api.example.test/" });
    expect(config.compress).toBe(false);
    expect(config.experimental?.proxyTimeout).toBeGreaterThanOrEqual(3_600_000);
    await expect(config.rewrites?.()).resolves.toEqual([
      { source: "/api/:path*", destination: "https://api.example.test/api/:path*" },
    ]);
  });

  it("adds no rewrite without NEXT_PUBLIC_API_PROXY_TARGET", async () => {
    const config = await loadConfig({ NEXT_PUBLIC_API_PROXY_TARGET: "" });
    expect(config.rewrites).toBeUndefined();
  });
});
