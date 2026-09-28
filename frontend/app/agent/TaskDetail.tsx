"use client";

import { useState } from "react";
import type { Task, TaskNode } from "@ai-platform/shared";
import { approveNode, cancelTask, reconcileNode, rejectNode } from "../lib/api";
import { Can } from "../lib/session-context";
import { badgeClass, StatusBadge } from "../lib/status-badge";
import { useTaskEvents, type TaskActivity } from "../lib/use-task-events";

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
  const { task, nodes, activity, live } = useTaskEvents(taskId, initialTask, initialNodes);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  /**
   * A refusal has to be VISIBLE — docs/26_DECISIONS.md ADR-148.
   *
   * All three handlers were `await` with no catch, invoked as floating promises from `onClick`.
   * A 403 (a viewer pressing Approve), a 404 (someone else decided this node first) or a dropped
   * connection became an unhandled rejection in the console and nothing at all on screen: the
   * card did not move and did not say why. ADR-123 fixed this exact silent-failure shape for
   * chat send, on the screen where the stakes are lowest; this is the approval gate on
   * destructive tool calls, which is the only kind that reaches it.
   */
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error` so a refused Cancel is reported beside the Cancel button rather than
  // inside the approval card, which may be far down the page or absent entirely.
  const [cancelError, setCancelError] = useState<string | null>(null);

  /**
   * The live feed while it is running, the persisted log afterwards — ADR-134, fixed by ADR-148.
   *
   * The events endpoint replays `state` and `node`, never activity, so a task opened after it
   * finished had an empty feed and the Activity card simply did not render. The rows were on the
   * node the whole time — `persistedActivityOf` was already written — but only the coding
   * variant read them, so the autonomous screen, the primary one, showed an operator the plan
   * and the answer and no record of which tools ran with what arguments. That is the black box
   * ADR-134 says it closed.
   */
  const entries = activity.length > 0 ? activity : persistedActivityOf(nodes);

  const waitingApproval = nodes.find((n) => n.status === "waiting_approval");
  const needsReconciliation = nodes.find((n) => n.status === "needs_reconciliation");

  async function handleApprove(nodeId: string) {
    setBusyNodeId(nodeId);
    setError(null);
    try {
      await approveNode(taskId, nodeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyNodeId(null);
    }
  }

  async function handleReject(nodeId: string) {
    setBusyNodeId(nodeId);
    setError(null);
    try {
      await rejectNode(taskId, nodeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyNodeId(null);
    }
  }

  async function handleReconcile(nodeId: string, decision: "retry" | "abandon") {
    setBusyNodeId(nodeId);
    setError(null);
    try {
      await reconcileNode(taskId, nodeId, decision);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyNodeId(null);
    }
  }

  async function handleCancel() {
    setCancelError(null);
    try {
      await cancelTask(taskId);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    }
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
            // `agent:run`, per docs/API.md. A viewer can open this page — the task is readable
            // with `project:read` — and pressing Cancel would 403.
            <Can permission="agent:run">
              <button className="btn btn-danger" onClick={handleCancel}>
                Cancel
              </button>
            </Can>
          )}
        </div>
      </div>

      {/* ADR-159 — EventSource reconnects by itself, so a dropped stream is not the same as a
          stopped one, and a screen that has quietly frozen must say so rather than look current. */}
      {live !== "live" && !TERMINAL_STATES.has(task.state) && (
        <p className="page-subtitle">
          {live === "reconnecting"
            ? "Live updates dropped — reconnecting…"
            : "Live updates disconnected. Reload to see the current state."}
        </p>
      )}
      {cancelError && <p className="error-text">{cancelError}</p>}

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
          <Can
            permission="agent:approve"
            fallback={
              // Named rather than hidden: a viewer who sees a parked run needs to know it is
              // waiting on somebody, not that the screen is broken.
              <p className="page-subtitle" style={{ marginTop: 8 }}>
                Waiting for a project editor or admin to decide — your role can read this task but
                not approve or reject it.
              </p>
            }
          >
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn" disabled={busyNodeId === waitingApproval.id} onClick={() => handleApprove(waitingApproval.id)}>
                Approve
              </button>
              <button className="btn btn-danger" disabled={busyNodeId === waitingApproval.id} onClick={() => handleReject(waitingApproval.id)}>
                Reject
              </button>
            </div>
          </Can>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}

      {needsReconciliation && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          {/**
           * A node the engine refuses to restart on its own — docs/26_DECISIONS.md ADR-148.
           *
           * A mutating tool call, or a whole model-driven run, that a restart caught in flight
           * cannot be repeated safely: the engine does not know whether it completed. It parked
           * here and the task PAUSED — and nothing could move either again, in the engine, the
           * API or this screen. A pause a human cannot end is a leak that looks like caution.
           */}
          <strong>Interrupted — needs a decision</strong>
          <p className="page-subtitle">
            This step was in flight when the server restarted, so whether it finished is unknown.
            It is not repeated automatically. Check the effect it would have had — a deleted file,
            a sent request, a charge — and choose.
          </p>
          <p style={{ margin: "6px 0" }}>
            Step: <code>{needsReconciliation.toolId ?? needsReconciliation.kind}</code>
          </p>
          <Can
            permission="agent:approve"
            fallback={
              <p className="page-subtitle" style={{ marginTop: 8 }}>
                Waiting for a project editor or admin to decide — your role can read this task but
                not resolve an interrupted step.
              </p>
            }
          >
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                className="btn"
                disabled={busyNodeId === needsReconciliation.id}
                onClick={() => handleReconcile(needsReconciliation.id, "retry")}
              >
                Run it again
              </button>
              <button
                className="btn btn-danger"
                disabled={busyNodeId === needsReconciliation.id}
                onClick={() => handleReconcile(needsReconciliation.id, "abandon")}
              >
                Abandon this step
              </button>
            </div>
          </Can>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}

      {entries.length > 0 && (
        <div className="card">
          {/* What the model is doing, as it does it (ADR-134). Before this a ten-minute run was
              a spinner and then an answer. */}
          <strong>Activity</strong>
          <div className="plan-steps" style={{ marginTop: 8 }}>
            {entries.map((entry, i) => (
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
                    {/* Audit finding 15: a check that could not run was shown as "passed". */}
                    {entry.inconclusive ? "Verification could not be completed" : `Verification ${entry.ok ? "passed" : "failed"}`}
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

      {variant === "coding" && <CodingTabs nodes={nodes} activity={activity} />}

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

/**
 * What the coding agent actually did — docs/26_DECISIONS.md ADR-142.
 *
 * These tabs filtered the task's NODES for `toolId === "terminal.run_command"` and
 * `toolId === "code.apply_literal_fix"`. The planner produces neither: `planFixFailingTest`
 * returns exactly ONE node, of kind `reasoning`, with no `toolId` at all, and every command and
 * every edit happens inside it. So both filters matched nothing for every run that has ever
 * existed — "Commands run (0)" and "Files changed (0)" above a task that had just run a dozen
 * commands and rewritten a file. `code.apply_literal_fix` is not even a registered tool; the tab
 * was filtering for a tool that does not exist.
 *
 * The real source is the reasoning node's activity (ADR-134), which is where the tool calls and
 * their results now live — both streamed and persisted. A command is a `terminal.run_command`
 * call; a file change is an `fs.write_file` or `fs.delete_file` call. The tabs read that.
 */
function CodingTabs({ nodes, activity }: { nodes: TaskNode[]; activity: TaskActivity[] }) {
  const [tab, setTab] = useState<"commands" | "files">("commands");

  // Live activity when the run is in flight, the persisted log when it is over: the same shape
  // either way, so the screen does not need to know which it is looking at.
  const entries = activity.length > 0 ? activity : persistedActivityOf(nodes);

  const calls = entries.filter((e) => e.kind === "tool_call");
  const resultFor = (callId?: string) =>
    entries.find((e) => e.kind === "tool_result" && callId !== undefined && e.callId === callId);

  const commands = calls.filter((c) => c.name === "terminal.run_command");
  /**
   * What the CODING agent actually uses to change a file — docs/26_DECISIONS.md ADR-154.
   *
   * This filtered for `fs.write_file` and `fs.delete_file`, and `planFixFailingTest` grants
   * neither: its allowed set is `terminal.run_command`, `code.read_lines`, `code.apply_patch`
   * plus the read-only filesystem tools. So the "Files changed" tab read 0 for every real
   * coding run, on the screen built to show what the run changed. The write tools stay in the
   * filter for the autonomous variant, which does hold them.
   */
  const fileWrites = calls.filter(
    (c) =>
      c.name === "code.apply_patch" ||
      c.name === "code.replace_text" ||
      c.name === "fs.write_file" ||
      c.name === "fs.delete_file"
  );

  return (
    <div className="card">
      <div className="tabs">
        <span className={`tab ${tab === "commands" ? "active" : ""}`} onClick={() => setTab("commands")}>
          Commands run ({commands.length})
        </span>
        <span className={`tab ${tab === "files" ? "active" : ""}`} onClick={() => setTab("files")}>
          Files changed ({fileWrites.length})
        </span>
      </div>

      {tab === "commands" &&
        (commands.length === 0 ? (
          <p className="empty-state">No commands run yet.</p>
        ) : (
          commands.map((call, i) => {
            const args = call.arguments as { command?: unknown; args?: unknown } | undefined;
            const result = resultFor(call.callId);
            return (
              <div key={call.callId ?? i} style={{ marginBottom: 12 }}>
                <div className="mono">
                  $ {String(args?.command ?? "")} {Array.isArray(args?.args) ? args!.args.join(" ") : ""}
                </div>
                {result && (
                  <pre className={`mono ${result.ok ? "" : "error-text"}`}>{result.preview}</pre>
                )}
              </div>
            );
          })
        ))}

      {tab === "files" &&
        (fileWrites.length === 0 ? (
          <p className="empty-state">No file changes yet.</p>
        ) : (
          fileWrites.map((call, i) => {
            const args = call.arguments as
              | { path?: unknown; content?: unknown; diff?: unknown; oldText?: unknown; newText?: unknown }
              | undefined;
            const result = resultFor(call.callId);
            // A patch names its files inside the diff; show the diff itself, which is the change.
            const diff = typeof args?.diff === "string" ? args.diff : null;
            const patchedPaths = diff ? [...diff.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((m) => m[1]).join(", ") : "";
            const verb =
              call.name === "fs.delete_file" ? "deleted " : call.name === "fs.write_file" ? "wrote " : "edited ";
            return (
              <div key={call.callId ?? i} style={{ marginBottom: 12 }}>
                <div className="mono">
                  {result && !result.ok ? "refused: " : verb}
                  {diff ? patchedPaths : String(args?.path ?? "")}
                </div>
                {result && !result.ok && <div className="mono error-text">{result.preview}</div>}
                {typeof args?.content === "string" && (
                  <pre className="mono" style={{ color: "var(--success)" }}>
                    {args.content.slice(0, 1_000)}
                  </pre>
                )}
                {diff && <pre className="mono">{diff.slice(0, 2_000)}</pre>}
                {typeof args?.oldText === "string" && typeof args?.newText === "string" && (
                  <pre className="mono">
                    {args.oldText
                      .split("\n")
                      .map((l) => `- ${l}`)
                      .join("\n")}
                    {"\n"}
                    {args.newText
                      .split("\n")
                      .map((l) => `+ ${l}`)
                      .join("\n")}
                  </pre>
                )}
              </div>
            );
          })
        ))}
    </div>
  );
}

/**
 * The activity a finished run left on its node (ADR-134), in the same shape the live feed uses.
 *
 * A task opened after it finished has no stream to read, and its history is the reason to open it.
 */
function persistedActivityOf(nodes: TaskNode[]): TaskActivity[] {
  const out: TaskActivity[] = [];
  for (const node of nodes) {
    const raw = (node.output as { activity?: unknown } | null | undefined)?.activity;
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const kind = entry.kind;
      if (kind !== "tool_call" && kind !== "tool_result" && kind !== "verification") continue;
      out.push({
        kind,
        callId: typeof entry.callId === "string" ? entry.callId : undefined,
        name: typeof entry.name === "string" ? entry.name : undefined,
        arguments: (entry.arguments ?? undefined) as Record<string, unknown> | undefined,
        ok: typeof entry.ok === "boolean" ? entry.ok : undefined,
        inconclusive: entry.inconclusive === true ? true : undefined,
        // The persisted log keeps the fuller text under `content`; the live feed calls it
        // `preview`. One field reaches the screen so the renderer needs no branch.
        preview: typeof entry.content === "string" ? entry.content : undefined,
        reason: typeof entry.reason === "string" ? entry.reason : undefined,
        iteration: typeof entry.iteration === "number" ? entry.iteration : undefined,
      });
    }
  }
  return out;
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
