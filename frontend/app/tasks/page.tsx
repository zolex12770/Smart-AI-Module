"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Task, TaskType } from "@ai-platform/shared";
import {
  createTask,
  listTasks,
  listTools,
  listWorkspaceFiles,
  setToolEnabled,
  writeWorkspaceFile,
  type ToolRow,
  type WorkspaceFile,
} from "../lib/api";
import { StatusBadge } from "../lib/status-badge";
import { useSession } from "../lib/session-context";

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
        {(taskType === "fix_failing_test" || taskType === "autonomous") && <WorkspaceSeed />}
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
  /**
   * Only a system administrator can actually enable a tool — ADR-089, found by running it.
   *
   * `POST /api/v1/tools/:id/enable` mutates a PROCESS-WIDE registry: `setEnabled` takes no
   * project, so enabling an MCP-discovered tool enables it for every tenant in the deployment.
   * ADR-089 moved it to system-admin for exactly that reason, and non-admins get a 404 rather
   * than a 403 (confirming an endpoint exists is itself a disclosure).
   *
   * The first version of this card offered the button to everyone, and a project user pressing
   * it got an unexplained "Not found." That is the same class of defect this card was written to
   * fix — a control that cannot do what it appears to offer — so the button is shown only to
   * someone who can use it, and everyone else is told who can. The component test could not have
   * caught it: it mocks the API, and the API is where the refusal lives.
   */
  const { user } = useSession();
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
        until someone turns it on (docs/10 §3.2).
        {!user?.isSystemAdmin && (
          <>
            {" "}
            Enabling one affects every project in this deployment, so it is a system administrator&apos;s decision
            (docs/26_DECISIONS.md ADR-089) — ask one to enable the tool below.
          </>
        )}
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
          {user?.isSystemAdmin ? (
            <button
              type="button"
              className={tool.enabled ? "btn btn-secondary" : "btn"}
              disabled={busy === tool.id}
              onClick={() => void toggle(tool)}
            >
              {tool.enabled ? "Disable" : "Enable"}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Putting something in the workspace for the agent to work on — docs/26_DECISIONS.md ADR-142.
 *
 * The coding agent reads, writes, searches and runs commands inside a per-project workspace, and
 * nothing could put anything into it — no route mentioned a workspace at all, and the Files
 * screen's upload writes to the asset store, which the filesystem tools cannot see. So
 * "fix the failing test" had no test to fix: the agent's first action was always to discover an
 * empty directory, and the capability could not be started at all.
 *
 * Writing named files rather than cloning a repository is deliberate and is explained on the
 * route: a clone means outbound access to an arbitrary URL, credentials for private repositories,
 * and unbounded data on disk — three larger decisions than this one.
 */
function WorkspaceSeed() {
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listWorkspaceFiles()
      .then((r) => setFiles(r.files))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  async function add() {
    if (!path.trim() || !content) return;
    setBusy(true);
    setError(null);
    try {
      await writeWorkspaceFile(path.trim(), content);
      setPath("");
      setContent("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <strong>The agent&apos;s workspace</strong>
      <p className="page-subtitle">
        The directory this task will read, write and run commands in. An uploaded document is not
        the same thing — that goes to file storage, which the agent&apos;s tools cannot see.
      </p>
      {error && <p className="error-text">{error}</p>}
      {files?.length === 0 && (
        <p className="empty-state">
          Empty. A coding task needs at least the file it is meant to fix, or it will find nothing
          to work on.
        </p>
      )}
      {files?.map((f) => (
        <div key={f.path} className="mono" style={{ fontSize: 12 }}>
          {f.path} <span className="page-subtitle">({f.sizeBytes} bytes)</span>
        </div>
      ))}
      <div className="form-row" style={{ marginTop: 8 }}>
        <label style={{ flex: 1, minWidth: 180 }}>
          File path
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="src/sum.test.ts" />
        </label>
      </div>
      <label style={{ display: "block" }}>
        Contents
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          style={{ width: "100%", fontFamily: "var(--font-mono, monospace)" }}
          placeholder="the file the agent should work on"
        />
      </label>
      <button type="button" className="btn btn-secondary" disabled={busy || !path.trim() || !content} onClick={() => void add()}>
        {busy ? "Adding…" : "Add file to workspace"}
      </button>
    </div>
  );
}
