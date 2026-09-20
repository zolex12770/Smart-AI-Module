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
  /**
   * Called on the failure that exhausts a job's retries — the one pg-boss dead-letters.
   *
   * A hook rather than a direct metrics call because this package must not know what
   * observability the platform happens to use; the composition root supplies the meaning. It is
   * also why the hook is fire-and-forget: a counter that throws must not turn a dead letter into
   * a second, different failure.
   */
  onDeadLetter?: (event: { queue: string; jobId: string }) => void;
}

/** docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md §1.2 "Queue technology comparison" recommended
 * pg-boss on Postgres (docs/26_DECISIONS.md ADR-012). `db`/`backend` are supplied by the
 * caller so this package stays storage-agnostic — backend passes pg-boss's own
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
  /**
   * Queue that receives a job's payload once its retries are exhausted (ADR-072).
   *
   * Without this a permanently-failed job stops at state `failed` and is eventually archived
   * and deleted — the work is simply lost, with nothing left to inspect or replay. pg-boss
   * enforces a foreign key from this column to the queue table, so the named queue must be
   * created FIRST; `ensureQueueWithDeadLetter` exists so that ordering cannot be got wrong.
   */
  deadLetter?: string;
}

export interface ProjectJob {
  id: string;
  queue: string;
  state: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  retryCount: number;
  /** Present on a failed job — the reason, not just the state (ADR-072). */
  error: string | null;
}

export interface DeadLetteredJob {
  id: string;
  deadLetterQueue: string;
  sourceQueue: string;
  deadLetteredAt: string | null;
  /** The original payload, verbatim — this is what `replayDeadLettered` re-enqueues. */
  payload: unknown;
  /** Total runs before it was given up on: the recorded retries plus the first attempt. */
  attempts: number;
  error: string | null;
}

/** Raw `pgboss.job` shapes, kept next to the queries that read them. */
interface JobRow {
  id: string;
  name: string;
  state: string;
  created_on: Date | string | null;
  started_on: Date | string | null;
  completed_on: Date | string | null;
  retry_count: number | string | null;
  output: unknown;
}

interface DeadLetterRow {
  id: string;
  name: string;
  created_on: Date | string | null;
  data: unknown;
  source_id: string | null;
  source_retry_count: number | string | null;
  failure: unknown;
}

/**
 * The one place the DLQ naming convention lives — ADR-072.
 *
 * A convention rather than a registry because the mapping has to work in both directions from
 * a bare queue name: the API needs a source queue's DLQ in order to list it, and replay needs a
 * DLQ's source in order to send the job back. A lookup table would have to be populated
 * identically in the API and worker roles, and a role that missed an entry would silently list
 * nothing.
 */
const DEAD_LETTER_SUFFIX = ".dlq";

export function deadLetterNameFor(queueName: string): string {
  return isDeadLetterQueue(queueName) ? queueName : `${queueName}${DEAD_LETTER_SUFFIX}`;
}

export function sourceQueueNameFor(deadLetterQueueName: string): string {
  return isDeadLetterQueue(deadLetterQueueName)
    ? deadLetterQueueName.slice(0, -DEAD_LETTER_SUFFIX.length)
    : deadLetterQueueName;
}

export function isDeadLetterQueue(queueName: string): boolean {
  return queueName.endsWith(DEAD_LETTER_SUFFIX);
}

/** pg-boss returns timestamps as Date on one driver and as a string on another. */
function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The failure reason out of pg-boss's `output` column.
 *
 * pg-boss serialises a thrown Error to `{ message, stack, ... }` but a rejected non-Error to
 * whatever it was, so this handles both rather than assuming the well-behaved case and
 * rendering "[object Object]" for the other.
 */
