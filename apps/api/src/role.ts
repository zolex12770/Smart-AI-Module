/**
 * Which responsibilities a process takes on, by its `ROLE` (docs/26_DECISIONS.md ADR-039).
 * One image, one entrypoint, three roles — the standard Cloud Run pattern for splitting an
 * API from its background workers without duplicating the whole composition root into a
 * second `apps/worker` package (docs/17_BACKEND_ARCHITECTURE.md's original sketch), which
 * would have meant maintaining two verbatim copies of the database/provider/repository wiring.
 *
 * - `all` (default): today's local-dev topology — HTTP server and job workers in one process.
 *   Required locally, since PGlite (ADR-025) only allows one process per data directory.
 * - `api`: HTTP server, agent engine, MCP — enqueues jobs but never processes them.
 * - `worker`: pg-boss job workers only — no HTTP listener at all (a Cloud Run worker pool
 *   has no ingress and performs no health checks, so binding a port would be pure waste).
 *
 * Kept as a pure decision table, separate from index.ts, so the mapping itself is unit-
 * testable without booting a database.
 */
export type AppRole = "all" | "api" | "worker";

export interface RoleResponsibilities {
  /** Start the Fastify listener, the agent engine, and the MCP connection. */
  http: boolean;
  /** Register pg-boss job workers (the queue itself is always started — the API role must
   * still be able to *enqueue*, and pg-boss requires `start()` before `send()`). */
  workers: boolean;
}

export function roleRuns(role: AppRole): RoleResponsibilities {
  switch (role) {
    case "api":
      return { http: true, workers: false };
    case "worker":
      return { http: false, workers: true };
    case "all":
      return { http: true, workers: true };
  }
}
