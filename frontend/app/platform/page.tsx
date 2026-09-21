"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/auth-client";
import { Can, RequireSession, SystemAdminOnly, useSession } from "../lib/session-context";
import { reconnectMcpServer } from "../lib/api";

/**
 * Platform operations — docs/26_DECISIONS.md ADR-066 (the API), ADR-072 (dead letters),
 * ADR-074 (this screen).
 *
 * The `/models`, `/providers`, `/tools`, `/mcp`, `/jobs` and `/admin` endpoints shipped with no
 * consumer whatsoever. An API nobody can reach without curl does not answer the questions it
 * was built to answer — "which model am I actually talking to, and is it real?", "did that
 * upload ever get scanned?" — for the person who needs to ask them.
 *
 * Everything here reports degraded states explicitly rather than hiding them. A missing row
 * looks like a bug; an explicit "unavailable" looks like a decision, and only one of those is
 * actionable.
 */

interface ModelRow {
  provider: string;
  model: string;
  /** An object, not a list of names — see `ProviderCapabilities` in shared. */
  capabilities?: { streaming?: boolean; toolCalling?: boolean; vision?: boolean; contextWindow?: number | null };
  isMock?: boolean;
  available?: boolean;
}

interface ToolRow {
  id: string;
  name: string;
  enabled: boolean;
  riskLevel: string;
  requiresApproval: string;
  /** `{ kind: "native" | "mcp", serverId, serverVersion }` — the route calls it `origin`. */
  origin?: { kind?: string; serverId?: string | null };
}

/**
 * The field names the route ACTUALLY sends — docs/26_DECISIONS.md ADR-154.
 *
 * This said `error`, and `/api/v1/mcp` returns `lastError`. `grep -c lastError` on this file
 * returned 0, so `server.error` was `undefined` on every row and the ternary rendering it was
 * always false: an operator could watch a server sit in `failed` with no way to learn why, on
 * the screen built to tell them. Two more fields had the same shape — `ModelRow.capabilities`
 * typed as `string[]` against an object, and a `ToolRow.source` the route never sends — and all
 * three were invisible because a missing field renders as nothing rather than as an error.
 */
interface McpRow {
  id: string;
  status: string;
  transport?: string;
  toolCount?: number;
  lastError?: string | null;
  /**
   * Tools this server offered that the platform declined to register — ADR-154.
   *
   * The route's own comment says these are returned "so an operator can see" them, and no screen
   * read the field. A refusal is the case an operator most needs to know about: the server is
   * connected and healthy, and some of what it offers is deliberately not available.
   */
  refusedToolIds?: string[];
}

interface JobRow {
  id: string;
  queue: string;
  state: string;
  createdAt: string | null;
  retryCount: number;
  error: string | null;
}

interface DeadLetterRow {
  id: string;
  deadLetterQueue: string;
  sourceQueue: string;
  deadLetteredAt: string | null;
  attempts: number;
  error: string | null;
}

/** `GET /api/v1/admin/health` — system administrators only; everyone else gets a 404. */
interface HealthResponse {
  status: string;
  checks: Record<string, string | boolean>;
}

export default function PlatformPage() {
  return (
    <RequireSession>
      <PlatformView />
    </RequireSession>
  );
}

