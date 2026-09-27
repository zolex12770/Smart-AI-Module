import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromPglite, JobQueue } from "./queue.js";

/**
 * Real integration tests against an actual in-memory PGlite Postgres instance — no mocks.
 * This is the automated counterpart to docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md's exit
 * criteria: a job survives a "worker restart" and a retried enqueue doesn't duplicate work.
 */
describe("JobQueue (real pg-boss on PGlite)", () => {
  let db: PGlite;
  let queue: JobQueue;

  beforeEach(async () => {
    db = new PGlite();
    // Fast supervise/maintenance intervals so stale-lock expiry (crash recovery) is
    // observable in seconds during tests instead of pg-boss's real-world default cadence.
    queue = new JobQueue({
      db: fromPglite(db),
      backend: "pglite",
      superviseIntervalSeconds: 1,
      maintenanceIntervalSeconds: 1,
    });
    await queue.start();
  });

  afterEach(async () => {
    // The crash-recovery test stops `queue` itself partway through (deliberately, to
    // simulate a dead worker without racing a second pg-boss instance's shutdown against
    // the same PGlite handle) — tolerate a redundant stop here rather than fail on it.
    await queue.stop().catch(() => {});
    await db.close();
  });

  /**
   * The source for the `queue_depth` gauge (docs/20_OBSERVABILITY.md §2.1). The zero matters as
   * much as the two: an operator alerting on sustained growth needs a series that exists while
   * the queue is healthy, or "no data" and "no backlog" become the same reading.
   */
  it("reports waiting work per queue, and reports the idle queues as zero rather than omitting them", async () => {
    await queue.ensureQueue("depth.busy");
    await queue.ensureQueue("depth.idle");

    await queue.enqueue("depth.busy", { n: 1 });
    await queue.enqueue("depth.busy", { n: 2 });

    expect(await queue.queueDepths()).toEqual({ "depth.busy": 2, "depth.idle": 0 });

    const done: number[] = [];
    await queue.registerWorker<{ n: number }>("depth.busy", async (payload) => {
      done.push(payload.n);
    });
    await waitFor(() => done.length === 2);

    // Drained, not merely claimed — a depth that never falls is indistinguishable from a
    // worker that never runs.
    expect(await queue.queueDepths()).toEqual({ "depth.busy": 0, "depth.idle": 0 });
  }, 15_000);

  it("enqueues a real job and a real worker processes it", async () => {
    await queue.ensureQueue("test.echo");
    const received: unknown[] = [];
    await queue.registerWorker<{ text: string }>("test.echo", async (payload) => {
      received.push(payload.text);
    });

    await queue.enqueue("test.echo", { text: "hello" });
    await waitFor(() => received.length > 0);

    expect(received).toEqual(["hello"]);
  });

  it("registerWorker accepts pg-boss WorkOptions (e.g. localConcurrency) and still processes every job", async () => {
    await queue.ensureQueue("test.concurrency");
    const received: unknown[] = [];
    await queue.registerWorker<{ n: number }>(
      "test.concurrency",
      async (payload) => {
        await new Promise((r) => setTimeout(r, 20));
        received.push(payload.n);
      },
      { localConcurrency: 2 }
    );

    await Promise.all([
      queue.enqueue("test.concurrency", { n: 1 }),
      queue.enqueue("test.concurrency", { n: 2 }),
      queue.enqueue("test.concurrency", { n: 3 }),
    ]);
    await waitFor(() => received.length === 3);

    expect(received.sort()).toEqual([1, 2, 3]);
  });

  it("deduplicates via singletonKey — a retry racing the original before it's claimed does not create a second job", async () => {
    // Deliberately no worker registered yet: singletonKey dedupes while the original job
    // is still queued/active (docs/07 §1.2's actual scenario — a retry-after-timeout race
    // arriving before the first attempt was claimed). Once a job is claimed, a *new*
    // logical attempt is expected to use a new key (see docs/11_AGENT_LOOP.md's own
    // attempt-numbered idempotency keys) — this test targets the race window, not "forever."
    // pg-boss's default "standard" queue policy does NOT deduplicate by singletonKey at
    // all (confirmed directly — an earlier version of this test failed against a
    // standard-policy queue). "exclusive" is what actually enforces one queued-or-active
    // job per key, per docs/07 §1.2's idempotency requirement.
    await queue.ensureQueue("test.idempotent", { policy: "exclusive" });

    const firstId = await queue.enqueue("test.idempotent", { op: "charge" }, { singletonKey: "charge-order-42" });
    const secondId = await queue.enqueue("test.idempotent", { op: "charge" }, { singletonKey: "charge-order-42" });

    // pg-boss rejects the duplicate send outright (returns null) rather than queuing a
    // second row — this IS the idempotency guarantee docs/07 §1.2 asks for.
    expect(firstId).not.toBeNull();
    expect(secondId).toBeNull();

    let processedCount = 0;
    await queue.registerWorker("test.idempotent", async () => {
      processedCount++;
    });
    await waitFor(() => processedCount > 0);
    await new Promise((r) => setTimeout(r, 200)); // let any erroneous second run surface
    expect(processedCount).toBe(1);
  });

  it("a job survives a 'worker restart' — an expired lock lets a new worker pick up the same job instead of losing it", async () => {
    const jobId = await setUpHungJobAndWaitForExpiry();

    let handledByRestartedWorker = false;
    const restartedQueue = new JobQueue({
      db: fromPglite(db),
      backend: "pglite",
      superviseIntervalSeconds: 1,
      maintenanceIntervalSeconds: 1,
    });
    await restartedQueue.start();
    await restartedQueue.registerWorker("test.crash-recovery", async () => {
      handledByRestartedWorker = true;
    });

    try {
      await waitFor(() => handledByRestartedWorker, 15_000);
    } catch (err) {
      // Real diagnostics instead of guessing — print the job's actual pg-boss state so a
      // failure here says *why*, not just "timed out".
      const job = await restartedQueue.getJob("test.crash-recovery", jobId);
      console.error("Job state at failure:", JSON.stringify(job, null, 2));
      throw err;
    } finally {
      await restartedQueue.stop();
    }

    expect(handledByRestartedWorker).toBe(true);
  }, 25_000);

  /** Enqueues a job, lets a worker claim it and then "crash" (hang forever), stops that
   * worker's queue instance cleanly (so its timers don't race the next queue instance
   * sharing the same PGlite handle), and waits past expireInSeconds so pg-boss's
   * maintenance considers the lock stale. Returns the job id. */
  async function setUpHungJobAndWaitForExpiry(): Promise<string> {
    await queue.ensureQueue("test.crash-recovery", { expireInSeconds: 1, retryLimit: 3 });

    let handledByFirstWorker = false;
    await queue.registerWorker("test.crash-recovery", async () => {
      handledByFirstWorker = true;
      await new Promise(() => {}); // never resolves — simulates a dead worker
    });

    const jobId = await queue.enqueue("test.crash-recovery", { work: "important" });
    if (!jobId) throw new Error("enqueue returned null");
    await waitFor(() => handledByFirstWorker);

    // Stop this queue instance's own timers/polling explicitly, rather than leaving them
    // running until the shared afterEach — two pg-boss instances racing shutdown against
    // the same single-connection PGlite handle was producing spurious
    // "PGlite is closed" errors from whichever instance's in-flight query lost the race.
    await queue.stop();

    await new Promise((r) => setTimeout(r, 3000));
    return jobId;
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The standalone-Postgres configuration (DATABASE_URL) passes only a connection string. pg-boss 12
 * treats a present-but-undefined `backend` as an unknown backend and throws in its constructor, so
 * every production boot against a real Postgres failed — found by starting the compose stack.
 * Construction validates configuration without connecting, so this needs no database.
 */
describe("JobQueue configured for a standalone Postgres", () => {
  it("constructs from a connection string alone", () => {
    expect(() => new JobQueue({ connectionString: "postgres://ai:secret@127.0.0.1:1/ai" })).not.toThrow();
  });
});
