import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/**
 * The session mock MIRRORS the real guard rather than rendering children unconditionally.
 *
 * A mock that always shows the children would make every assertion about who sees a control
 * pass — which is the mistake ADR-144 was written about, one screen over.
 */
const permissions: { current: string[] } = { current: ["agent:run", "agent:approve"] };
vi.mock("../lib/session-context", async () => {
  const React = await import("react");
  return {
    Can: ({
      permission,
      children,
      fallback = null,
    }: {
      permission: string;
      children: React.ReactNode;
      fallback?: React.ReactNode;
    }) => React.createElement(React.Fragment, null, permissions.current.includes(permission) ? children : fallback),
  };
});

/** The API client, so a refusal can be made to happen the way the server makes one. */
const api = vi.hoisted(() => ({
  approveNode: vi.fn(async () => undefined),
  rejectNode: vi.fn(async () => undefined),
  cancelTask: vi.fn(async () => undefined),
  reconcileNode: vi.fn(async () => undefined),
}));
vi.mock("../lib/api", () => api);

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

  it("says a verification that could not run was not completed — never that it passed", () => {
    // Audit finding 15: this rendered "Verification passed — verification could not be evaluated".
    hookResult.task = { ...task(), state: "RUNNING" } as unknown as Task;
    hookResult.nodes = [];
    hookResult.activity = [
      { kind: "verification", ok: true, inconclusive: true, reason: "verification could not be evaluated (the verifier call failed)" },
    ];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={[]} />);
    expect(screen.getByText(/Verification could not be completed/i)).toBeInTheDocument();
    expect(screen.queryByText(/Verification passed/i)).not.toBeInTheDocument();
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

  it("shows what each coding edit changed: a patch's files and diff, a replacement's old and new text", async () => {
    hookResult.task = codingTask();
    hookResult.nodes = [];
    hookResult.activity = [
      {
        kind: "tool_call",
        callId: "p1",
        name: "code.apply_patch",
        arguments: { diff: "--- a/sum.js\n+++ b/sum.js\n@@ -2 +2 @@\n-  return a - b;\n+  return a * b;\n" },
        iteration: 1,
      },
      { kind: "tool_result", callId: "p1", ok: false, preview: "Malformed hunk", iteration: 1 },
      {
        kind: "tool_call",
        callId: "r1",
        name: "code.replace_text",
        arguments: { path: "sum.js", oldText: "return a - b;", newText: "return a + b;" },
        iteration: 2,
      },
      { kind: "tool_result", callId: "r1", ok: true, preview: "{}", iteration: 2 },
    ];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={[]} variant="coding" />);
    await userEvent.click(screen.getByText(/Files changed \(2\)/));

    expect(screen.getByText("refused: sum.js")).toBeInTheDocument();
    expect(screen.getByText("edited sum.js")).toBeInTheDocument();
    expect(screen.getByText(/\+ return a \+ b;/)).toBeInTheDocument();
    // The refused patch's own diff is shown, so a reader can see what was attempted.
    // (The Activity card shows the raw arguments too, hence the <pre> selector.)
    expect(screen.getByText(/\+\+\+ b\/sum\.js.*\+ return a \* b;/s, { selector: "pre" })).toBeInTheDocument();
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
    expect(screen.getAllByText(/npm test/).length).toBeGreaterThan(0);
    // Twice, on purpose: the Activity card reads the same persisted log now that ADR-148 stopped
    // it being coding-only, and the Commands tab shows the command's output in full.
    expect(screen.getAllByText(/all passed/).length).toBe(2);
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

/**
 * A refusal is visible, and a control nobody can use is not offered — ADR-148.
 *
 * All three handlers awaited with no catch and were invoked as floating promises from `onClick`.
 * A 403 (a viewer pressing Approve), a 404 (someone else decided the node first) or a dropped
 * connection became an unhandled rejection and nothing on screen: the card did not move and did
 * not say why. This is the approval gate on destructive tool calls.
 */
describe("TaskDetail decisions", () => {
  afterEach(() => {
    permissions.current = ["agent:run", "agent:approve"];
    api.approveNode.mockReset().mockResolvedValue(undefined);
    api.rejectNode.mockReset().mockResolvedValue(undefined);
    api.cancelTask.mockReset().mockResolvedValue(undefined);
    hookResult.activity = [];
  });

  const pending = { id: "call-1", name: "fs.delete_file", arguments: { path: "notes.md" } };

  function renderParked() {
    hookResult.task = task();
    hookResult.nodes = [reasoningNode({ pendingCall: pending, reason: "destructive" })];
    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={hookResult.nodes} />);
  }

  it("shows the API's refusal when Approve is rejected", async () => {
    api.approveNode.mockRejectedValue(new Error("You do not have permission to approve agent actions."));
    renderParked();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByText(/do not have permission to approve/i)).toBeInTheDocument()
    );
    // And the button is usable again, rather than stuck disabled after a failure.
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();
  });

  it("shows the API's refusal when Reject is rejected", async () => {
    api.rejectNode.mockRejectedValue(new Error("Node \"node-1\" is not awaiting approval."));
    renderParked();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(screen.getByText(/is not awaiting approval/i)).toBeInTheDocument());
  });

  it("shows the API's refusal when Cancel is rejected", async () => {
    api.cancelTask.mockRejectedValue(new Error("Cancelling requires agent:run."));
    renderParked();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText(/requires agent:run/i)).toBeInTheDocument());
  });

  it("offers a viewer no decision, and says who can make one", () => {
    permissions.current = ["project:read"];
    renderParked();

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    // Explained, not merely absent: a control that vanishes teaches the user the screen is broken.
    expect(screen.getByText(/project editor or admin/i)).toBeInTheDocument();
    // The run is still fully readable — hiding the decision must not hide the task.
    expect(screen.getByText(/fs\.delete_file/)).toBeInTheDocument();
  });

  it("still offers an editor all three", () => {
    renderParked();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

/**
 * The interrupted step, and the decision only a human can make — docs/26_DECISIONS.md ADR-148.
 *
 * A mutating tool call — or a whole model-driven run — caught by a restart parks at
 * `needs_reconciliation` and the task PAUSES, because the engine cannot know whether the action
 * completed. That state had no reader anywhere: no engine method, no route, no screen. A task
 * that reached it was stuck for good, which is a leak that looks like caution.
 */
describe("TaskDetail reconciliation", () => {
  afterEach(() => {
    permissions.current = ["agent:run", "agent:approve"];
    api.reconcileNode.mockReset().mockResolvedValue(undefined);
    hookResult.activity = [];
  });

  const interrupted = (): TaskNode =>
    ({
      id: "node-9",
      kind: "reasoning",
      status: "needs_reconciliation",
      toolId: null,
      input: { goal: "Tidy the repository" },
      output: { activity: [] },
      modelProvider: null,
      createdAt: 1,
    }) as unknown as TaskNode;

  function renderInterrupted() {
    hookResult.task = { ...task(), state: "PAUSED" } as Task;
    hookResult.nodes = [interrupted()];
    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={hookResult.nodes} />);
  }

  it("offers both decisions, and sends the one that was pressed", async () => {
    renderInterrupted();

    expect(screen.getByText(/Interrupted — needs a decision/i)).toBeInTheDocument();
    // It says WHY it is not simply retried, because that is the whole reason the step is here.
    expect(screen.getByText(/whether it finished is unknown/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /run it again/i }));
    await waitFor(() => expect(api.reconcileNode).toHaveBeenCalledWith("task-1", "node-9", "retry"));

    fireEvent.click(screen.getByRole("button", { name: /abandon this step/i }));
    await waitFor(() => expect(api.reconcileNode).toHaveBeenCalledWith("task-1", "node-9", "abandon"));
  });

  it("reports a refusal instead of doing nothing", async () => {
    api.reconcileNode.mockRejectedValue(new Error("Node \"node-9\" is not waiting to be reconciled."));
    renderInterrupted();

    fireEvent.click(screen.getByRole("button", { name: /run it again/i }));
    await waitFor(() => expect(screen.getByText(/not waiting to be reconciled/i)).toBeInTheDocument());
  });

  it("offers a viewer neither decision, and says who can make one", () => {
    permissions.current = ["project:read"];
    renderInterrupted();

    expect(screen.queryByRole("button", { name: /run it again/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /abandon this step/i })).toBeNull();
    expect(screen.getByText(/not resolve an interrupted step/i)).toBeInTheDocument();
  });
});