function PlatformView() {
  const { projectId } = useSession();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [mcp, setMcp] = useState<McpRow[]>([]);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [deadLettered, setDeadLettered] = useState<DeadLetterRow[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  // Distinguishes "you may not see this" from "this is broken" — see the Health section.
  const [healthRestricted, setHealthRestricted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // One settled batch rather than a chain: a platform screen whose MCP section is broken
      // should still tell you which models are configured. Failing the whole page because one
      // subsystem is down is the opposite of what an operations view is for.
      const [modelsRes, toolsRes, mcpRes, jobsRes, dlqRes, healthRes] = await Promise.allSettled([
        apiFetch<{ models: ModelRow[] }>("/api/v1/models"),
        apiFetch<{ tools: ToolRow[] }>("/api/v1/tools"),
        apiFetch<{ servers: McpRow[] }>("/api/v1/mcp"),
        apiFetch<{ jobs: JobRow[] }>("/api/v1/jobs"),
        apiFetch<{ deadLettered: DeadLetterRow[] }>("/api/v1/jobs/dead-letter"),
        apiFetch<HealthResponse>("/api/v1/admin/health"),
      ]);

      if (modelsRes.status === "fulfilled") setModels(modelsRes.value.models ?? []);
      if (toolsRes.status === "fulfilled") setTools(toolsRes.value.tools ?? []);
      if (mcpRes.status === "fulfilled") setMcp(mcpRes.value.servers ?? []);
      if (jobsRes.status === "fulfilled") setJobs(jobsRes.value.jobs ?? []);
      if (dlqRes.status === "fulfilled") setDeadLettered(dlqRes.value.deadLettered ?? []);
      if (healthRes.status === "fulfilled") {
        setHealth(healthRes.value);
        setHealthRestricted(false);
      } else {
        // The admin endpoints answer 404 rather than 403 to a non-administrator, deliberately:
        // confirming an endpoint exists is itself a disclosure (ADR-049). So a 404 here is the
        // EXPECTED answer for an ordinary member, not a fault, and the screen must not shout
        // about it — nor quietly render a blank section that reads as broken.
        setHealthRestricted(true);
      }

      // Health is excluded: its failure is a permission outcome, not an outage.
      const firstFailure = [modelsRes, toolsRes, mcpRes, jobsRes, dlqRes].find(
        (r) => r.status === "rejected"
      );
      setError(
        firstFailure && firstFailure.status === "rejected"
          ? `Some sections could not load: ${
              firstFailure.reason instanceof Error ? firstFailure.reason.message : "unknown error"
            }`
          : null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load platform status.");
    }
  }, []);

  /**
   * Reconnects a dropped MCP server — ADR-144.
   *
   * Declared after `load` so the dependency is real rather than suppressed: the listing is
   * refreshed afterwards, and a reconnect that failed leaves the server visibly `failed`, which
   * is a better answer than a message about the attempt.
   */
  const reconnect = useCallback(
    async (id: string) => {
      setReconnecting(id);
      try {
        await reconnectMcpServer(id);
      } catch {
        /* the refreshed listing below reports the server's real state */
      } finally {
        setReconnecting(null);
        await load();
      }
    },
    [load]
  );

  useEffect(() => {
    void load();
  }, [load, projectId]);

  const replay = async (row: DeadLetterRow) => {
    setBusy(row.id);
    try {
      await apiFetch(`/api/v1/jobs/dead-letter/${encodeURIComponent(row.deadLetterQueue)}/${row.id}/replay`, {
        method: "POST",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replay failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1>Platform</h1>
        <button type="button" className="btn btn-secondary" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <h2>Health</h2>
      {health ? (
        <>
          <p>
            Overall: <strong>{health.status}</strong>
          </p>
          <ul>
            {Object.entries(health.checks).map(([key, value]) => (
              <li key={key}>
                <strong>{key}</strong>: {typeof value === "boolean" ? (value ? "yes" : "no") : value}
              </li>
            ))}
          </ul>
        </>
      ) : healthRestricted ? (
        <p>Readiness details are visible to system administrators only.</p>
      ) : (
        <p>Health could not be read.</p>
      )}

      <h2>Models</h2>
      {models.length === 0 ? (
        <p>No models configured.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Model</th>
              <th scope="col">Real?</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={`${m.provider}:${m.model}`}>
                <td>{m.provider}</td>
                <td>{m.model}</td>
                {/* The single most important cell on this page: a mock that looks real is the
                    failure mode the whole honesty rule exists to prevent. */}
                <td>{m.isMock ? "MOCK — not a real model" : "real"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>MCP servers</h2>
      {mcp.length === 0 ? (
        <p>No MCP servers configured.</p>
      ) : (
        <ul>
          {mcp.map((server) => (
            <li key={server.id}>
              <strong>{server.id}</strong> — {server.status}
              {typeof server.toolCount === "number" ? ` (${server.toolCount} tools)` : ""}
              {server.lastError ? <span className="auth-error"> {server.lastError}</span> : null}
              {server.refusedToolIds && server.refusedToolIds.length > 0 ? (
                <div className="page-subtitle">
                  {server.refusedToolIds.length} tool(s) refused and not registered:{" "}
                  <code>{server.refusedToolIds.join(", ")}</code>
                </div>
              ) : null}
              {/**
               * Reconnect — ADR-144. The route existed with no caller anywhere, so an operator
               * could watch a server sit in `failed` and do nothing about it. Inside the guard
               * because a reconnect re-registers tools for every tenant, which is why the route
               * is system-admin only.
               */}
              <SystemAdminOnly>
                {" "}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={reconnecting === server.id}
                  onClick={() => void reconnect(server.id)}
                >
                  {reconnecting === server.id ? "Reconnecting…" : "Reconnect"}
                </button>
              </SystemAdminOnly>
            </li>
          ))}
        </ul>
      )}

      <h2>Tools</h2>
      {tools.length === 0 ? (
        <p>No tools registered.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Enabled</th>
              <th scope="col">Risk</th>
              <th scope="col">Approval</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <tr key={tool.id}>
                {/* Both, deliberately: the display name is what a person recognises, the id is
                    what appears in `tool.call` spans, in MCP configuration and in the enable
                    endpoint's path — an operations screen that shows only the friendly name
                    cannot be used to act on what it shows. */}
                <td>
                  {tool.name || tool.id}
                  <br />
                  <code>{tool.id}</code>
                </td>
                <td>{tool.enabled ? "yes" : "no"}</td>
                <td>{tool.riskLevel}</td>
                <td>{tool.requiresApproval}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Jobs</h2>
      {jobs.length === 0 ? (
        <p>No jobs for this project.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Queue</th>
              <th scope="col">State</th>
              <th scope="col">Retries</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.queue}</td>
                <td>{job.state}</td>
                <td>{job.retryCount}</td>
                <td>{job.error ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
        Separate from Jobs on purpose (ADR-072): a dead letter is not work in progress, it is an
        incident with an owner and an action. Mixing the two buries the handful of things that
        need attention among the many that do not.
      */}
      <h2>Dead-lettered work</h2>
      {deadLettered.length === 0 ? (
        <p>Nothing has been given up on.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Queue</th>
              <th scope="col">Attempts</th>
              <th scope="col">Why it stopped</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {deadLettered.map((row) => (
              <tr key={row.id}>
                <td>{row.sourceQueue}</td>
                <td>{row.attempts}</td>
                <td>{row.error ?? "no reason recorded"}</td>
                <td>
                  {/* ADR-154: replay re-runs the original PAID work and the route requires
                      `project:write`, so a viewer pressing this got a 403 from a control that
                      looked available to them. */}
                  <Can
                    permission="project:write"
                    fallback={<span className="page-subtitle">a project editor can replay this</span>}
                  >
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy === row.id}
                      onClick={() => void replay(row)}
                    >
                      {busy === row.id ? "Replaying…" : "Replay"}
                    </button>
                  </Can>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
