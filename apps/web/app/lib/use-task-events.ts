"use client";

import { useEffect, useRef, useState } from "react";
import type { Task, TaskNode, TaskState } from "@ai-platform/shared";
import { API_URL } from "./api";

interface TaskEventPayload {
  type: "state" | "node" | "transition" | "completed" | "failed";
  taskId: string;
  state?: TaskState;
  node?: TaskNode;
  output?: Record<string, unknown>;
  error?: string;
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
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/v1/agent/tasks/${taskId}/events`);
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

    source.addEventListener("state", onState);
    source.addEventListener("node", onNode);
    source.addEventListener("completed", onCompleted);
    source.addEventListener("failed", onFailed);
    source.onerror = () => {
      // A closed/errored SSE connection just stops live updates; the page still shows the
      // last known state, and a manual refresh re-fetches it — no retry loop needed for a
      // single-operator dev tool like this.
    };

    return () => {
      source.close();
    };
  }, [taskId]);

  const nodes = Object.values(nodesById).sort((a, b) => a.createdAt - b.createdAt);
  return { task, nodes };
}
