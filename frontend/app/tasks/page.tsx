"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Task, TaskType } from "@ai-platform/shared";
import { createTask, listTasks } from "../lib/api";
import { StatusBadge } from "../lib/status-badge";

const TASK_TYPES: { value: TaskType; label: string; fields: string[] }[] = [
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
        {taskType === "mcp_read_and_summarize" && (
          <p className="page-subtitle">
            Note: the MCP filesystem tool is registered disabled by default (docs/10 §3.2) — enable it first via{" "}
            <code>POST /api/v1/tools/mcp.reference-filesystem.read_text_file/enable</code>, or this task will fail with
            a real, honest "tool disabled" error.
          </p>
        )}
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