function extractError(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    for (const key of ["message", "reason", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return String(output);
}

export class JobQueue {
  private readonly boss: PgBoss;
  private readonly onDeadLetter?: (event: { queue: string; jobId: string }) => void;

  constructor(options: JobQueueOptions) {
    this.onDeadLetter = options.onDeadLetter;
    // pg-boss's own constructor validation rejects an explicit `undefined` for these
    // (asserts a numeric minimum unconditionally, rather than treating undefined as "use
    // the default") — found by actually booting backend, not by inspection. Omit the
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
   * queue's retryPolicy). Once retries are exhausted the job is dead-lettered — but ONLY if
   * the queue was created with a `deadLetter` target, which is what `ensureQueueWithDeadLetter`
   * guarantees; on a queue without one it simply stops at `failed` and is later archived away
   * (ADR-072).
   * `options.localConcurrency` bounds how many jobs this worker processes at once (docs/07
   * §1.6: "not all 150 [video] scenes fire at once") — omit it for pg-boss's own default. */
  async registerWorker<T>(
    queueName: string,
    handler: (payload: T, jobId: string) => Promise<void>,
    options?: WorkOptions
  ): Promise<void> {
    // `includeMetadata` is what puts `retryCount`/`retryLimit`/`deadLetter` on the job. pg-boss
    // does the dead-lettering itself, asynchronously and out of sight, so this failing attempt is
    // the only place in this process that can see one coming — and `retryCount === retryLimit` on
    // an attempt that throws means there is no retry left to take.
    const run = async (jobs: JobWithMetadata<T>[]) => {
      for (const job of jobs) {
        try {
          await handler(job.data, job.id);
        } catch (err) {
          if (job.deadLetter && job.retryCount >= job.retryLimit) {
            this.onDeadLetter?.({ queue: queueName, jobId: job.id });
          }
          // Rethrown unchanged: pg-boss decides what happens to the job, this only observes.
          throw err;
        }
      }
    };
    // The options type is spelled out rather than inferred: pg-boss picks the metadata-carrying
    // handler overload from a *literal* `includeMetadata: true`, and spreading the caller's
    // optional `WorkOptions` widens it back to `boolean`, which silently selects the overload
    // whose jobs have no retry fields at all.
    await this.boss.work<T, void, WorkOptions & { includeMetadata: true }>(
      queueName,
      { ...options, includeMetadata: true },
      run
    );
  }

  /**
   * The SQL escape hatch, used ONLY for read-only introspection and replay.
   *
   * pg-boss's public API has no way to LOOK at a queue: `fetch` is the worker primitive and it
   * claims what it returns (see `listForProject`). `getDb()` hands back the same adapter
   * pg-boss itself runs on, so this adds no second connection and no second pool.
   */
  private async query<T>(text: string, values: unknown[] = []): Promise<T[]> {
    const db = this.boss.getDb();
    const result = await db.executeSql(text, values);
    return ((result?.rows ?? []) as unknown) as T[];
  }

  /**
   * Creates a queue together with its dead-letter queue — docs/26_DECISIONS.md ADR-072.
   *
   * WHAT WAS MISSING. `registerWorker`'s docstring claimed a job "eventually dead-letters once
   * retries are exhausted". It did not, and could not: pg-boss only dead-letters when a queue
   * names a `deadLetter` target, and no queue here named one. An exhausted job stopped at state
   * `failed`, was archived on the maintenance schedule and then deleted. For an ingestion or
   * scan job that is silent data loss — the document sits `scanning` forever and the evidence
   * of why is gone.
   *
   * The DLQ is created first because pg-boss puts a real foreign key on the column; reversing
   * the order fails at boot rather than silently skipping the wiring.
   */
  async ensureQueueWithDeadLetter(name: string, retryPolicy: QueueSetupOptions = {}): Promise<string> {
    const deadLetter = deadLetterNameFor(name);
    // No retries on the DLQ itself: nothing consumes it automatically, and a retry policy on a
    // queue with no worker would only produce churn.
    await this.ensureQueue(deadLetter, { retryLimit: 0 });
    await this.ensureQueue(name, { ...retryPolicy, deadLetter });
    return deadLetter;
  }

  /**
   * Pending work per queue — the source for the `queue_depth` gauge docs/20_OBSERVABILITY.md
   * §2.1 asks for ("alert if sustained growth").
   *
   * `created` and `retry` are the two states that mean "waiting for a worker". `active` is
   * deliberately excluded: counting work already in flight would mask the backlog the gauge
   * exists to reveal, since a saturated worker pool keeps `active` high and `created` is the
   * number that actually grows.
   *
   * Every ensured queue is reported, including the ones sitting at zero. A series that
   * disappears when a queue drains is indistinguishable at the alerting layer from a series
   * that disappears because the process died.
   */
  async queueDepths(): Promise<Record<string, number>> {
    const queues = [...this.ensuredQueues];
    if (queues.length === 0) return {};

    const rows = await this.query<{ name: string; depth: string | number }>(
      `select name, count(*) as depth
         from pgboss.job
        where name = any($1)
          and state in ('created', 'retry')
        group by name`,
      [queues]
    );

    const depths: Record<string, number> = Object.fromEntries(queues.map((name) => [name, 0]));
    for (const row of rows) depths[row.name] = Number(row.depth ?? 0);
    return depths;
  }

  /**
   * Jobs belonging to one project — docs/26_DECISIONS.md ADR-066, corrected in ADR-072.
   *
   * THIS USED TO STEAL JOBS. The first implementation called `boss.fetch()`, which is not a
   * read: it is the primitive `work()` polls with, and it transitions every job it returns to
   * `active`. So merely opening the jobs screen claimed the project's pending work into an API
   * process that would never run it; each job then sat active until `expireInSeconds` elapsed,
   * burning one retry, and a few refreshes could exhaust `retryLimit` and fail the job for
   * good. Confirmed against a real queue — `created` before the call, `active` after — not by
   * reading the types, which say nothing about it.
   *
   * It is a plain SELECT now. pg-boss has no notion of a tenant, so scope lives in the payload
   * (every job this platform enqueues carries `projectId`, ADR-049) and the predicate is applied
   * in SQL rather than by fetching everything and discarding — the fetch-then-check pattern the
   * whole authorization model exists to avoid.
   */
  async listForProject(
    projectId: string,
    options: { queue?: string; limit?: number; includeDeadLetter?: boolean } = {}
  ): Promise<ProjectJob[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    const queues = options.queue
      ? [options.queue]
      : [...this.ensuredQueues].filter((q) => options.includeDeadLetter || !isDeadLetterQueue(q));
    if (queues.length === 0) return [];

    const rows = await this.query<JobRow>(
      `select id, name, state, created_on, started_on, completed_on, retry_count, output
         from pgboss.job
        where name = any($1)
          and data->>'projectId' = $2
        order by created_on desc
        limit $3`,
      [queues, projectId, limit]
    );

    return rows.map((row) => ({
      id: row.id,
      queue: row.name,
      state: row.state,
      createdAt: toIso(row.created_on),
      startedAt: toIso(row.started_on),
      completedAt: toIso(row.completed_on),
      retryCount: Number(row.retry_count ?? 0),
      error: extractError(row.output),
    }));
  }

  /**
   * Jobs that exhausted their retries, with the reason they did — ADR-072.
   *
   * The dead-letter row carries the original payload but not the failure; the failure is on the
   * ORIGINAL job's `output`. Reporting a dead letter without saying why would leave an operator
   * as blind as having no DLQ at all, so the two are joined on the source id pg-boss records.
   *
   * OUTSTANDING ones only. `replayDeadLettered` completes the dead letter rather than deleting
   * it, so the incident survives in the archive — but a handled dead letter must not keep
   * appearing as work still to do, or the list stops being a to-do and becomes a log that
   * grows until nobody reads it.
   */
  async listDeadLetteredForProject(
    projectId: string,
    options: { queue?: string; limit?: number } = {}
  ): Promise<DeadLetteredJob[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    const sources = options.queue
      ? [options.queue]
      : [...this.ensuredQueues].filter((q) => !isDeadLetterQueue(q));
    const queues = sources.map(deadLetterNameFor);
    if (queues.length === 0) return [];

    const rows = await this.query<DeadLetterRow>(
      `select dl.id,
              dl.name,
              dl.created_on,
              dl.data,
              dl.source_id,
              dl.source_retry_count,
              src.output as failure
         from pgboss.job dl
         left join pgboss.job src on src.id = dl.source_id
        where dl.name = any($1)
          and dl.data->>'projectId' = $2
          and dl.state in ('created', 'retry')
        order by dl.created_on desc
        limit $3`,
      [queues, projectId, limit]
    );

    return rows.map((row) => ({
      id: row.id,
      deadLetterQueue: row.name,
      sourceQueue: sourceQueueNameFor(row.name),
      deadLetteredAt: toIso(row.created_on),
      payload: row.data,
      attempts: Number(row.source_retry_count ?? 0) + 1,
      error: extractError(row.failure),
    }));
  }

  /**
   * One dead letter's payload, for a caller that must price the work before re-running it —
   * docs/26_DECISIONS.md ADR-130.
   *
   * The replay route re-checks quota, and what a replay costs is written in the payload (which
   * audio generation, which scene). Same scoping and the same state predicate as the listing, so
   * a caller cannot use this to read another project's payloads or to price a job that is no
   * longer replayable.
   */
  async getDeadLettered(
    projectId: string,
    deadLetterQueue: string,
    jobId: string
  ): Promise<Record<string, unknown> | null> {
    if (!isDeadLetterQueue(deadLetterQueue)) return null;
    const [row] = await this.query<{ data: Record<string, unknown> }>(
      `select data from pgboss.job where name = $1 and id = $2 and data->>'projectId' = $3
         and state in ('created', 'retry')`,
      [deadLetterQueue, jobId, projectId]
    );
    return row?.data ?? null;
  }

  /**
   * Re-enqueues one dead-lettered job onto the queue it came from — ADR-072.
   *
   * A DLQ nothing can be replayed from is a graveyard, not a recovery tool. The common case is
   * a transient dependency (clamd not yet up, a provider outage) that outlived the retry
   * budget: once it is healthy, the right action is to run the original work again, unchanged.
   *
   * The dead letter is CANCELLED rather than deleted, so the record of the incident survives to
   * be archived. Not `complete()`: pg-boss only completes an `active` job, and a dead letter is
   * `created` — nothing works the DLQ — so completing it silently did nothing and the replayed
   * job stayed on the outstanding list forever. Found by the test below, not by inspection.
   *
   * The project predicate is checked before anything is written: a dead letter from another
   * project is reported exactly like one that does not exist.
   */
  async replayDeadLettered(projectId: string, deadLetterQueue: string, jobId: string): Promise<string | null> {
    /**
     * Only a DEAD-LETTER queue, and only a job still waiting on it — docs/26_DECISIONS.md ADR-130.
     *
     * The queue name arrived straight from the URL and was used unchecked, so "replay a dead
     * letter" also replayed anything on a LIVE queue. `sourceQueueNameFor` returns a name that is
     * not a `.dlq` unchanged, which made `image.generate` its own source: a completed image
     * generation could be re-sent to the live queue, and re-sent again, and again — `boss.cancel`
     * is a no-op on a job that is already `completed`, so nothing ever stopped it. One finished
     * job became an unbounded generator of paid work, through the route whose own comment says it
     * enqueues real spend.
     *
     * Both halves are needed. The name check stops a live queue being addressed at all; the state
     * predicate stops a dead letter that has already been replayed (and cancelled) from being
     * replayed a second time.
     */
    if (!isDeadLetterQueue(deadLetterQueue)) return null;

    /**
     * Consuming the dead letter IS the claim — docs/26_DECISIONS.md ADR-151.
     *
     * This was a SELECT, then a `send`, then a `cancel`, with nothing atomic between them: two
     * replays of one dead letter both read `state = 'created'`, both sent, and only then did
     * either cancel. Two paid jobs from one incident — and the queue's own docstring records
     * that pg-boss's default `standard` policy ignores `singletonKey`, so nothing deduplicated
     * them downstream either. The route has no serialisation of its own; it is behind a rate
     * limit of ten a minute, which bounds the damage and does not prevent it. The covering test
     * awaited the first replay before starting the second, so it could never see this.
     *
     * One statement now does the state change and returns the payload, so exactly one caller
     * can win: `state in ('created','retry')` is part of the UPDATE's predicate, and the second
     * concurrent replay matches no row and gets null. The job is cancelled BEFORE the work is
     * sent, which is the safe order — the failure mode becomes "an incident that was not
     * replayed", visible in the dead-letter list, rather than "paid work that ran twice".
     */
    const [row] = await this.query<{ data: Record<string, unknown> }>(
      `update pgboss.job set state = 'cancelled', completed_on = now()
         where name = $1 and id = $2 and data->>'projectId' = $3
           and state in ('created', 'retry')
       returning data`,
      [deadLetterQueue, jobId, projectId]
    );
    if (!row) return null;

    return await this.boss.send(sourceQueueNameFor(deadLetterQueue), row.data);
  }

  /**
   * Cancels every job of one project that has not started — docs/26_DECISIONS.md ADR-109.
   *
   * For account deletion. A queued image, video or document job for a project that no longer
   * exists would still run: it would call a paid provider for a deleted account, then fail at the
   * foreign key when it stored the result. Every queue is included, not only the ones this
   * process ensured — an API process need not have ensured the queues its workers consume — and so
   * are dead letters, which for a deleted project are incidents nobody can act on.
   *
   * Work that has already STARTED cannot be stopped from here. The asset stores remove any bytes
   * whose row cannot be written, so that case leaves nothing behind either.
   */
  async cancelPendingForProject(projectId: string): Promise<number> {
    const rows = await this.query<{ id: string; name: string }>(
      `select id, name from pgboss.job
        where data->>'projectId' = $1
          and state in ('created', 'retry')`,
      [projectId]
    );
    for (const row of rows) {
      await this.boss.cancel(row.name, row.id);
    }
    return rows.length;
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
