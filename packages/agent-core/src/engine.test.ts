import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  runMigrations,
  PgTaskNodeRepository,
  PgTaskRepository,
  PgTaskTransitionRepository,
  type DrizzleDb,
  type TaskNodeRepository,
  type TaskRepository,
  type TaskTransitionRepository,
} from "@ai-platform/database";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { createFilesystemTools, ToolRegistry } from "@ai-platform/tools";
import type { Task, TaskState } from "@ai-platform/shared";
import { AgentEngine } from "./engine.js";

/**
 * Real, end-to-end coverage of the state machine + dispatcher (docs/11_AGENT_LOOP.md) —
 * previously untested at this level (only `planner.ts`'s pure output was covered). Uses a
 * real in-memory PGlite Postgres, real repositories, a real `ToolRegistry` with real
 * sandboxed filesystem tools, and the real `MockLLMProvider` — no mocked repos/engine
 * internals, matching this project's own "test for real" discipline established across
 * every phase's own integration tests (rag, jobs, media).
 */
async function setupHarness() {
  const db: DrizzleDb = await createDb(":memory:");
  await runMigrations(db);

  const sandboxRoot = mkdtempSync(join(tmpdir(), "engine-test-"));

  const tasks: TaskRepository = new PgTaskRepository(db);
  const taskNodes: TaskNodeRepository = new PgTaskNodeRepository(db);
  const taskTransitions: TaskTransitionRepository = new PgTaskTransitionRepository(db);

  const toolRegistry = new ToolRegistry();
  for (const { definition, handler } of createFilesystemTools(sandboxRoot)) {
    toolRegistry.register(definition, handler);
  }

  const registry = new ModelRegistry();
  registry.register(new MockLLMProvider(0), { asDefault: true }); // 0ms token delay — fast tests
  const modelRouter = new ModelRouter(registry);

  // docs/26_DECISIONS.md ADR-046 — a real recording meter, scripted only in its verdict, so
  // the tests below assert on what the engine actually handed it.
  const meterCalls: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; taskId: string; nodeId: string }> = [];
  const meterChecks: number[] = [];
  const meter = {
    allow: true as boolean,
    reason: undefined as string | undefined,
    async checkTokens(estimatedTokens: number) {
      meterChecks.push(estimatedTokens);
      return { allowed: meter.allow, reason: meter.reason };
    },
    async record(entry: { provider: string; model: string; inputTokens: number; outputTokens: number; taskId: string; nodeId: string }) {
      meterCalls.push(entry);
    },
  };

  const engine = new AgentEngine({ taskRepo: tasks, nodeRepo: taskNodes, transitionRepo: taskTransitions, toolRegistry, modelRouter, meter });

  return { db, sandboxRoot, tasks, taskNodes, taskTransitions, toolRegistry, modelRouter, engine, meter, meterCalls, meterChecks };
}

