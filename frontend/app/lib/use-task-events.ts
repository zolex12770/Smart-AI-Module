"use client";

import { useEffect, useRef, useState } from "react";
import type { Task, TaskNode, TaskState } from "@ai-platform/shared";
import { API_URL } from "./api";
import { getSelectedProjectId } from "./auth-client";

interface TaskEventPayload {
  type: "state" | "node" | "transition" | "completed" | "failed" | "tool_call" | "tool_result" | "verification";
  taskId: string;
  state?: TaskState;
  node?: TaskNode;
  output?: Record<string, unknown>;
  error?: string;
  nodeId?: string;
  callId?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  ok?: boolean;
  preview?: string;
  reason?: string;
  iteration?: number;
}

/**
 * One thing the model did, as the screen shows it — docs/26_DECISIONS.md ADR-134.
 *
 * A model-driven run used to be a spinner followed by an answer: the loop emitted every tool call
 * and result, the engine forwarded none of them, and a task that spent ten minutes reading files
 * and running commands showed nothing at all while it did so.
 */
export interface TaskActivity {
  kind: "tool_call" | "tool_result" | "verification";
  callId?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  ok?: boolean;
  preview?: string;
  reason?: string;
  iteration?: number;
}

/**
 * Live task state via the real `/api/v1/agent/tasks/:id/events` SSE endpoint
 * (docs/16_FRONTEND_ARCHITECTURE.md's `useEventStream` role) — native `EventSource`
 * works here (unlike chat's manual fetch-stream parser) because this endpoint is a plain
 * GET, and each event carries its own `event:` name, which `EventSource.addEventListener`
 * reads directly. Seeds from `initialTask`/`initialNodes` (the same data the SSE endpoint
 * replays on connect) so a page navigation never renders an empty flash before the
 * connection opens.
 */
export function useTaskEvents(taskId: string, initialTask: Task, initialNodes: TaskNode[]) {
  const [task, setTask] = useState<Task>(initialTask);
  const [nodesById, setNodesById] = useState<Record<string, TaskNode>>(() =>
    Object.fromEntries(initialNodes.map((n) => [n.id, n]))
  );
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  /**
   * Whether the screen is still live — docs/26_DECISIONS.md ADR-159.
   *
   * EventSource reconnects on its own, so "errored" and "stopped" are different states and the
   * user needs to be able to tell them apart: a transient drop recovers, a CLOSED one does not
   * and the page is showing a frozen snapshot from then on.
   */
  const [live, setLive] = useState<"live" | "reconnecting" | "disconnected">("live");
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // The endpoint states its own contract: "An EventSource cannot set headers, so a browser
    // subscribes with `?projectId=...`" (backend/src/routes/v1/agent.ts). This hook opened a
    // bare URL, so `requireProject` had no scope to authorize against and answered "A
    // projectId is required" — the stream never opened and the task screen showed whatever it
    // was seeded with, frozen, with no error anywhere the user could see.
    //
    // `withCredentials` is the other half: without it the browser omits the session cookie on
    // a cross-origin EventSource (the API is a separate deployment, hence `credentials:
    // "include"` in apiFetch), leaving the connection unauthenticated even with a scope.
    const url = new URL(`${API_URL}/api/v1/agent/tasks/${encodeURIComponent(taskId)}/events`);
    const projectId = getSelectedProjectId();
    if (projectId) url.searchParams.set("projectId", projectId);
    const source = new EventSource(url.toString(), { withCredentials: true });
    sourceRef.current = source;

    const onState = (e: MessageEvent) => {
      const payload = JSON.parse(e.data) as TaskEventPayload;
      if (payload.state) setTask((prev) => ({ ...prev, state: payload.state as TaskState }));
    };
    const onNode = (e: MessageEvent) => {
      const payload = JSON.parse(e.data) as TaskEventPayload;
      if (payload.node) setNodesById((prev) => ({ ...prev, [payload.node!.id]: payload.node! }));
    };
    // "completed"/"failed" carry the task's final output/error but NOT `state` (that
    // arrives separately via a "state" event from the same transition) — a real bug found
    // by watching a task complete live in a browser rather than only loading an
    // already-finished one: the final-result card never appeared because this handler
    // didn't exist and `onState` silently ignored events with no `state` field.
    const onCompleted = (e: MessageEvent) => {
      const payload = JSON.parse(e.data) as TaskEventPayload;
      setTask((prev) => ({ ...prev, output: payload.output ?? prev.output }));
    };
    const onFailed = (e: MessageEvent) => {
      const payload = JSON.parse(e.data) as TaskEventPayload;
      setTask((prev) => ({ ...prev, errorMessage: payload.error ?? prev.errorMessage }));
    };

    /**
     * The live activity feed (ADR-134). Appended rather than replaced, because the interesting
     * thing about an agent run is the SEQUENCE — which tool it reached for after seeing what.
     */
    const onToolCall = (e: MessageEvent) => {
      const p = JSON.parse(e.data) as TaskEventPayload;
      setActivity((prev) => [
        ...prev,
        { kind: "tool_call", callId: p.callId, name: p.name, arguments: p.arguments, iteration: p.iteration },
      ]);
    };
    const onToolResult = (e: MessageEvent) => {
      const p = JSON.parse(e.data) as TaskEventPayload;
      setActivity((prev) => [
        ...prev,
        { kind: "tool_result", callId: p.callId, ok: p.ok, preview: p.preview, iteration: p.iteration },
      ]);
    };
    const onVerification = (e: MessageEvent) => {
      const p = JSON.parse(e.data) as TaskEventPayload;
      setActivity((prev) => [...prev, { kind: "verification", ok: p.ok, reason: p.reason }]);
    };

    source.addEventListener("state", onState);
    source.addEventListener("node", onNode);
    source.addEventListener("completed", onCompleted);
    source.addEventListener("failed", onFailed);
    source.addEventListener("tool_call", onToolCall);
    source.addEventListener("tool_result", onToolResult);
    source.addEventListener("verification", onVerification);
    source.onerror = () => {
      /**
       * Both halves of the old comment here were wrong — docs/26_DECISIONS.md ADR-159.
       *
       * It said a failed SSE connection "just stops live updates" and that no retry loop is
       * needed. EventSource RECONNECTS on its own — it sets `readyState` to CONNECTING and
       * retries about every three seconds, forever — so an endpoint answering 401 or 404
       * produced a silent reconnect loop against the API rather than a stopped stream. And the
       * two cases are not the same: a transient drop recovers by itself, while a CLOSED state
       * is final and the user needs to know the screen has stopped being live.
       */
      setLive(source.readyState === EventSource.CLOSED ? "disconnected" : "reconnecting");
    };
    source.onopen = () => setLive("live");

    return () => {
      source.removeEventListener("state", onState);
      source.removeEventListener("node", onNode);
      source.removeEventListener("completed", onCompleted);
      source.removeEventListener("failed", onFailed);
      source.removeEventListener("tool_call", onToolCall);
      source.removeEventListener("tool_result", onToolResult);
      source.removeEventListener("verification", onVerification);
      source.close();
    };
  }, [taskId]);

  const nodes = Object.values(nodesById).sort((a, b) => a.createdAt - b.createdAt);
  return { task, nodes, activity, live };
}