/**
 * A finished autonomous run explains itself — docs/26_DECISIONS.md ADR-134, reached by ADR-148.
 *
 * The events endpoint replays `state` and `node`, never activity, so a task opened after it
 * finished had an empty live feed and the Activity card did not render at all. The rows were on
 * the node the whole time and `persistedActivityOf` was already written — but only the coding
 * variant read it. On the autonomous screen, the primary one, an operator saw the plan and the
 * answer and no record of which tools ran with what arguments.
 */
describe("TaskDetail activity after the run", () => {
  afterEach(() => {
    hookResult.activity = [];
  });

  it("reads a finished autonomous run's activity off the node", () => {
    hookResult.task = { ...task(), state: "COMPLETED" } as Task;
    hookResult.activity = [];
    hookResult.nodes = [
      {
        id: "node-1",
        kind: "reasoning",
        status: "completed",
        toolId: null,
        input: { goal: "Tidy the repository" },
        output: {
          content: "Done.",
          activity: [
            { kind: "tool_call", callId: "c1", name: "fs.read_file", arguments: { path: "notes.txt" } },
            { kind: "tool_result", callId: "c1", ok: true, content: "read me first" },
          ],
        },
        modelProvider: null,
        createdAt: 1,
      } as unknown as TaskNode,
    ];

    // variant="agent" — what /agent/[id] actually renders.
    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={hookResult.nodes} />);

    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText(/fs\.read_file/)).toBeInTheDocument();
  });

  it("shows no Activity card for a run that did nothing", () => {
    // The card must not appear empty: "no activity" and "activity not loaded" look identical,
    // and an empty card would claim the run made no tool calls when the log simply is not there.
    hookResult.task = { ...task(), state: "COMPLETED" } as Task;
    hookResult.activity = [];
    hookResult.nodes = [];

    render(<TaskDetail taskId="task-1" initialTask={hookResult.task} initialNodes={[]} />);
    expect(screen.queryByText("Activity")).toBeNull();
  });
});