async function waitForTaskState(tasks: TaskRepository, taskId: string, states: TaskState[], timeoutMs = 5000): Promise<Task> {
  const start = Date.now();
  while (true) {
    const task = await tasks.get(taskId);
    if (task && states.includes(task.state)) return task;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for task ${taskId} to reach one of [${states.join(", ")}] (last state: ${task?.state})`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("AgentEngine — real state machine + dispatcher", () => {
  let harness: Awaited<ReturnType<typeof setupHarness>>;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    await harness.db.$client.close();
    rmSync(harness.sandboxRoot, { recursive: true, force: true });
  });

  it("completes a single-step echo_chat task end to end", async () => {
    const { engine, tasks, taskNodes } = harness;
    const task = await engine.createAndStart("echo_chat", { message: "hello engine" });

    const completed = await waitForTaskState(tasks, task.id, ["COMPLETED", "FAILED"]);
    expect(completed.state).toBe("COMPLETED");
    expect(completed.output?.content).toContain("hello engine");

    const nodes = await taskNodes.listByRoot(task.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].status).toBe("completed");
  });

  it("completes a real multi-step task with dependency + template resolution (read_and_summarize)", async () => {
    const { engine, tasks, taskNodes, sandboxRoot } = harness;
    writeFileSync(join(sandboxRoot, "notes.txt"), "the secret ingredient is basil");

    const task = await engine.createAndStart("read_and_summarize", { path: "notes.txt", question: "what is the secret?" });
    const completed = await waitForTaskState(tasks, task.id, ["COMPLETED", "FAILED"]);

    expect(completed.state).toBe("COMPLETED");
    // The mock provider echoes back what it received — proves the file's real content was
    // actually resolved through the {{node.output.content}} template into the model input.
    expect(completed.output?.content).toContain("the secret ingredient is basil");

    const nodes = await taskNodes.listByRoot(task.id);
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.status === "completed")).toBe(true);
  });

  it("gates a destructive tool call on human approval, and approving it actually executes the action", async () => {
    const { engine, tasks, taskNodes, sandboxRoot } = harness;
    const filePath = join(sandboxRoot, "to-delete.txt");
    writeFileSync(filePath, "delete me");

    const task = await engine.createAndStart("delete_sandbox_file", { path: "to-delete.txt" });
    const waiting = await waitForTaskState(tasks, task.id, ["WAITING_FOR_APPROVAL", "FAILED", "COMPLETED"]);
    expect(waiting.state).toBe("WAITING_FOR_APPROVAL");
    expect(existsSync(filePath)).toBe(true); // not touched while waiting

    const nodes = await taskNodes.listByRoot(task.id);
    expect(nodes[0].status).toBe("waiting_approval");

    await engine.approve(task.id, nodes[0].id, "test-operator");
    const completed = await waitForTaskState(tasks, task.id, ["COMPLETED", "FAILED"]);
    expect(completed.state).toBe("COMPLETED");
    expect(existsSync(filePath)).toBe(false); // real side effect actually happened
  });

  it("rejecting an approval-gated tool call cancels the task and never executes the action", async () => {
    const { engine, tasks, taskNodes, sandboxRoot } = harness;
    const filePath = join(sandboxRoot, "keep-me.txt");
    writeFileSync(filePath, "do not delete");

    const task = await engine.createAndStart("delete_sandbox_file", { path: "keep-me.txt" });
    await waitForTaskState(tasks, task.id, ["WAITING_FOR_APPROVAL"]);
    const nodes = await taskNodes.listByRoot(task.id);

    await engine.reject(task.id, nodes[0].id, "test-operator");
    const finalTask = await waitForTaskState(tasks, task.id, ["CANCELLED", "COMPLETED", "FAILED"]);

    expect(finalTask.state).toBe("CANCELLED");
    expect(existsSync(filePath)).toBe(true); // the real, load-bearing assertion
  });

  it("cancel() stops a task and marks its non-terminal nodes cancelled", async () => {
    const { engine, tasks, taskNodes, sandboxRoot } = harness;
    writeFileSync(join(sandboxRoot, "x.txt"), "x");
    const task = await engine.createAndStart("delete_sandbox_file", { path: "x.txt" });
    await waitForTaskState(tasks, task.id, ["WAITING_FOR_APPROVAL"]);

    await engine.cancel(task.id, "test-operator");
    const finalTask = await tasks.get(task.id);
    expect(finalTask?.state).toBe("CANCELLED");
    const nodes = await taskNodes.listByRoot(task.id);
    expect(nodes[0].status).toBe("cancelled");
  });

  it("subscribe() emits state and node events, in order, for a real run", async () => {
    const { engine } = harness;
    const events: string[] = [];
    const task = await engine.createAndStart("echo_chat", { message: "event order test" });
    const unsubscribe = engine.subscribe(task.id, (e) => events.push(e.type));

    await waitForTaskState(harness.tasks, task.id, ["COMPLETED", "FAILED"]);
    // Give the final "completed" emit a tick to land after the state flip.
    await new Promise((r) => setTimeout(r, 20));
    unsubscribe();

    expect(events).toContain("node");
    expect(events[events.length - 1]).toBe("completed");
  });

  it("a task whose tool call fails ends FAILED without an unbounded cascade loop (regression: docs/26 ADR history)", async () => {
    const { engine, tasks, taskTransitions } = harness;
    // fs.delete_file on a path that doesn't exist — a real, clean tool-level failure.
    const task = await engine.createAndStart("delete_sandbox_file", { path: "does-not-exist.txt" });
    const waiting = await waitForTaskState(tasks, task.id, ["WAITING_FOR_APPROVAL"]);
    expect(waiting.state).toBe("WAITING_FOR_APPROVAL");
    const nodes = await harness.taskNodes.listByRoot(task.id);
    await engine.approve(task.id, nodes[0].id, "test-operator");

    const finalTask = await waitForTaskState(tasks, task.id, ["FAILED", "COMPLETED"]);
    expect(finalTask.state).toBe("FAILED");

    // The historical bug produced 45,000+ duplicate transition rows in ~15s for a single
    // failing node; a healthy run for one node has a small, bounded transition count.
    const transitions = await taskTransitions.listByTask(task.id);
    expect(transitions.length).toBeLessThan(20);
  });

  describe("crash recovery (docs/11_AGENT_LOOP.md §4.2-4.3)", () => {
    it("resumeAll() auto-resumes a node crashed mid-model-call", async () => {
      const { tasks, taskNodes, taskTransitions, toolRegistry, modelRouter } = harness;

      const task = await tasks.create({ id: "crash-task-1", taskType: "echo_chat", input: { message: "resumed message" } });
      await tasks.updateState(task.id, "EXECUTING");
      const node = await taskNodes.create(task.id, {
        id: "crash-node-1",
        type: "atomic",
        kind: "model_call",
        dependsOn: [],
        input: { messages: [{ role: "user", content: "resumed message" }] },
        timeoutMs: 30_000,
        verificationMethod: "schema_check",
        verificationSpec: { requiredKeys: ["content"] },
        approvalRequired: false,
      });
      // Simulate "crashed while the model call was in flight".
      await taskNodes.update(node.id, { status: "waiting_model" });

      // A fresh engine instance, as a real restarted process would construct.
      const restartedEngine = new AgentEngine({ taskRepo: tasks, nodeRepo: taskNodes, transitionRepo: taskTransitions, toolRegistry, modelRouter });
      await restartedEngine.resumeAll();

      const completed = await waitForTaskState(tasks, task.id, ["COMPLETED", "FAILED"]);
      expect(completed.state).toBe("COMPLETED");
      expect(completed.output?.content).toContain("resumed message");
    });

    it("resumeAll() does NOT auto-retry a mutating tool call crashed mid-flight — surfaces needs_reconciliation + PAUSED instead", async () => {
      const { tasks, taskNodes, taskTransitions, toolRegistry, modelRouter, sandboxRoot } = harness;
      const filePath = join(sandboxRoot, "maybe-deleted.txt");
      writeFileSync(filePath, "unknown fate");

      const task = await tasks.create({ id: "crash-task-2", taskType: "delete_sandbox_file", input: { path: "maybe-deleted.txt" } });
      await tasks.updateState(task.id, "EXECUTING");
      const node = await taskNodes.create(task.id, {
        id: "crash-node-2",
        type: "atomic",
        kind: "tool_call",
        dependsOn: [],
        input: { path: "maybe-deleted.txt" },
        toolId: "fs.delete_file",
        timeoutMs: 30_000,
        verificationMethod: "schema_check",
        verificationSpec: { requiredKeys: ["path"] },
        approvalRequired: false, // already past the approval gate when it crashed
      });
      // Simulate "crashed while a real destructive tool call was in flight" — outcome unknown.
      await taskNodes.update(node.id, { status: "waiting_tool" });

      const restartedEngine = new AgentEngine({ taskRepo: tasks, nodeRepo: taskNodes, transitionRepo: taskTransitions, toolRegistry, modelRouter });
      await restartedEngine.resumeAll();

      // No auto-resume, no tick — verify the state settles immediately, not eventually.
      await new Promise((r) => setTimeout(r, 100));
      const finalTask = await tasks.get(task.id);
      const finalNode = await taskNodes.get(node.id);
      expect(finalTask?.state).toBe("PAUSED");
      expect(finalNode?.status).toBe("needs_reconciliation");
      // The real, load-bearing assertion: an unknown-outcome mutating call is never
      // silently re-executed just because the process restarted.
      expect(existsSync(filePath)).toBe(true);
    });

    it("resumeAll() replans a task that crashed before any nodes were created", async () => {
      const { tasks, taskNodes, engine } = harness;
      const task = await tasks.create({ id: "crash-task-3", taskType: "echo_chat", input: { message: "replanned after crash" } });
      await tasks.updateState(task.id, "PLANNING"); // crashed before planAndExecute created any nodes

      await engine.resumeAll();

      const completed = await waitForTaskState(tasks, task.id, ["COMPLETED", "FAILED"]);
      expect(completed.state).toBe("COMPLETED");
      const nodes = await taskNodes.listByRoot(task.id);
      expect(nodes).toHaveLength(1);
    });
  });
});

/**
 * docs/26_DECISIONS.md ADR-046 — the chat route has always checked quota before a provider
 * call and written a real usage row after it; the engine's model_call nodes went through the
 * same provider and did neither, so an agent task's spend was invisible to GET /api/v1/usage
 * and unbounded by the token limits.
 */
describe("AgentEngine model-call metering", () => {
  let harness: Awaited<ReturnType<typeof setupHarness>>;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    await harness.db.$client.close();
    rmSync(harness.sandboxRoot, { recursive: true, force: true });
  });

  it("checks quota before the call and records the provider's real usage after it", async () => {
    const task = await harness.engine.createAndStart("echo_chat", { message: "meter me" });
    await waitForTaskState(harness.tasks, task.id, ["COMPLETED"]);

    expect(harness.meterChecks.length).toBe(1);
    expect(harness.meterChecks[0]).toBeGreaterThan(0);

    expect(harness.meterCalls.length).toBe(1);
    const recorded = harness.meterCalls[0];
    expect(recorded.provider).toBe("mock");
    expect(recorded.taskId).toBe(task.id);
    // The real figures from the provider's done event, not an estimate.
    expect(recorded.outputTokens).toBeGreaterThan(0);
    const nodes = await harness.taskNodes.listByRoot(task.id);
    expect(nodes.some((n) => n.id === recorded.nodeId)).toBe(true);
  });

  it("refuses the call when quota says no — the node fails with the reason and NOTHING is recorded", async () => {
    harness.meter.allow = false;
    harness.meter.reason = "Daily token limit of 100 would be exceeded (98 used so far today).";

    const task = await harness.engine.createAndStart("echo_chat", { message: "over budget" });
    await waitForTaskState(harness.tasks, task.id, ["FAILED"]);

    expect(harness.meterCalls).toEqual([]);
    const nodes = await harness.taskNodes.listByRoot(task.id);
    expect(nodes[0].status).toBe("failed");
    expect(nodes[0].errorMessage).toMatch(/Daily token limit of 100/);
  });
});

