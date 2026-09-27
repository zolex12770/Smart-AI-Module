import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { initMetrics, recordMediaJob, shutdownMetrics } from "@ai-platform/observability";
import { startMetricsServer } from "./metrics-server.js";

/**
 * The worker's counters, reachable — see metrics-server.ts. The compose acceptance run read
 * `generation_total 0` from the API after the worker had generated an image, speech and a video.
 */
describe("the metrics-only listener", () => {
  let server: Server | undefined;
  const url = (path = "/metrics") => `http://127.0.0.1:${(server!.address() as AddressInfo).port}${path}`;

  beforeAll(() => initMetrics("worker"));
  afterAll(() => shutdownMetrics());
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("serves this process's counters in the Prometheus text format", async () => {
    recordMediaJob({ mediaType: "image", provider: "stable-diffusion.cpp", outcome: "success", durationMs: 1200 });
    server = await startMetricsServer({ port: 0, host: "127.0.0.1" });
    const res = await fetch(url());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(await res.text()).toMatch(/generation_total\{[^}]*\} 1/);
  });

  it("requires the bearer token when one is configured, and compares it in full", async () => {
    server = await startMetricsServer({ port: 0, host: "127.0.0.1", token: "s3cret-token" });
    expect((await fetch(url())).status).toBe(401);
    expect((await fetch(url(), { headers: { authorization: "Bearer s3cret" } })).status).toBe(401);
    expect((await fetch(url(), { headers: { authorization: "Bearer s3cret-token" } })).status).toBe(200);
  });

  it("serves nothing else", async () => {
    server = await startMetricsServer({ port: 0, host: "127.0.0.1" });
    expect((await fetch(url("/api/v1/admin/metrics"))).status).toBe(404);
    expect((await fetch(url(), { method: "POST" })).status).toBe(404);
  });
});
