import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Task, TaskNode } from "@ai-platform/shared";
import { FakeEventSource } from "../../test/setup";
import { API_URL } from "./api";
import { useTaskEvents } from "./use-task-events";

/**
 * The live task stream's authorization contract, which the hook did not honour.
 *
 * `/api/v1/agent/tasks/:id/events` says it in its own comment: "An EventSource cannot set
 * headers, so a browser subscribes with `?projectId=...`". Opening a bare URL means
 * `requireProject` has no scope, the connection is refused before a single event, and the task
 * screen sits on its seed data forever with nothing on screen to say the stream never opened.
 */

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  taskType: "autonomous",
  state: "EXECUTING",
  input: { goal: "ship it" },
  output: null,
  errorMessage: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const node = (id: string, overrides: Partial<TaskNode> = {}): TaskNode => ({
  id,
  parentId: null,
  rootTaskId: "task-1",
  type: "atomic",
  kind: "tool_call",
  status: "running",
  dependsOn: [],
  input: {},
  output: null,
  toolId: "terminal.run_command",
  modelProvider: null,
  retryPolicy: { maxAttempts: 1, backoff: "none", classifyFailureAs: null },
  timeoutMs: 1000,
  verificationMethod: "none",
  verificationSpec: null,
  approvalRequired: false,
  approvedBy: null,
  approvedAt: null,
  attemptCount: 0,
  errorMessage: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe("useTaskEvents", () => {
  beforeEach(() => {
    FakeEventSource.reset();
    window.localStorage.setItem("aip.selectedProjectId", "project-1");
  });

  afterEach(() => {
    FakeEventSource.reset();
    window.localStorage.clear();
  });

  it("subscribes with the project scope in the query string", () => {
    renderHook(() => useTaskEvents("task-1", task(), []));

    const url = new URL(FakeEventSource.instances[0]!.url);
    expect(url.origin + url.pathname).toBe(`${API_URL}/api/v1/agent/tasks/task-1/events`);
    expect(url.searchParams.get("projectId")).toBe("project-1");
  });

  it("opens the stream with credentials so the session cookie is sent cross-origin", () => {
    renderHook(() => useTaskEvents("task-1", task(), []));
    // Without this an EventSource to another origin omits cookies entirely, so even a
    // correctly scoped subscription would be unauthenticated.
    expect(FakeEventSource.instances[0]!.withCredentials).toBe(true);
  });

  it("still connects when no project has been selected yet", () => {
    window.localStorage.clear();
    renderHook(() => useTaskEvents("task-1", task(), []));
    expect(new URL(FakeEventSource.instances[0]!.url).searchParams.has("projectId")).toBe(false);
  });

  it("applies state and node events from the stream", () => {
    const { result } = renderHook(() => useTaskEvents("task-1", task(), [node("n1")]));
    const source = FakeEventSource.instances[0]!;

    act(() => source.emit("state", { type: "state", taskId: "task-1", state: "COMPLETED" }));
    act(() => source.emit("node", { type: "node", taskId: "task-1", node: node("n1", { status: "completed" }) }));

    expect(result.current.task.state).toBe("COMPLETED");
    expect(result.current.nodes[0]!.status).toBe("completed");
  });

  it("closes the stream on unmount", () => {
    const { unmount } = renderHook(() => useTaskEvents("task-1", task(), []));
    unmount();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });
});
