import { describe, expect, it, vi } from "vitest";
import { ReplicateVideoProvider } from "./index.js";

/**
 * docs/26_DECISIONS.md ADR-085 — the three defects review found in this adapter, pinned.
 *
 * All three share a shape: the adapter behaved correctly on the happy path and on the two
 * failure paths its author thought about (caller abort, wall-clock deadline), and wrongly on the
 * ordinary ones. Two of them cost real money on someone else's GPU, which is why they are tested
 * here rather than trusted to a comment.
 */

/** A stub `fetch` that answers a scripted sequence and records every URL it was asked for. */
function scriptedFetch(steps: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; method: string }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PREDICTION_URL = "https://api.replicate.com/v1/predictions/pid123";
const CANCEL_URL = "https://api.replicate.com/v1/predictions/pid123/cancel";

const submitted = () =>
  json({
    id: "pid123",
    status: "starting",
    urls: { get: PREDICTION_URL, cancel: CANCEL_URL },
  }, 201);

function provider(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new ReplicateVideoProvider({
    apiToken: "test-token",
    modelVersion: "v1",
    fetchImpl,
    pollIntervalMs: 1,
    maxPollIntervalMs: 1,
    ...overrides,
  } as never);
}

describe("a failed poll must not orphan a running prediction", () => {
  it("cancels when a poll returns a transient error", async () => {
    // The exact scenario from the review: submit, one healthy poll, then a 429. Replicate
    // rate-limits its API and ~30 polls per scene across many scenes makes this routine.
    const { impl, calls } = scriptedFetch([
      submitted,
      () => json({ id: "pid123", status: "processing", urls: { get: PREDICTION_URL, cancel: CANCEL_URL } }),
      () => json({ detail: "Request was throttled." }, 429),
      () => json({ id: "pid123", status: "canceled" }),
    ]);

    await provider(impl)
      .generateVideo({ prompt: "a clip", durationSeconds: 2 }, async () => "asset-1")
      .catch(() => undefined);

    // Before the fix this was [POST /predictions, GET, GET] with zero cancels, and the
    // prediction ran to completion on a billed GPU with nothing holding its id.
    expect(calls.some((c) => c.url === CANCEL_URL && c.method === "POST")).toBe(true);
  });

  it("still surfaces the original error rather than a cancellation failure", async () => {
    // The cancel is best-effort and runs while an error is already propagating. If the cancel
    // itself fails, the operator still needs the REAL cause.
    const { impl } = scriptedFetch([
      submitted,
      () => json({ detail: "Request was throttled." }, 429),
      () => {
        throw new Error("cancel endpoint unreachable");
      },
    ]);

    const error = await provider(impl)
      .generateVideo({ prompt: "a clip", durationSeconds: 2 }, async () => "asset-1")
      .catch((e: unknown) => e);

    expect(String(error)).not.toContain("cancel endpoint unreachable");
    expect(String(error)).toMatch(/throttl|rate/i);
  });
});

describe("the deadline must bound the body read, not just the headers", () => {
  it("does not hang on a response whose body never arrives", async () => {
    // Verified as a real hang before the fix: a 50ms deadline against a body stream that never
    // enqueued was still pending at 1502ms. `request` used to return the Response and let the
    // caller read it AFTER `dispose()` had cleared the timer and removed the abort listener, so
    // every body read ran on no signal at all.
    const stalled = () =>
      new Response(
        new ReadableStream({
          start() {
            /* never enqueues, never closes */
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );

    const { impl } = scriptedFetch([submitted, stalled]);
    const started = Date.now();

    await provider(impl, { requestTimeoutMs: 80, deadlineMs: 200 })
      .generateVideo({ prompt: "a clip", durationSeconds: 2 }, async () => "asset-1")
      .catch(() => undefined);

    // Generously bounded: the point is that it SETTLES, not that it settles in exactly 80ms.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);
});

describe("CDN failures are not diagnosed as API failures", () => {
  it("says the output expired, not that the API token is wrong", async () => {
    const { impl } = scriptedFetch([
      submitted,
      () =>
        json({
          id: "pid123",
          status: "succeeded",
          output: "https://replicate.delivery/pbxt/abc/out.mp4",
          urls: { get: PREDICTION_URL, cancel: CANCEL_URL },
        }),
      () => new Response("Not Found", { status: 404 }),
    ]);

    const error = await provider(impl)
      .generateVideo({ prompt: "a clip", durationSeconds: 2 }, async () => "asset-1")
      .catch((e: unknown) => e);

    const message = String(error);
    // The delivery host is not the API: a 404 there means the output expired, and no token is
    // sent to it at all. Telling an operator to check VIDEO_API_TOKEN sends them to fix
    // something that is not broken.
    expect(message).toMatch(/expire|regenerat|delivery/i);
    expect(message).not.toMatch(/VIDEO_API_TOKEN/);
  });
});
