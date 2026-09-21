import { describe, expect, it } from "vitest";
import { watchForCancellation } from "./cancellation-watch.js";

/**
 * A recorded cancellation request reaches the call that is still running — ADR-157.
 *
 * ADR-122 gave every media row a `cancel_requested_at` column and a route to set it, and the
 * workers read it once, before starting. `processAudioGeneration` takes a `signal`, threads it
 * into `speech.synthesize` and has a `cancelled` branch — and its one production caller passed
 * three arguments, so the parameter was always undefined. `VideoProvider.generateVideo` had no
 * signal parameter at all, so the Replicate adapter's own cancel endpoint, which stops a
 * prediction that is still billing, could not be reached. Both screens offer Cancel for exactly
 * the states those calls run in.
 */
describe("watchForCancellation", () => {
  it("aborts once the request appears", async () => {
    let requested = false;
    const watch = watchForCancellation(async () => requested, { intervalMs: 5 });
    try {
      expect(watch.signal.aborted).toBe(false);
      requested = true;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(watch.signal.aborted).toBe(true);
      // The caller needs to tell a cancellation from a provider failure, to settle the row.
      expect(watch.wasCancelled()).toBe(true);
    } finally {
      watch.stop();
    }
  });

  it("does not abort while no request has been made", async () => {
    // A watch that aborted on its own would stop every long job on the platform.
    const watch = watchForCancellation(async () => false, { intervalMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(watch.signal.aborted).toBe(false);
      expect(watch.wasCancelled()).toBe(false);
    } finally {
      watch.stop();
    }
  });

  it("keeps working when a poll fails", async () => {
    // A failed poll is not a cancellation: the safe direction for a check whose purpose is to
    // stop spending is to let the work continue and try again.
    let calls = 0;
    const watch = watchForCancellation(async () => {
      calls += 1;
      if (calls < 3) throw new Error("database unavailable");
      return true;
    }, { intervalMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(watch.signal.aborted).toBe(true);
    } finally {
      watch.stop();
    }
  });

  it("stops polling once it is stopped", async () => {
    let calls = 0;
    const watch = watchForCancellation(async () => {
      calls += 1;
      return false;
    }, { intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    watch.stop();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(after);
  });

  it("follows an outer signal, so a worker shutting down cancels the work too", async () => {
    const outer = new AbortController();
    const watch = watchForCancellation(async () => false, { intervalMs: 5, signal: outer.signal });
    try {
      outer.abort();
      expect(watch.signal.aborted).toBe(true);
      // ...but it is not recorded as a USER cancellation, which would mislabel the row.
      expect(watch.wasCancelled()).toBe(false);
    } finally {
      watch.stop();
    }
  });
});
