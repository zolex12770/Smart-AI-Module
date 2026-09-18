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
  const { task, nodes, activity } = useTaskEvents(taskId, initialTask, initialNodes);
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
          {/**
           * WHAT is being approved — docs/26_DECISIONS.md ADR-135.
           *
           * This card read `node.toolId` and `node.input`, which are the fields of a DECLARATIVE
           * `tool_call` node. A model-driven run parks a `reasoning` node instead: its `toolId` is
           * null and its `input` is the goal, so the card said "Tool call `undefined`" above a
           * copy of the original request and the approver pressed Approve knowing neither the
           * tool nor its arguments. An approval gate whose whole purpose is a human decision was
           * asking for that decision blind — on a destructive tool, which is the only kind that
           * reaches it.
           *
           * The pending call is persisted on the node (`output.pendingCall`) and is read first;
           * a declarative node still falls back to its own fields.
           */}
          {(() => {
            const pending = pendingCallOf(waitingApproval);
            return (
              <>
                <p className="page-subtitle">
                  {pending
                    ? "This run stopped to ask before running a tool that can change or destroy things (docs/13_SECURITY_ARCHITECTURE.md)."
                    : "A tool call requires human approval before it runs (docs/13_SECURITY_ARCHITECTURE.md)."}
                </p>
                <p style={{ margin: "6px 0" }}>
                  Tool: <code>{pending?.name ?? waitingApproval.toolId ?? "unknown"}</code>
                </p>
                {waitingApproval.output && typeof (waitingApproval.output as { reason?: unknown }).reason === "string" && (
                  <p className="page-subtitle">
                    Reason: {String((waitingApproval.output as { reason?: unknown }).reason)}
                  </p>
                )}
                <strong style={{ display: "block", marginTop: 8 }}>Arguments</strong>
                <pre className="mono">{JSON.stringify(pending?.arguments ?? waitingApproval.input, null, 2)}</pre>
                {(() => {
                  const queued = queuedCallsOf(waitingApproval).filter((c) => c.id !== pending?.id);
                  if (queued.length === 0) return null;
                  return (
                    <>
                      {/* The model asked for these in the same turn, after the gated one. They
                          run only if they are approved in their own right. */}
                      <strong style={{ display: "block", marginTop: 8 }}>
                        Also requested in this turn, not yet run
                      </strong>
                      <ul className="page-subtitle" style={{ margin: "4px 0 0 18px" }}>
                        {queued.map((c) => (
                          <li key={c.id}>
                            <code>{c.name}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  );
                })()}
              </>
            );
          })()}
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

      {activity.length > 0 && (
        <div className="card">
          {/* What the model is doing, as it does it (ADR-134). Before this a ten-minute run was
              a spinner and then an answer. */}
          <strong>Activity</strong>
          <div className="plan-steps" style={{ marginTop: 8 }}>
            {activity.map((entry, i) => (
              <div key={i} className="plan-step">
                {entry.kind === "tool_call" && (
                  <span style={{ flex: 1 }}>
                    Called <code>{entry.name}</code>
                    <span className="page-subtitle"> {JSON.stringify(entry.arguments)}</span>
                  </span>
                )}
                {entry.kind === "tool_result" && (
                  <span style={{ flex: 1 }}>
                    {entry.ok ? "Result" : "Failed"}
                    <span className="page-subtitle"> {entry.preview}</span>
                  </span>
                )}
                {entry.kind === "verification" && (
                  <span style={{ flex: 1 }}>
                    Verification {entry.ok ? "passed" : "failed"}
                    {entry.reason ? <span className="page-subtitle"> — {entry.reason}</span> : null}
                  </span>
                )}
              </div>
            ))}
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

/**
 * The tool call a parked run is asking about — docs/26_DECISIONS.md ADR-135.
 *
 * A model-driven run parks a `reasoning` node and persists the call on its output; a declarative
 * plan parks a `tool_call` node whose own fields describe it. The approval card has to read the
 * first and fall back to the second, because it used to read only the second and therefore showed
 * nothing at all for the model-driven case.
 */
function pendingCallOf(node: TaskNode): { id: string; name: string; arguments: Record<string, unknown> } | null {
  const raw = (node.output as { pendingCall?: unknown } | null | undefined)?.pendingCall;
  if (!raw || typeof raw !== "object") return null;
  const call = raw as { id?: unknown; name?: unknown; arguments?: unknown };
  if (typeof call.name !== "string") return null;
  return {
    id: typeof call.id === "string" ? call.id : "",
    name: call.name,
    arguments: (call.arguments ?? {}) as Record<string, unknown>,
  };
}

/** Every call from the parked turn that has not run, including the gated one (ADR-099). */
function queuedCallsOf(node: TaskNode): Array<{ id: string; name: string }> {
  const raw = (node.output as { pendingCalls?: unknown } | null | undefined)?.pendingCalls;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is { id?: unknown; name?: unknown } => Boolean(c) && typeof c === "object")
    .map((c) => ({
      id: typeof c.id === "string" ? c.id : "",
      name: typeof c.name === "string" ? c.name : "unknown",
    }));
}
