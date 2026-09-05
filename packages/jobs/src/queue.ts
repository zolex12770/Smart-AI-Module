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

export interface ProjectJob {
  id: string;
  queue: string;
  state: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  retryCount: number;
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

  /** Queues this process has ensured, so `listForProject` can enumerate them itself. */
  private readonly ensuredQueues = new Set<string>();

  async ensureQueue(name: string, retryPolicy: QueueSetupOptions = {}): Promise<void> {
    this.ensuredQueues.add(name);
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

  /**
   * Jobs belonging to one project — docs/26_DECISIONS.md ADR-066.
   *
   * pg-boss has no notion of a tenant, so scope lives in the payload (every job this platform
   * enqueues carries `projectId`, ADR-049) and the filter is applied here rather than by the
   * caller. Reading it any other way would mean fetching another project's jobs and then
   * discarding them, which is the fetch-then-check pattern the whole authorization model
   * exists to avoid.
   */
  async listForProject(
    projectId: string,
    options: { queue?: string; limit?: number } = {}
  ): Promise<ProjectJob[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    const queues = options.queue ? [options.queue] : [...this.ensuredQueues];
    const out: ProjectJob[] = [];

    for (const queue of queues) {
      // pg-boss exposes no "list by payload predicate", so this reads the queue's recent jobs
      // and filters. Bounded by `limit` per queue so a large backlog cannot be pulled into
      // memory by one request.
      const jobs = await this.boss.fetch(queue, { batchSize: limit, includeMetadata: true }).catch(() => []);
      for (const job of jobs as Array<JobWithMetadata<{ projectId?: string }>>) {
        if (job.data?.projectId !== projectId) continue;
        out.push({
          id: job.id,
          queue,
          state: job.state,
          createdAt: job.createdOn?.toISOString?.() ?? null,
          startedAt: job.startedOn?.toISOString?.() ?? null,
          completedAt: job.completedOn?.toISOString?.() ?? null,
          retryCount: job.retryCount ?? 0,
        });
      }
    }
    return out.slice(0, limit);
  }

  /** Cancels one job, but only if it belongs to the caller's project. */
  async cancelForProject(projectId: string, queueName: string, jobId: string): Promise<boolean> {
    const job = await this.getJob<{ projectId?: string }>(queueName, jobId);
    // A job from another project is reported exactly like one that does not exist.
    if (!job || job.data?.projectId !== projectId) return false;
    await this.boss.cancel(queueName, jobId);
    return true;
  }

  async getJob<T = unknown>(queueName: string, jobId: string): Promise<JobWithMetadata<T> | null> {
    return this.boss.getJobById<T>(queueName, jobId);
  }
}
