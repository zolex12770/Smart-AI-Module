import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobQueue, deadLetterNameFor, fromPglite, isDeadLetterQueue, sourceQueueNameFor } from "./queue.js";

/**
 * docs/26_DECISIONS.md ADR-072 — dead-letter queues, and the job-stealing bug that reading the
 * queue used to cause.
 *
 * Every test here runs against a real pg-boss on a real Postgres (PGlite). That is deliberate
 * and not incidental: both defects this file covers were invisible to the type system and to
 * any mock. `deadLetter` compiled fine while never being set, and `fetch()`'s types say nothing
 * about it transitioning jobs to `active`. Only running it showed either.
 */
describe("dead-letter queues and read-only job listing", () => {
  let pg: PGlite;
  let queue: JobQueue;
  let deadLettered: { queue: string; jobId: string }[];

  beforeEach(async () => {
    pg = new PGlite();
    deadLettered = [];
    queue = new JobQueue({
      db: fromPglite(pg),
      backend: "pglite",
      // Fast maintenance so the archive/expiry machinery is observable in seconds.
      superviseIntervalSeconds: 1,
      maintenanceIntervalSeconds: 1,
      onDeadLetter: (event) => deadLettered.push(event),
    });
    await queue.start();
  });

  afterEach(async () => {
    await queue.stop();
    await pg.close();
  });

  describe("naming", () => {
    it("round-trips a queue name through its dead-letter name", () => {
      expect(deadLetterNameFor("document.scan")).toBe("document.scan.dlq");
      expect(sourceQueueNameFor("document.scan.dlq")).toBe("document.scan");
    });

    it("is idempotent, so a DLQ never gets a DLQ of its own", () => {
      // ensureQueueWithDeadLetter is called per configured queue; if the suffix stacked, a
      // second boot would create `x.dlq.dlq` and the listing would look in the wrong place.
      expect(deadLetterNameFor("x.dlq")).toBe("x.dlq");
      expect(isDeadLetterQueue("x.dlq")).toBe(true);
      expect(isDeadLetterQueue("x")).toBe(false);
    });
  });

  it("moves a job to the dead-letter queue once its retries are exhausted", async () => {
    await queue.ensureQueueWithDeadLetter("failing", { retryLimit: 1, expireInSeconds: 5 });

    let attempts = 0;
    await queue.registerWorker<{ projectId: string; doc: string }>("failing", async () => {
      attempts += 1;
      throw new Error("provider unavailable");
    });

    await queue.enqueue("failing", { projectId: "p1", doc: "d1" });
    await waitFor(async () => (await queue.listDeadLetteredForProject("p1")).length > 0, 20_000);

    const dead = await queue.listDeadLetteredForProject("p1");
    expect(dead).toHaveLength(1);
    expect(dead[0].sourceQueue).toBe("failing");
    expect(dead[0].deadLetterQueue).toBe("failing.dlq");
    // The payload survives intact — that is what makes replay possible at all.
    expect(dead[0].payload).toEqual({ projectId: "p1", doc: "d1" });
    // retryLimit 1 means two runs total, and the operator needs the reason, not just the fact.
    expect(attempts).toBe(2);
    expect(dead[0].attempts).toBe(2);
    expect(dead[0].error).toContain("provider unavailable");
  }, 40_000);

  /**
   * The hook behind `job_dead_letter_total`. pg-boss moves the job itself, asynchronously and
   * without an event, so the only observable moment is the attempt that runs out of retries —
   * which is exactly the moment worth counting, and exactly once.
   */
  it("announces the exhausting failure once, not once per attempt", async () => {
    await queue.ensureQueueWithDeadLetter("counted", { retryLimit: 1, expireInSeconds: 5 });

    let attempts = 0;
    await queue.registerWorker<{ projectId: string }>("counted", async () => {
      attempts += 1;
      throw new Error("provider unavailable");
    });

    await queue.enqueue("counted", { projectId: "p1" });
    await waitFor(async () => (await queue.listDeadLetteredForProject("p1")).length > 0, 20_000);

    // Two runs happened; only the second had no retry left. Announcing both would make the
    // dead-letter count a multiple of the retry limit, which is a worse number than none.
    expect(attempts).toBe(2);
    expect(deadLettered).toEqual([{ queue: "counted", jobId: expect.any(String) }]);
  }, 40_000);

  it("says nothing for a queue with no dead-letter target, because nothing is dead-lettered", async () => {
    // `ensureQueue`, not `ensureQueueWithDeadLetter` — the job stops at `failed` and is archived
    // away (the ADR-072 defect), so counting it as a dead letter would report recoveries that
    // are not there to be made.
    await queue.ensureQueue("undertaker", { retryLimit: 0, expireInSeconds: 5 });
    await queue.registerWorker<{ projectId: string }>("undertaker", async () => {
      throw new Error("no dlq here");
    });

    await queue.enqueue("undertaker", { projectId: "p1" });
    await waitFor(async () => (await queue.listForProject("p1")).some((job) => job.state === "failed"), 20_000);

    expect(deadLettered).toEqual([]);
  }, 40_000);

  it("replays a dead-lettered job back onto its original queue", async () => {
    await queue.ensureQueueWithDeadLetter("flaky", { retryLimit: 0, expireInSeconds: 5 });

    let healthy = false;
    const completed: string[] = [];
    await queue.registerWorker<{ projectId: string; doc: string }>("flaky", async (payload) => {
      if (!healthy) throw new Error("clamd not reachable");
      completed.push(payload.doc);
    });

    await queue.enqueue("flaky", { projectId: "p1", doc: "d1" });
    await waitFor(async () => (await queue.listDeadLetteredForProject("p1")).length > 0, 20_000);

    // The dependency recovers — which is the entire scenario a DLQ exists for.
    healthy = true;
    const [dead] = await queue.listDeadLetteredForProject("p1");
    const replayedId = await queue.replayDeadLettered("p1", dead.deadLetterQueue, dead.id);
    expect(replayedId).toBeTruthy();

    await waitFor(async () => completed.length > 0, 20_000);
    expect(completed).toEqual(["d1"]);

    // And the dead letter is cleared, so it cannot be replayed twice by a second operator.
    await waitFor(async () => (await queue.listDeadLetteredForProject("p1")).length === 0, 10_000);
  }, 40_000);

  it("refuses to replay another project's dead letter", async () => {
    await queue.ensureQueueWithDeadLetter("guarded", { retryLimit: 0, expireInSeconds: 5 });
    await queue.registerWorker<{ projectId: string }>("guarded", async () => {
      throw new Error("nope");
    });
    await queue.enqueue("guarded", { projectId: "p1" });
    await waitFor(async () => (await queue.listDeadLetteredForProject("p1")).length > 0, 20_000);

    const [dead] = await queue.listDeadLetteredForProject("p1");
    // Null, not a throw and not a 403 — a resource in another tenant is reported exactly as a
    // resource that does not exist (ADR-049).
    expect(await queue.replayDeadLettered("p2", dead.deadLetterQueue, dead.id)).toBeNull();
    expect(await queue.listDeadLetteredForProject("p2")).toEqual([]);
    // And it is still there for its real owner.
    expect(await queue.listDeadLetteredForProject("p1")).toHaveLength(1);
  }, 40_000);

  describe("listForProject no longer claims the jobs it reports", () => {
    it("leaves a pending job pending", async () => {
      await queue.ensureQueueWithDeadLetter("readonly", { retryLimit: 1, expireInSeconds: 30 });
      const id = await queue.enqueue("readonly", { projectId: "p1" });

      // The regression this asserts: the previous implementation called boss.fetch(), which
      // transitioned every job it returned to `active` — so opening the jobs screen claimed the
      // project's pending work into a process that would never run it.
      const first = await queue.listForProject("p1");
      expect(first).toHaveLength(1);
      expect(first[0].state).toBe("created");

      const job = await queue.getJob("readonly", id!);
      expect(job?.state).toBe("created");

      // Still true after repeated reads — a few refreshes used to be enough to burn the whole
      // retry budget.
      await queue.listForProject("p1");
      await queue.listForProject("p1");
      expect((await queue.getJob("readonly", id!))?.state).toBe("created");
    }, 30_000);

    it("scopes to the caller's project in SQL", async () => {
      await queue.ensureQueueWithDeadLetter("scoped", { retryLimit: 0, expireInSeconds: 30 });
      await queue.enqueue("scoped", { projectId: "p1" });
      await queue.enqueue("scoped", { projectId: "p2" });

      expect(await queue.listForProject("p1")).toHaveLength(1);
      expect(await queue.listForProject("p2")).toHaveLength(1);
      expect(await queue.listForProject("p3")).toEqual([]);
    }, 30_000);

    it("hides dead-letter queues from the normal listing unless asked", async () => {
      await queue.ensureQueueWithDeadLetter("hidden", { retryLimit: 0, expireInSeconds: 5 });
      await queue.registerWorker<{ projectId: string }>("hidden", async () => {
        throw new Error("fail");
      });
      await queue.enqueue("hidden", { projectId: "p1" });
      await waitFor(async () => (await queue.listDeadLetteredForProject("p1")).length > 0, 20_000);

      // The jobs screen should show the user's work, not the platform's plumbing — a dead
      // letter is surfaced through its own endpoint, with the failure reason attached.
      const normal = await queue.listForProject("p1");
      expect(normal.every((job) => !isDeadLetterQueue(job.queue))).toBe(true);

      const withDlq = await queue.listForProject("p1", { includeDeadLetter: true });
      expect(withDlq.some((job) => isDeadLetterQueue(job.queue))).toBe(true);
    }, 40_000);

    it("reports why a job failed, not merely that it did", async () => {
      await queue.ensureQueueWithDeadLetter("explained", { retryLimit: 0, expireInSeconds: 5 });
      await queue.registerWorker<{ projectId: string }>("explained", async () => {
        throw new Error("disk full");
      });
      await queue.enqueue("explained", { projectId: "p1" });

      await waitFor(async () => {
        const jobs = await queue.listForProject("p1");
        return jobs.some((job) => job.state === "failed");
      }, 20_000);

      const failed = (await queue.listForProject("p1")).find((job) => job.state === "failed");
      expect(failed?.error).toContain("disk full");
    }, 40_000);
  });
});

/** Polls until `check` is true, failing with a clear message rather than a bare timeout. */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
