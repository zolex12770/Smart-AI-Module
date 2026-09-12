"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Task, TaskNode } from "@ai-platform/shared";
import { getTask } from "../lib/api";
import { RequireSession } from "../lib/session-context";

/**
 * Client-side load of a task and its nodes, shared by `/agent/[id]` and `/coding/[id]`.
 *
 * It exists because the fetch has to happen in the browser: `getTask` goes through `apiFetch`,
 * which needs the CSRF cookie, the httpOnly session cookie and the project id in
 * `localStorage` — three things that exist only on the client (ADR-049). Both detail routes
 * used to do this fetch in a server render and crashed for exactly that reason.
 *
 * `RequireSession` wraps it rather than the page body, and the order matters: the project id
 * `apiFetch` sends is re-validated by `SessionProvider` against what the account can actually
 * see, so fetching before the session resolves would send a stale project from a previous
 * login — the request either 403s or, worse, names a project the user no longer belongs to.
 * Children only mount once there is a validated session and a selected project.
 */
export function TaskDetailLoader({
  taskId,
  children,
}: {
  taskId: string;
  children: (task: Task, nodes: TaskNode[]) => ReactNode;
}) {
  return (
    <RequireSession>
      <TaskDetailFetch taskId={taskId}>{children}</TaskDetailFetch>
    </RequireSession>
  );
}

function TaskDetailFetch({
  taskId,
  children,
}: {
  taskId: string;
  children: (task: Task, nodes: TaskNode[]) => ReactNode;
}) {
  const [data, setData] = useState<{ task: Task; nodes: TaskNode[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await getTask(taskId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <section className="page">
        <h1>Task</h1>
        {/* A failed load is shown, not swallowed: the task page is where a user goes when
            something has gone wrong, so a blank screen here is the least useful answer. */}
        <p className="auth-error" role="alert">
          {error}
        </p>
        <button type="button" className="btn" onClick={() => void load()}>
          Retry
        </button>
      </section>
    );
  }
  // Nothing renders until the task is loaded: `TaskDetail` seeds its live SSE state from this
  // first snapshot, so handing it a placeholder task would start the stream from fiction.
  if (!data) return <p className="page-state">Loading task…</p>;
  return <>{children(data.task, data.nodes)}</>;
}
