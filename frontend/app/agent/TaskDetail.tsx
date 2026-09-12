"use client";

import { useState } from "react";
import type { Task, TaskNode } from "@ai-platform/shared";
import { approveNode, cancelTask, rejectNode } from "../lib/api";
import { badgeClass, StatusBadge } from "../lib/status-badge";
import { useTaskEvents } from "../lib/use-task-events";

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const NODE_ICON: Record<string, string> = {
  completed: "✓",
  failed: "✗",
  cancelled: "–",
  skipped: "–",
};

export default function TaskDetail({
  taskId,
  initialTask,
  initialNodes,
  variant = "agent",
}: {
  taskId: string;
  initialTask: Task;
  initialNodes: TaskNode[];
  variant?: "agent" | "coding";
}) {
  const { task, nodes } = useTaskEvents(taskId, initialTask, initialNodes);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);

  const waitingApproval = nodes.find((n) => n.status === "waiting_approval");

  async function handleApprove(nodeId: string) {
    setBusyNodeId(nodeId);
    try {
      await approveNode(taskId, nodeId);
    } finally {
      setBusyNodeId(null);
    }
  }

  async function handleReject(nodeId: string) {
    setBusyNodeId(nodeId);
    try {
      await rejectNode(taskId, nodeId);
    } finally {
      setBusyNodeId(null);
    }
  }

  async function handleCancel() {
    await cancelTask(taskId);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>
            {variant === "coding" ? "Coding agent" : "Agent task"} — {task.taskType}
          </h1>
          <p className="page-subtitle">{taskId}</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge status={task.state} />
          {!TERMINAL_STATES.has(task.state) && (
            <button className="btn btn-danger" onClick={handleCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <strong>Request</strong>
        <pre className="mono">{JSON.stringify(task.input, null, 2)}</pre>
      </div>

      {waitingApproval && (
        <div className="card" style={{ borderColor: "var(--warning)" }}>
          <strong>Waiting for approval</strong>
          <p className="page-subtitle">
            Tool call <code>{waitingApproval.toolId}</code> requires human approval before it runs (docs/13_SECURITY_ARCHITECTURE.md).
          </p>
          <pre className="mono">{JSON.stringify(waitingApproval.input, null, 2)}</pre>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn" disabled={busyNodeId === waitingApproval.id} onClick={() => handleApprove(waitingApproval.id)}>
              Approve
            </button>
            <button className="btn btn-danger" disabled={busyNodeId === waitingApproval.id} onClick={() => handleReject(waitingApproval.id)}>
              Reject
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <strong>Plan</strong>
        <div className="plan-steps" style={{ marginTop: 8 }}>
          {nodes.map((node, i) => (
            <div key={node.id} className="plan-step">
              <span className={badgeClass(node.status)} style={{ minWidth: 20, textAlign: "center" }}>
                {NODE_ICON[node.status] ?? i + 1}
              </span>
              <span style={{ flex: 1 }}>
                {node.kind === "tool_call" ? `Tool: ${node.toolId}` : `Model call${node.modelProvider ? ` (${node.modelProvider})` : ""}`}
              </span>
              <StatusBadge status={node.status} />
            </div>
          ))}
        </div>
      </div>

      {variant === "coding" && <CodingTabs nodes={nodes} />}

      {nodes.some((n) => n.errorMessage) && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <strong>Errors</strong>
          {nodes
            .filter((n) => n.errorMessage)
            .map((n) => (
              <p key={n.id} className="error-text">
                {n.toolId ?? n.modelProvider ?? n.id}: {n.errorMessage}
              </p>
            ))}
        </div>
      )}

      {task.output && (
        <div className="card">
          <strong>Final result</strong>
          <pre className="mono">{JSON.stringify(task.output, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function CodingTabs({ nodes }: { nodes: TaskNode[] }) {
  const [tab, setTab] = useState<"commands" | "files">("commands");
  const commandNodes = nodes.filter((n) => n.toolId === "terminal.run_command");
  const fixNodes = nodes.filter((n) => n.toolId === "code.apply_literal_fix");

  return (
    <div className="card">
      <div className="tabs">
        <span className={`tab ${tab === "commands" ? "active" : ""}`} onClick={() => setTab("commands")}>
          Commands run ({commandNodes.length})
        </span>
        <span className={`tab ${tab === "files" ? "active" : ""}`} onClick={() => setTab("files")}>
          Files changed ({fixNodes.length})
        </span>
      </div>

      {tab === "commands" &&
        (commandNodes.length === 0 ? (
          <p className="empty-state">No commands run yet.</p>
        ) : (
          commandNodes.map((n) => {
            const output = n.output as { exitCode?: number; stdout?: string; stderr?: string } | null;
            return (
              <div key={n.id} style={{ marginBottom: 12 }}>
                <div className="mono">
                  $ {String(n.input.command ?? "")} {(n.input.args as string[] | undefined)?.join(" ") ?? ""}
                </div>
                {output && (
                  <>
                    <div className="page-subtitle">exit code: {output.exitCode}</div>
                    {output.stdout && <pre className="mono">{output.stdout}</pre>}
                    {output.stderr && <pre className="mono error-text">{output.stderr}</pre>}
                  </>
                )}
              </div>
            );
          })
        ))}

      {tab === "files" &&
        (fixNodes.length === 0 ? (
          <p className="empty-state">No file changes yet.</p>
        ) : (
          fixNodes.map((n) => (
            <div key={n.id} style={{ marginBottom: 12 }}>
              <div className="mono">{String(n.input.path ?? "")}</div>
              <div className="mono error-text">- {String(n.input.find ?? "")}</div>
              <div className="mono" style={{ color: "var(--success)" }}>
                + {String(n.input.replace ?? "")}
              </div>
            </div>
          ))
        ))}
    </div>
  );
}
