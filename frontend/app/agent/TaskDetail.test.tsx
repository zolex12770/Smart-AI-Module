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

/**
 * The coding-agent tabs read what really happened — docs/26_DECISIONS.md ADR-142.
 *
 * They filtered the task's NODES for `toolId === "terminal.run_command"` and
 * `toolId === "code.apply_literal_fix"`. `planFixFailingTest` returns exactly one node, of kind
 * `reasoning`, with no `toolId` at all — every command and edit happens inside it — so both
 * filters matched nothing for every run that has ever existed. The screen said "Commands run (0)"
 * over a task that had just run a dozen. And `code.apply_literal_fix` is not a registered tool at
 * all: the tab filtered for something that does not exist.
 */
describe("TaskDetail coding tabs", () => {
  afterEach(() => {
    hookResult.activity = [];
    hookResult.nodes = [];
  });

  const codingTask = () =>
    ({ ...task(), taskType: "fix_failing_test", state: "RUNNING" }) as unknown as Task;

  it("counts and shows the commands the reasoning node really ran", async () => {
    hookResult.task = codingTask();
    hookResult.nodes = [];
    hookResult.activity = [
      {
        kind: "tool_call",
        callId: "c1",
        name: "terminal.run_command",
        arguments: { command: "npx", args: ["vitest", "run"] },
        iteration: 1,
      },
      { kind: "tool_result", callId: "c1", ok: false, preview: "1 failed", iteration: 1 },
      { kind: "tool_call", callId: "c2", name: "fs.write_file", arguments: { path: "src/sum.ts", content: "export const sum = (a, b) => a + b;" }, iteration: 2 },
      { kind: "tool_result", callId: "c2", ok: true, preview: "{}", iteration: 2 },
    ];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={[]} variant="coding" />);

    // Not (0).
    expect(screen.getByText(/Commands run \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Files changed \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/vitest run/)).toBeInTheDocument();
    // Twice on purpose: the Activity card (ADR-134) shows the same result as the Commands tab.
    // Two views of one run is the intent, so this asserts presence rather than uniqueness.
    expect(screen.getAllByText(/1 failed/).length).toBeGreaterThanOrEqual(1);
  });

  it("reads a finished run's activity off the node, with no stream to listen to", () => {
    // Opening a task after it finished is the normal case, and its history is the reason to open
    // it. The live feed is empty then; the node's persisted log is not.
    hookResult.task = { ...codingTask(), state: "COMPLETED" } as unknown as Task;
    hookResult.activity = [];
    hookResult.nodes = [
      {
        id: "node-1",
        kind: "reasoning",
        status: "completed",
        toolId: null,
        input: { goal: "fix the test" },
        output: {
          content: "Fixed it.",
          activity: [
            { kind: "tool_call", callId: "c1", name: "terminal.run_command", arguments: { command: "npm", args: ["test"] } },
            { kind: "tool_result", callId: "c1", ok: true, content: "all passed" },
          ],
        },
        modelProvider: null,
        createdAt: 1,
      } as unknown as TaskNode,
    ];

    render(
      <TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={hookResult.nodes} variant="coding" />
    );

    expect(screen.getByText(/Commands run \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/npm test/)).toBeInTheDocument();
    expect(screen.getByText(/all passed/)).toBeInTheDocument();
  });

  it("says nothing has happened rather than showing an empty tab as a result", () => {
    hookResult.task = codingTask();
    hookResult.activity = [];
    hookResult.nodes = [];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={[]} variant="coding" />);
    expect(screen.getByText(/Commands run \(0\)/)).toBeInTheDocument();
    expect(screen.getByText(/No commands run yet/i)).toBeInTheDocument();
  });
});
