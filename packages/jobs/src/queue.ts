import { PgBoss, fromPglite } from "pg-boss";
import type { ConstructorOptions, JobWithMetadata, QueuePolicy, WorkOptions } from "pg-boss";

export { fromPglite };

export interface JobQueueOptions {
  /** Either `db` (a pg-boss connection adapter — `fromPglite` today, ADR-027) or
   * `connectionString` (a real standalone Postgres, ADR-037) is expected; pg-boss falls
   * back to its own default `pg.Pool`-backed adapter built from `connectionString` when
   * `db` is omitted. */
  db?: ConstructorOptions["db"];
  backend?: ConstructorOptions["backend"];
  connectionString?: ConstructorOptions["connectionString"];
  /** Passthrough for pg-boss's own tuning knobs — tests use a fast interval so
   * crash-recovery (stale-lock expiry -> requeue) is observable in seconds, not minutes. */
  superviseIntervalSeconds?: ConstructorOptions["superviseIntervalSeconds"];
  maintenanceIntervalSeconds?: ConstructorOptions["maintenanceIntervalSeconds"];
}

/** docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md §1.2 "Queue technology comparison" recommended
 * pg-boss on Postgres (docs/26_DECISIONS.md ADR-012). `db`/`backend` are supplied by the
 * caller so this package stays storage-agnostic — apps/api passes pg-boss's own
 * `fromPglite` adapter today (ADR-027), and a real standalone Postgres later needs only a
 * different `db`/`backend` at the composition root, not a change here. */
export interface EnqueueOptions {
  /** Idempotency key (docs/07 §1.2) — but only deduplicates on queues created with a
   * non-`standard` policy (`exclusive`/`singleton`/`stately`/`short`, see
   * `QueueSetupOptions.policy` below). pg-boss's default `standard` policy ignores
   * `singletonKey` entirely; verified directly in queue.test.ts after an initial
   * assumption to the contrary failed against a real queue. */
  singletonKey?: string;
}

export interface QueueSetupOptions {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  /** Seconds a job may sit "active" before pg-boss considers the worker dead and makes it
   * eligible for another worker to claim — this is what makes "job survives a worker
   * process restart" real rather than aspirational (docs/07 §1.2 "Heartbeat"/"Persistence"). */
  expireInSeconds?: number;
  /** pg-boss's default `standard` policy does NOT deduplicate by `singletonKey` at all —
   * verified directly in queue.test.ts. A queue whose jobs need the idempotency guarantee
   * from docs/07 §1.2 (a retry-after-timeout race must not double-submit) must opt into
   * `exclusive` (one job queued-or-active per key) or a stricter policy. */
  policy?: QueuePolicy;
}

export class JobQueue {
  private readonly boss: PgBoss;

  constructor(options: JobQueueOptions) {
    // pg-boss's own constructor validation rejects an explicit `undefined` for these
    // (asserts a numeric minimum unconditionally, rather than treating undefined as "use
    // the default") — found by actually booting apps/api, not by inspection. Omit the
    // keys entirely when unset instead of passing `undefined` through.
    this.boss = new PgBoss({
      db: options.db,
      backend: options.backend,
      connectionString: options.connectionString,
      ...(options.superviseIntervalSeconds !== undefined
        ? { superviseIntervalSeconds: options.superviseIntervalSeconds }
        : {}),
      ...(options.maintenanceIntervalSeconds !== undefined
        ? { maintenanceIntervalSeconds: options.maintenanceIntervalSeconds }
        : {}),
    });
    this.boss.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[jobs] pg-boss error:", err);
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: false });
  }

  async ensureQueue(name: string, retryPolicy: QueueSetupOptions = {}): Promise<void> {
    await this.boss.createQueue(name, retryPolicy);
  }

  async enqueue<T extends object>(queueName: string, payload: T, opts: EnqueueOptions = {}): Promise<string | null> {
    return this.boss.send(queueName, payload, opts);
  }

  /** Handler runs once per job; a thrown error triggers pg-boss's retry/backoff (per the
   * queue's retryPolicy) and eventually dead-letters the job once retries are exhausted.
   * `options.localConcurrency` bounds how many jobs this worker processes at once (docs/07
   * §1.6: "not all 150 [video] scenes fire at once") — omit it for pg-boss's own default. */
  async registerWorker<T>(
    queueName: string,
    handler: (payload: T, jobId: string) => Promise<void>,
    options?: WorkOptions
  ): Promise<void> {
    const run = async (jobs: { data: T; id: string }[]) => {
      for (const job of jobs) {
        await handler(job.data, job.id);
      }
    };
    if (options) {
      await this.boss.work<T>(queueName, options, run);
    } else {
      await this.boss.work<T>(queueName, run);
    }
  }

  async getJob<T = unknown>(queueName: string, jobId: string): Promise<JobWithMetadata<T> | null> {
    return this.boss.getJobById<T>(queueName, jobId);
  }
}
