import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task, TaskNode } from "@ai-platform/shared";
import TaskDetail from "./TaskDetail";
import type { TaskActivity } from "../lib/use-task-events";

/**
 * What the approver is shown, and what the watcher is shown — ADR-134 and ADR-135.
 *
 * Two defects, one screen. The approval card read `node.toolId` and `node.input`, which are the
 * fields of a DECLARATIVE `tool_call` node; a model-driven run parks a `reasoning` node whose
 * `toolId` is null and whose `input` is the original goal. So the card said "Tool call
 * `undefined`" over a copy of the request, and a human pressed Approve knowing neither the tool
 * nor its arguments — on a destructive tool, the only kind that reaches the gate.
 *
 * And the run itself was invisible: the loop emitted every tool call and result, the engine
 * forwarded none, so ten minutes of reading files and running commands showed a spinner.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agent/task-1",
}));

const hookResult: { task: Task; nodes: TaskNode[]; activity: TaskActivity[] } = {
  task: {} as Task,
  nodes: [],
  activity: [],
};
vi.mock("../lib/use-task-events", () => ({
  useTaskEvents: () => hookResult,
}));

const task = (): Task =>
  ({
    id: "task-1",
    type: "autonomous",
    state: "WAITING_FOR_APPROVAL",
    input: { goal: "Tidy the repository" },
    output: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 2,
  }) as unknown as Task;

const reasoningNode = (output: Record<string, unknown>): TaskNode =>
  ({
    id: "node-1",
    kind: "reasoning",
    status: "waiting_approval",
    // Exactly the shape that broke the card: no tool id, and the GOAL as input.
    toolId: null,
    input: { goal: "Tidy the repository" },
    output,
    modelProvider: null,
    createdAt: 1,
  }) as unknown as TaskNode;

describe("TaskDetail approval card", () => {
  afterEach(() => {
    hookResult.activity = [];
    hookResult.nodes = [];
  });

  it("names the tool and shows its arguments for a model-driven run", () => {
    hookResult.task = task();
    hookResult.nodes = [
      reasoningNode({
        pendingCall: { id: "c2", name: "fs.delete_file", arguments: { path: "src/index.ts" } },
        pendingCalls: [
          { id: "c2", name: "fs.delete_file", arguments: { path: "src/index.ts" } },
          { id: "c3", name: "terminal.run_command", arguments: { command: "rm -rf build" } },
        ],
        reason: "fs.delete_file is destructive and always requires approval.",
      }),
    ];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={hookResult.nodes} />);

    // The tool, by name — not "undefined".
    expect(screen.getByText("fs.delete_file")).toBeInTheDocument();
    // The ARGUMENTS, which are the whole basis for the decision.
    expect(screen.getByText(/src\/index\.ts/)).toBeInTheDocument();
    // Why it stopped.
    expect(screen.getByText(/always requires approval/i)).toBeInTheDocument();
    // And the other call queued behind it, so approving is not a surprise.
    expect(screen.getByText("terminal.run_command")).toBeInTheDocument();
  });

  it("does not show the original goal in place of the arguments", () => {
    // The precise symptom of the old card: it rendered node.input, which is the goal.
    hookResult.task = task();
    hookResult.nodes = [
      reasoningNode({ pendingCall: { id: "c2", name: "fs.delete_file", arguments: { path: "notes.txt" } } }),
    ];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={hookResult.nodes} />);

    const args = screen.getByText(/notes\.txt/);
    expect(args).toBeInTheDocument();
    expect(args.textContent).not.toMatch(/Tidy the repository/);
  });

  it("still describes a declarative tool_call node from its own fields", () => {
    hookResult.task = task();
    hookResult.nodes = [
      {
        id: "node-2",
        kind: "tool_call",
        status: "waiting_approval",
        toolId: "fs.write_file",
        input: { path: "out.txt", content: "hello" },
        output: null,
        modelProvider: null,
        createdAt: 1,
      } as unknown as TaskNode,
    ];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={hookResult.nodes} />);

    expect(screen.getByText("fs.write_file")).toBeInTheDocument();
    expect(screen.getByText(/out\.txt/)).toBeInTheDocument();
  });
});

describe("TaskDetail activity feed", () => {
  afterEach(() => {
    hookResult.activity = [];
    hookResult.nodes = [];
  });

  it("shows each tool call, its result and the verification verdict, in order", () => {
    hookResult.task = { ...task(), state: "RUNNING" } as unknown as Task;
    hookResult.nodes = [];
    hookResult.activity = [
      { kind: "tool_call", callId: "c1", name: "fs.glob", arguments: { pattern: "**/*.ts" }, iteration: 1 },
      { kind: "tool_result", callId: "c1", ok: true, preview: "12 files", iteration: 1 },
      { kind: "verification", ok: false, reason: "The answer does not address the goal." },
    ];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={[]} />);

    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("fs.glob")).toBeInTheDocument();
    expect(screen.getByText(/\*\*\/\*\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/12 files/)).toBeInTheDocument();
    expect(screen.getByText(/Verification failed/i)).toBeInTheDocument();
    expect(screen.getByText(/does not address the goal/i)).toBeInTheDocument();
  });

  it("shows no activity card at all when nothing has happened yet", () => {
    hookResult.task = task();
    hookResult.nodes = [];
    hookResult.activity = [];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={[]} />);
    expect(screen.queryByText("Activity")).not.toBeInTheDocument();
  });

  it("reports a failed tool call as failed rather than as a result", () => {
    hookResult.task = { ...task(), state: "RUNNING" } as unknown as Task;
    hookResult.activity = [{ kind: "tool_result", callId: "c1", ok: false, preview: "ENOENT", iteration: 1 }];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={[]} />);
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
    expect(screen.getByText(/ENOENT/)).toBeInTheDocument();
  });
});
