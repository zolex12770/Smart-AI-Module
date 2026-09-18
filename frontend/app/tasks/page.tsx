"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Task, TaskType } from "@ai-platform/shared";
import { createTask, listTasks, listTools, setToolEnabled, type ToolRow } from "../lib/api";
import { StatusBadge } from "../lib/status-badge";

const TASK_TYPES: { value: TaskType; label: string; fields: string[]; hint?: string }[] = [
  /**
   * The model-driven agent, first — docs/26_DECISIONS.md ADR-136.
   *
   * ADR-064 unified the deterministic task graph with the model-driven reasoning loop, and the
   * whole point of the platform is the second one: the model decides what to do, turn by turn,
   * with real tools. This list omitted it. Every option here was a hardcoded recipe, so from the
   * interface the product WAS the workflow runner that the audit had already called it — the
   * autonomous engine existed, was tested, and could be reached only by `POST`ing JSON by hand.
   */
  {
    value: "autonomous",
    label: "Autonomous agent — the model chooses the tools",
    fields: ["goal"],
    hint: "Describe the outcome, not the steps. The model plans, calls tools, reads what comes back, and stops to ask before anything destructive.",
  },
  { value: "echo_chat", label: "Echo chat (single model call)", fields: ["message"] },
  { value: "read_and_summarize", label: "Read & summarize (native tool)", fields: ["path", "question"] },
  { value: "mcp_read_and_summarize", label: "Read & summarize (via MCP)", fields: ["path", "question"] },
  { value: "delete_sandbox_file", label: "Delete sandbox file (approval-gated)", fields: ["path"] },
  { value: "fix_failing_test", label: "Fix failing test (coding agent)", fields: ["testDir", "testFile"] },
  { value: "answer_from_documents", label: "Answer from documents (RAG)", fields: ["question"] },
];

function detailHref(task: Task): string {
  return task.taskType === "fix_failing_test" ? `/coding/${task.id}` : `/agent/${task.id}`;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskType, setTaskType] = useState<TaskType>("echo_chat");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function refresh() {
    setLoading(true);
    listTasks()
      .then((r) => setTasks(r.tasks))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, []);

  const activeType = TASK_TYPES.find((t) => t.value === taskType)!;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const input: Record<string, unknown> = {};
      for (const field of activeType.fields) {
        if (fieldValues[field]) input[field] = fieldValues[field];
      }
      const { task } = await createTask(taskType, input);
      setFieldValues({});
      refresh();
      window.location.href = detailHref(task);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Agent tasks</h1>
          <p className="page-subtitle">
            The state-machine-driven task engine (docs/11_AGENT_LOOP.md). Every task type below runs against real
            tool calls and a real (mock-by-default) model — see docs/26_DECISIONS.md ADR-018.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={handleCreate}>
        <div className="form-row">
          <label>
            Task type
            <select value={taskType} onChange={(e) => setTaskType(e.target.value as TaskType)}>
              {TASK_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {activeType.fields.map((field) => (
            <label key={field}>
              {field}
              <input
                value={fieldValues[field] ?? ""}
                onChange={(e) => setFieldValues((prev) => ({ ...prev, [field]: e.target.value }))}
                placeholder={field}
              />
            </label>
          ))}
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? "Starting…" : "Start task"}
          </button>
        </div>
        {activeType.hint && <p className="page-subtitle">{activeType.hint}</p>}
        {taskType === "mcp_read_and_summarize" && <McpToolGate />}
      </form>

      {error && <p className="error-text">{error}</p>}
      {loading && <p className="empty-state">Loading…</p>}
      {!loading && tasks.length === 0 && <p className="empty-state">No tasks yet — start one above.</p>}

      <div className="card-list">
        {tasks.map((task) => (
          <Link key={task.id} href={detailHref(task)} className="card card-row" style={{ textDecoration: "none", color: "inherit" }}>
            <div>
              <strong>{task.taskType}</strong>
              <div className="page-subtitle">{new Date(task.createdAt).toLocaleString()}</div>
            </div>
            <StatusBadge status={task.state} />
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * Turning on a tool the platform deliberately shipped off — docs/26_DECISIONS.md ADR-136.
 *
 * MCP-discovered tools are registered DISABLED (ADR-083) because a server can advertise anything,
 * so nothing it offers runs until a person decides it should. That decision was reachable only
 * from a terminal: nothing in the app could enable a tool, and this screen's own note told the
 * user to send a POST by hand — in a product whose point is that a human stays in control of what
 * an agent may do. A governance gate nobody can operate is not a gate.
 */
function McpToolGate() {
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listTools()
      .then((r) => setTools(r.tools.filter((t) => t.origin.kind === "mcp")))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  async function toggle(tool: ToolRow) {
    setBusy(tool.id);
    setError(null);
    try {
      await setToolEnabled(tool.id, !tool.enabled);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="error-text">{error}</p>;
  if (!tools) return <p className="page-subtitle">Checking which MCP tools are enabled…</p>;
  if (tools.length === 0) {
    return (
      <p className="page-subtitle">
        No MCP server is configured, so this task has no tool to call. Set <code>MCP_SERVERS</code> and restart the
        API.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <p className="page-subtitle">
        MCP tools are registered disabled on purpose — a server can advertise anything, so nothing it offers runs
        until you turn it on (docs/10 §3.2).
      </p>
      {tools.map((tool) => (
        <div key={tool.id} className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
          <span>
            <code>{tool.id}</code>
            <span className="page-subtitle">
              {" "}
              {tool.enabled ? "enabled" : "disabled"} · {tool.riskLevel} risk
            </span>
          </span>
          <button
            type="button"
            className={tool.enabled ? "btn btn-secondary" : "btn"}
            disabled={busy === tool.id}
            onClick={() => void toggle(tool)}
          >
            {tool.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      ))}
    </div>
  );
}
