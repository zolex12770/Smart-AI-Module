import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  organizations,
  projects,
  runMigrations,
  users,
  PgTaskNodeRepository,
  PgTaskRepository,
  PgTaskTransitionRepository,
  type PgliteDb,
  type TaskNodeRecord,
  type TaskNodeRepository,
  type TaskRecord,
  type TaskRepository,
  type TaskTransitionRepository,
} from "@ai-platform/database";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { createFilesystemTools, ToolRegistry } from "@ai-platform/tools";
import type {
  CreateTaskNodeInput,
  NodeStatus,
  RequiresApproval,
  TaskState,
  ToolCallResult,
  ToolDefinition,
} from "@ai-platform/shared";
import { AgentEngine } from "./engine.js";

/**
 * Real, end-to-end coverage of the state machine + dispatcher (docs/11_AGENT_LOOP.md) —
 * previously untested at this level (only `planner.ts`'s pure output was covered). Uses a
 * real in-memory PGlite Postgres, real repositories, a real `ToolRegistry` with real
 * sandboxed filesystem tools, and the real `MockLLMProvider` — no mocked repos/engine
 * internals, matching this project's own "test for real" discipline established across
 * every phase's own integration tests (rag, jobs, media).
 *
 * The one thing that is *not* real is the clock. Retry backoff and node timeouts are
 * deadlines measured in wall-clock time, and a test that proved them by sleeping for a
 * minute would be a test nobody runs; the engine takes its `now` from its dependencies for
 * exactly this reason, so the deadlines under test are the real persisted ones.
 */
function createClock(start = Date.now()) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/**
 * ADR-049 made every task a child of a project and attributed it to a user, and both are
 * real FKs — so a test that wants a task has to be a test that has a tenant. This is the
 * minimum real hierarchy (organization -> project -> member user) rather than a fake id.
 */
async function seedTenancy(db: PgliteDb) {
  const now = new Date();
  const organizationId = "org-engine-test";
  const projectId = "project-engine-test";
  const userId = "user-engine-test";

  await db.insert(organizations).values({ id: organizationId, name: "Engine Test Org", createdAt: now, updatedAt: now });
  await db.insert(projects).values({
    id: projectId,
    organizationId,
    name: "Engine Test Project",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(users).values({
    id: userId,
    email: "engine-test@example.com",
    // Deliberately not a real scrypt encoding: nothing here authenticates, and a fixture
    // that looks like a usable credential is a fixture someone eventually copies.
    passwordHash: "not-a-real-hash-this-fixture-never-authenticates",
    displayName: "Engine Test User",
    createdAt: now,
    updatedAt: now,
  });

  return { organizationId, projectId, userId };
}

/** A tool definition that differs from its neighbours in exactly the field under test. */
function testTool(id: string, requiresApproval: RequiresApproval): ToolDefinition {
  return {
    id,
    name: id,
    description: "engine test fixture",
    origin: { kind: "native", serverId: null, serverVersion: null },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: null,
    permissionLevel: "write_local",
    riskLevel: "medium",
    requiresApproval,
    timeoutMs: 5_000,
    retryPolicy: { maxAttempts: 1, backoff: "none", idempotencyRequired: false },
    enabled: true,
  };
}

async function setupHarness() {
  const db: PgliteDb = await createDb(":memory:");
  await runMigrations(db);
  const { projectId, userId } = await seedTenancy(db);

  const sandboxRoot = mkdtempSync(join(tmpdir(), "engine-test-"));
  // ADR-090: the tools resolve inside the CALLER'S project workspace, so a fixture written to the
  // bare deployment root is not where the agent will look for it.
  const workspaceDir = join(sandboxRoot, projectId);
  mkdirSync(workspaceDir, { recursive: true });

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

  const clock = createClock();
  const engine = new AgentEngine({
    taskRepo: tasks,
    nodeRepo: taskNodes,
    transitionRepo: taskTransitions,
    toolRegistry,
    modelRouter,
    meter,
    workspaceRoot: sandboxRoot,
    now: clock.now,
    // Long enough that no amount of real elapsed time in a test can satisfy a backoff by
    // accident — the deadline is reached only by advancing the clock deliberately.
    retryBackoff: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
  });

  return {
    db,
    sandboxRoot,
    workspaceDir,
    projectId,
    userId,
    clock,
    tasks,
    taskNodes,
    taskTransitions,
    toolRegistry,
    modelRouter,
    engine,
    meter,
    meterCalls,
    meterChecks,
  };
}

type Harness = Awaited<ReturnType<typeof setupHarness>>;

async function waitForTaskState(h: Harness, taskId: string, states: TaskState[], timeoutMs = 5000): Promise<TaskRecord> {
  const start = Date.now();
  while (true) {
    const task = await h.tasks.get(h.projectId, taskId);
    if (task && states.includes(task.state)) return task;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for task ${taskId} to reach one of [${states.join(", ")}] (last state: ${task?.state})`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForNodeStatus(h: Harness, nodeId: string, statuses: NodeStatus[], timeoutMs = 5000): Promise<TaskNodeRecord> {
  const start = Date.now();
  while (true) {
    const node = await h.taskNodes.get(h.projectId, nodeId);
    if (node && statuses.includes(node.status)) return node;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for node ${nodeId} to reach one of [${statuses.join(", ")}] (last status: ${node?.status})`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Builds one task with one hand-written node and lets the engine dispatch it.
 *
 * The planner only ever emits the six shipped task types, so a test that needs a *specific*
 * retry policy or approval mode cannot get there through `createAndStart`. `resumeAll()` is
 * the real, public entry point that picks up already-persisted work — the same path a
 * restarted process takes — rather than a test-only hook into the dispatcher.
 */
async function dispatchNode(h: Harness, node: CreateTaskNodeInput): Promise<{ taskId: string; nodeId: string }> {
  const taskId = `task-${node.id}`;
  await h.tasks.create({
    id: taskId,
    projectId: h.projectId,
    createdByUserId: h.userId,
    taskType: "echo_chat",
    input: {},
  });
  await h.tasks.updateState(taskId, "EXECUTING");
  await h.taskNodes.create(taskId, node);
  await h.engine.resumeAll();
  return { taskId, nodeId: node.id };
}

describe("AgentEngine — real state machine + dispatcher", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    harness.engine.stopScheduler();
    await harness.db.$client.close();
    rmSync(harness.sandboxRoot, { recursive: true, force: true });
  });

  it("completes a single-step echo_chat task end to end", async () => {
    const { engine, taskNodes, projectId, userId } = harness;
    const task = await engine.createAndStart("echo_chat", { message: "hello engine" }, { projectId, userId });

    const completed = await waitForTaskState(harness, task.id, ["COMPLETED", "FAILED"]);
    expect(completed.state).toBe("COMPLETED");
    expect(completed.output?.content).toContain("hello engine");

    const nodes = await taskNodes.listByRoot(projectId, task.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].status).toBe("completed");
  });

  it("attributes the task to the caller's project and user rather than inventing an owner", async () => {
    const { engine, projectId, userId } = harness;
    const task = await engine.createAndStart("echo_chat", { message: "whose task is this" }, { projectId, userId });

    expect(task.projectId).toBe(projectId);
    expect(task.createdByUserId).toBe(userId);
    // The project predicate is the access control (ADR-049): another project's read of the
    // same id must be indistinguishable from the id not existing.
    expect(await harness.tasks.get("some-other-project", task.id)).toBeUndefined();
  });

  it("completes a real multi-step task with dependency + template resolution (read_and_summarize)", async () => {
    const { engine, taskNodes, workspaceDir, projectId, userId } = harness;
    writeFileSync(join(workspaceDir, "notes.txt"), "the secret ingredient is basil");

    const task = await engine.createAndStart(
      "read_and_summarize",
      { path: "notes.txt", question: "what is the secret?" },
      { projectId, userId }
    );
    const completed = await waitForTaskState(harness, task.id, ["COMPLETED", "FAILED"]);

    expect(completed.state).toBe("COMPLETED");
    // The mock provider echoes back what it received — proves the file's real content was
    // actually resolved through the {{node.output.content}} template into the model input.
    expect(completed.output?.content).toContain("the secret ingredient is basil");

    const nodes = await taskNodes.listByRoot(projectId, task.id);
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.status === "completed")).toBe(true);
  });

  it("gates a destructive tool call on human approval, and approving it actually executes the action", async () => {
    const { engine, taskNodes, workspaceDir, projectId, userId } = harness;
    const filePath = join(workspaceDir, "to-delete.txt");
    writeFileSync(filePath, "delete me");

    const task = await engine.createAndStart("delete_sandbox_file", { path: "to-delete.txt" }, { projectId, userId });
    const waiting = await waitForTaskState(harness, task.id, ["WAITING_FOR_APPROVAL", "FAILED", "COMPLETED"]);
    expect(waiting.state).toBe("WAITING_FOR_APPROVAL");
    expect(existsSync(filePath)).toBe(true); // not touched while waiting

    const nodes = await taskNodes.listByRoot(projectId, task.id);
    expect(nodes[0].status).toBe("waiting_approval");

    await engine.approve(task.id, nodes[0].id, "test-operator");
    const completed = await waitForTaskState(harness, task.id, ["COMPLETED", "FAILED"]);
    expect(completed.state).toBe("COMPLETED");
    expect(existsSync(filePath)).toBe(false); // real side effect actually happened
  });

  it("rejecting an approval-gated tool call cancels the task and never executes the action", async () => {
    const { engine, taskNodes, workspaceDir, projectId, userId } = harness;
    const filePath = join(workspaceDir, "keep-me.txt");
    writeFileSync(filePath, "do not delete");

    const task = await engine.createAndStart("delete_sandbox_file", { path: "keep-me.txt" }, { projectId, userId });
    await waitForTaskState(harness, task.id, ["WAITING_FOR_APPROVAL"]);
    const nodes = await taskNodes.listByRoot(projectId, task.id);

    await engine.reject(task.id, nodes[0].id, "test-operator");
    const finalTask = await waitForTaskState(harness, task.id, ["CANCELLED", "COMPLETED", "FAILED"]);

    expect(finalTask.state).toBe("CANCELLED");
    expect(existsSync(filePath)).toBe(true); // the real, load-bearing assertion
  });

  it("cancel() stops a task and marks its non-terminal nodes cancelled", async () => {
    const { engine, tasks, taskNodes, workspaceDir, projectId, userId } = harness;
    writeFileSync(join(workspaceDir, "x.txt"), "x");
    const task = await engine.createAndStart("delete_sandbox_file", { path: "x.txt" }, { projectId, userId });
    await waitForTaskState(harness, task.id, ["WAITING_FOR_APPROVAL"]);

    await engine.cancel(task.id, "test-operator");
    const finalTask = await tasks.get(projectId, task.id);
    expect(finalTask?.state).toBe("CANCELLED");
    const nodes = await taskNodes.listByRoot(projectId, task.id);
    expect(nodes[0].status).toBe("cancelled");
  });

  it("subscribe() emits state and node events, in order, for a real run", async () => {
    const { engine, projectId, userId } = harness;
    const events: string[] = [];
    const task = await engine.createAndStart("echo_chat", { message: "event order test" }, { projectId, userId });
    const unsubscribe = engine.subscribe(task.id, (e) => events.push(e.type));

    await waitForTaskState(harness, task.id, ["COMPLETED", "FAILED"]);
    // Give the final "completed" emit a tick to land after the state flip.
    await new Promise((r) => setTimeout(r, 20));
    unsubscribe();

    expect(events).toContain("node");
    expect(events[events.length - 1]).toBe("completed");
  });

  it("a task whose tool call fails ends FAILED without an unbounded cascade loop (regression: docs/26 ADR history)", async () => {
    const { engine, taskTransitions, projectId, userId } = harness;
    // fs.delete_file on a path that doesn't exist — a real, clean tool-level failure.
    const task = await engine.createAndStart("delete_sandbox_file", { path: "does-not-exist.txt" }, { projectId, userId });
    const waiting = await waitForTaskState(harness, task.id, ["WAITING_FOR_APPROVAL"]);
    expect(waiting.state).toBe("WAITING_FOR_APPROVAL");
    const nodes = await harness.taskNodes.listByRoot(projectId, task.id);
    await engine.approve(task.id, nodes[0].id, "test-operator");

    const finalTask = await waitForTaskState(harness, task.id, ["FAILED", "COMPLETED"]);
    expect(finalTask.state).toBe("FAILED");

    // The historical bug produced 45,000+ duplicate transition rows in ~15s for a single
    // failing node; a healthy run for one node has a small, bounded transition count.
    const transitions = await taskTransitions.listByTask(projectId, task.id);
    expect(transitions.length).toBeLessThan(20);
  });

  describe("crash recovery (docs/11_AGENT_LOOP.md §4.2-4.3)", () => {
    it("resumeAll() auto-resumes a node crashed mid-model-call", async () => {
      const { tasks, taskNodes, taskTransitions, toolRegistry, modelRouter, projectId, userId } = harness;

      const task = await tasks.create({
        id: "crash-task-1",
        projectId,
        createdByUserId: userId,
        taskType: "echo_chat",
        input: { message: "resumed message" },
      });
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

      const completed = await waitForTaskState(harness, task.id, ["COMPLETED", "FAILED"]);
      expect(completed.state).toBe("COMPLETED");
      expect(completed.output?.content).toContain("resumed message");
    });

    it("resumeAll() does NOT auto-retry a mutating tool call crashed mid-flight — surfaces needs_reconciliation + PAUSED instead", async () => {
      const { tasks, taskNodes, taskTransitions, toolRegistry, modelRouter, workspaceDir, projectId, userId } = harness;
      const filePath = join(workspaceDir, "maybe-deleted.txt");
      writeFileSync(filePath, "unknown fate");

      const task = await tasks.create({
        id: "crash-task-2",
        projectId,
        createdByUserId: userId,
        taskType: "delete_sandbox_file",
        input: { path: "maybe-deleted.txt" },
      });
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
      const finalTask = await tasks.get(projectId, task.id);
      const finalNode = await taskNodes.get(projectId, node.id);
      expect(finalTask?.state).toBe("PAUSED");
      expect(finalNode?.status).toBe("needs_reconciliation");
      // The real, load-bearing assertion: an unknown-outcome mutating call is never
      // silently re-executed just because the process restarted.
      expect(existsSync(filePath)).toBe(true);
    });

    it("resumeAll() replans a task that crashed before any nodes were created", async () => {
      const { tasks, taskNodes, engine, projectId, userId } = harness;
      const task = await tasks.create({
        id: "crash-task-3",
        projectId,
        createdByUserId: userId,
        taskType: "echo_chat",
        input: { message: "replanned after crash" },
      });
      await tasks.updateState(task.id, "PLANNING"); // crashed before planAndExecute created any nodes

      await engine.resumeAll();

      const completed = await waitForTaskState(harness, task.id, ["COMPLETED", "FAILED"]);
      expect(completed.state).toBe("COMPLETED");
      const nodes = await taskNodes.listByRoot(projectId, task.id);
      expect(nodes).toHaveLength(1);
    });
  });
});

/**
 * docs/11_AGENT_LOOP.md §4.3 — `retryPolicy.backoff` was chosen by the planner, written to
 * the row and then read by nothing: every retry went straight back into the very next
 * dispatcher pass, so `exponential` and `none` were the same behaviour and a flapping tool
 * was retried as fast as the loop could turn. These tests pin the delay down as a real,
 * persisted deadline that gates re-dispatch.
 */
describe("AgentEngine — retry backoff is actually applied", () => {
  let harness: Harness;
  let calls: number;

  beforeEach(async () => {
    harness = await setupHarness();
    calls = 0;
    harness.toolRegistry.register(testTool("test.always_fails", "never"), async (): Promise<ToolCallResult> => {
      calls++;
      return { ok: false, error: "the remote end is flapping" };
    });
  });

  afterEach(async () => {
    harness.engine.stopScheduler();
    await harness.db.$client.close();
    rmSync(harness.sandboxRoot, { recursive: true, force: true });
  });

  const failingNode = (id: string): CreateTaskNodeInput => ({
    id,
    type: "atomic",
    kind: "tool_call",
    dependsOn: [],
    input: {},
    toolId: "test.always_fails",
    timeoutMs: 30_000,
    verificationMethod: "none",
    approvalRequired: false,
    retryPolicy: { maxAttempts: 3, backoff: "exponential", classifyFailureAs: null },
  });

  it("does not re-dispatch a retrying node before its backoff has elapsed, and does once it has", async () => {
    const { engine, clock, taskNodes, projectId } = harness;
    const { nodeId } = await dispatchNode(harness, failingNode("retry-node"));

    const retrying = await waitForNodeStatus(harness, nodeId, ["retrying", "failed"]);
    expect(retrying.status).toBe("retrying");
    expect(calls).toBe(1);
    // The delay is persisted, not held in a timer — that is what survives a restart.
    expect(retrying.nextAttemptAt).toBe(clock.now() + 60_000);

    // The load-bearing assertion: a scheduler pass *before* the deadline must change
    // nothing. Under the old behaviour the node was already `pending` by this point and
    // would have been re-run immediately.
    await engine.sweep();
    expect(calls).toBe(1);
    expect((await taskNodes.get(projectId, nodeId))?.status).toBe("retrying");

    clock.advance(60_001);
    await engine.sweep();
    expect(calls).toBe(2);
  });

  it("gives up after maxAttempts and fails the node, rather than backing off forever", async () => {
    const { engine, clock } = harness;
    const { taskId, nodeId } = await dispatchNode(harness, failingNode("retry-exhaust-node"));

    await waitForNodeStatus(harness, nodeId, ["retrying"]);
    clock.advance(60_001);
    await engine.sweep(); // attempt 2
    clock.advance(60_001);
    await engine.sweep(); // attempt 3 — maxAttempts reached

    const failed = await waitForNodeStatus(harness, nodeId, ["failed"]);
    expect(calls).toBe(3);
    expect(failed.attemptCount).toBe(3);
    expect(failed.errorMessage).toContain("the remote end is flapping");
    // Retry exhaustion is recorded as what it was, so a future replanner has the input.
    expect(failed.failureClass).toBe("retryable-execution");
    expect(failed.nextAttemptAt).toBeNull();

    const task = await waitForTaskState(harness, taskId, ["FAILED"]);
    expect(task.state).toBe("FAILED");
  });
});

/**
 * docs/11_AGENT_LOOP.md §3.1's per-node `timeoutMs` — planned, persisted, and previously
 * enforced by nothing at all. A `model_call` node had no deadline whatsoever, and a tool call
 * was bounded only by the tool's own registry timeout, not the plan's.
 */
describe("AgentEngine — node timeoutMs is actually enforced", () => {
  let harness: Harness;
  let releaseHandler: () => void;
  let handlerReturned: Promise<void>;

  beforeEach(async () => {
    harness = await setupHarness();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseHandler = release;
    handlerReturned = blocked;
    harness.toolRegistry.register(testTool("test.hangs", "never"), async (): Promise<ToolCallResult> => {
      await blocked;
      return { ok: true, output: { done: true } };
    });
  });

  afterEach(async () => {
    // Let the blocked handler finish so its promise (and the registry's own timeout timer)
    // are not left dangling past the test.
    releaseHandler();
    await handlerReturned;
    harness.engine.stopScheduler();
    await harness.db.$client.close();
    rmSync(harness.sandboxRoot, { recursive: true, force: true });
  });

  it("fails a node that runs past its own timeout, and a late tool result cannot resurrect it", async () => {
    const { taskNodes, projectId } = harness;
    const { nodeId } = await dispatchNode(harness, {
      id: "timeout-node",
      type: "atomic",
      kind: "tool_call",
      dependsOn: [],
      input: {},
      toolId: "test.hangs",
      timeoutMs: 50,
      verificationMethod: "none",
      approvalRequired: false,
      retryPolicy: { maxAttempts: 1, backoff: "none", classifyFailureAs: null },
    });

    const failed = await waitForNodeStatus(harness, nodeId, ["failed"]);
    expect(failed.errorMessage).toContain("exceeded its 50ms timeout");
    expect(failed.startedAt).toBeNull();

    // The handler is still running at this point. Releasing it must not turn a node the
    // deadline already killed back into a completed one.
    releaseHandler();
    await handlerReturned;
    await new Promise((r) => setTimeout(r, 50));
    expect((await taskNodes.get(projectId, nodeId))?.status).toBe("failed");
  });
});

/**
 * docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3.1's four approval modes, ADR-059. The planner used
 * to reduce `requiresApproval` to `!== "never"` at plan time, which made `first_use` and
 * `risk_threshold` indistinguishable from `always`. The decision now belongs to the registry
 * and is taken at dispatch, so these two nodes are byte-for-byte identical apart from which
 * tool they name — the mode alone decides whether a human is asked.
 */
describe("AgentEngine — approval mode is resolved by the registry at dispatch time", () => {
  let harness: Harness;
  let invoked: string[];

  beforeEach(async () => {
    harness = await setupHarness();
    invoked = [];
    for (const mode of ["never", "always"] as const) {
      const id = `test.approval_${mode}`;
      harness.toolRegistry.register(testTool(id, mode), async (): Promise<ToolCallResult> => {
        invoked.push(id);
        return { ok: true, output: { ran: id } };
      });
    }
  });

  afterEach(async () => {
    harness.engine.stopScheduler();
    await harness.db.$client.close();
    rmSync(harness.sandboxRoot, { recursive: true, force: true });
  });

  const nodeFor = (toolId: string, id: string): CreateTaskNodeInput => ({
    id,
    type: "atomic",
    kind: "tool_call",
    dependsOn: [],
    input: {},
    toolId,
    timeoutMs: 30_000,
    verificationMethod: "none",
    // No plan-level gate on either node: the whole point is that the mode, not the plan,
    // is what decides.
    approvalRequired: false,
  });

  it('"never" really does skip the gate — the tool runs without anyone being asked', async () => {
    const { taskId, nodeId } = await dispatchNode(harness, nodeFor("test.approval_never", "approval-never-node"));

    const node = await waitForNodeStatus(harness, nodeId, ["completed", "failed", "waiting_approval"]);
    expect(node.status).toBe("completed");
    expect(invoked).toEqual(["test.approval_never"]);
    const task = await waitForTaskState(harness, taskId, ["COMPLETED"]);
    expect(task.state).toBe("COMPLETED");
  });

  it('"always" really does stop — nothing runs until a human approves, and then it does', async () => {
    const { engine } = harness;
    const { taskId, nodeId } = await dispatchNode(harness, nodeFor("test.approval_always", "approval-always-node"));

    const gated = await waitForNodeStatus(harness, nodeId, ["waiting_approval", "completed", "failed"]);
    expect(gated.status).toBe("waiting_approval");
    expect(invoked).toEqual([]); // the load-bearing assertion: it did NOT run
    const waiting = await waitForTaskState(harness, taskId, ["WAITING_FOR_APPROVAL"]);
    expect(waiting.state).toBe("WAITING_FOR_APPROVAL");

    await engine.approve(taskId, nodeId, "test-operator");
    const completed = await waitForNodeStatus(harness, nodeId, ["completed", "failed"]);
    expect(completed.status).toBe("completed");
    expect(completed.approvedBy).toBe("test-operator");
    expect(invoked).toEqual(["test.approval_always"]);
  });

  it("passes the task's own project and user to the tool, never a default", async () => {
    const { toolRegistry, projectId, userId } = harness;
    const seen: Array<{ projectId: string; userId: string; workspaceRoot?: string }> = [];
    toolRegistry.register(testTool("test.records_context", "never"), async (_args, context): Promise<ToolCallResult> => {
      seen.push({ projectId: context.projectId, userId: context.userId, workspaceRoot: context.workspaceRoot });
      return { ok: true, output: {} };
    });

    const { nodeId } = await dispatchNode(harness, nodeFor("test.records_context", "context-node"));
    await waitForNodeStatus(harness, nodeId, ["completed", "failed"]);

    expect(seen).toEqual([{ projectId, userId, workspaceRoot: harness.sandboxRoot }]);
  });
});

/**
 * docs/26_DECISIONS.md ADR-046 — the chat route has always checked quota before a provider
 * call and written a real usage row after it; the engine's model_call nodes went through the
 * same provider and did neither, so an agent task's spend was invisible to GET /api/v1/usage
 * and unbounded by the token limits.
 */
describe("AgentEngine model-call metering", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    harness.engine.stopScheduler();
    await harness.db.$client.close();
    rmSync(harness.sandboxRoot, { recursive: true, force: true });
  });

  it("checks quota before the call and records the provider's real usage after it", async () => {
    const { projectId, userId } = harness;
    const task = await harness.engine.createAndStart("echo_chat", { message: "meter me" }, { projectId, userId });
    await waitForTaskState(harness, task.id, ["COMPLETED"]);

    expect(harness.meterChecks.length).toBe(1);
    expect(harness.meterChecks[0]).toBeGreaterThan(0);

    expect(harness.meterCalls.length).toBe(1);
    const recorded = harness.meterCalls[0];
    expect(recorded.provider).toBe("mock");
    expect(recorded.taskId).toBe(task.id);
    // The real figures from the provider's done event, not an estimate.
    expect(recorded.outputTokens).toBeGreaterThan(0);
    const nodes = await harness.taskNodes.listByRoot(projectId, task.id);
    expect(nodes.some((n) => n.id === recorded.nodeId)).toBe(true);
  });

  it("refuses the call when quota says no — the node fails with the reason and NOTHING is recorded", async () => {
    const { projectId, userId } = harness;
    harness.meter.allow = false;
    harness.meter.reason = "Daily token limit of 100 would be exceeded (98 used so far today).";

    const task = await harness.engine.createAndStart("echo_chat", { message: "over budget" }, { projectId, userId });
    await waitForTaskState(harness, task.id, ["FAILED"]);

    expect(harness.meterCalls).toEqual([]);
    const nodes = await harness.taskNodes.listByRoot(projectId, task.id);
    expect(nodes[0].status).toBe("failed");
    expect(nodes[0].errorMessage).toMatch(/Daily token limit of 100/);
  });
});

/**
 * The execution lease, actually taken — docs/26_DECISIONS.md ADR-052, wired by ADR-151.
 *
 * `claimLease`, `renewLease` and `releaseLease` shipped with careful single-statement SQL and a
 * schema comment reading "A process may only dispatch a task whose lease it holds… This is what
 * makes two API instances against one database safe". A repo-wide grep for all three names
 * returned the repository that defines them and nothing else — no caller, not even a test — so
 * `tasks.lease_owner` was permanently NULL, `tasks_lease_idx` indexed an always-NULL column, and
 * two instances dispatched every task twice. The comment described a mechanism nobody switched
 * on, which is worse than no mechanism: it is a safety claim that reads as tested.
 */
describe("the execution lease", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    harness.engine.stopScheduler();
    await harness.db.$client.close();
    rmSync(harness.sandboxRoot, { recursive: true, force: true });
  });

  const seedRunnableTask = async () => {
    const { tasks, taskNodes, projectId, userId, workspaceDir } = harness;
    writeFileSync(join(workspaceDir, "leased.txt"), "hello from the lease test");
    const task = await tasks.create({
      id: `lease-task-${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      createdByUserId: userId,
      taskType: "echo_chat",
      input: { path: "leased.txt" },
    });
    await tasks.updateState(task.id, "EXECUTING");
    const node = await taskNodes.create(task.id, {
      id: `lease-node-${task.id}`,
      type: "atomic",
      kind: "tool_call",
      dependsOn: [],
      input: { path: "leased.txt" },
      toolId: "fs.read_file",
      timeoutMs: 30_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["content"] },
      approvalRequired: false,
    });
    return { task, node };
  };

  const secondInstance = () =>
    new AgentEngine({
      taskRepo: harness.tasks,
      nodeRepo: harness.taskNodes,
      transitionRepo: harness.taskTransitions,
      toolRegistry: harness.toolRegistry,
      modelRouter: harness.modelRouter,
      workspaceRoot: harness.sandboxRoot,
      instanceId: "instance-b",
    });

  it("does not dispatch a task another live instance holds", async () => {
    const { task, node } = await seedRunnableTask();

    // Instance A is mid-dispatch: it holds the lease, taken through the same SQL the engine uses.
    expect(await harness.tasks.claimLease(task.id, "instance-a", 60_000)).toBe(true);

    await secondInstance().resumeAll();
    // Settled immediately, not eventually: the point is that nothing was started.
    await new Promise((r) => setTimeout(r, 200));

    const after = await harness.taskNodes.get(harness.projectId, node.id);
    expect(after?.status).toBe("pending");
    // And instance A still owns it — a refused dispatch must not steal the lease either.
    const row = await harness.tasks.getUnscoped(task.id);
    expect(row?.state).toBe("EXECUTING");
  });

  it("dispatches it once that instance's lease is released", async () => {
    // The other half: a guard that refuses everything is indistinguishable from a broken engine.
    const { task, node } = await seedRunnableTask();
    expect(await harness.tasks.claimLease(task.id, "instance-a", 60_000)).toBe(true);
    await harness.tasks.releaseLease(task.id, "instance-a");

    const engineB = secondInstance();
    await engineB.resumeAll();

    const finished = await waitForNodeStatus(harness, node.id, ["completed", "failed"]);
    expect(finished.status).toBe("completed");
  });

  it("takes over a task whose owner died, once the lease has lapsed", async () => {
    // A lease is a deadline, not a latch: an instance killed mid-dispatch must not strand the
    // task forever, which is the whole reason `claimLease` treats an expired lease as free.
    const { task, node } = await seedRunnableTask();
    // Claimed and already expired — what a crashed instance leaves behind a minute later.
    expect(await harness.tasks.claimLease(task.id, "dead-instance", -1_000)).toBe(true);

    await secondInstance().resumeAll();

    const finished = await waitForNodeStatus(harness, node.id, ["completed", "failed"]);
    expect(finished.status).toBe("completed");
  });

  it("releases the lease when the dispatch finishes", async () => {
    // Otherwise the next dispatch of this task, on any instance, waits out a TTL for work that
    // has already finished.
    const { task, node } = await seedRunnableTask();
    await secondInstance().resumeAll();
    await waitForNodeStatus(harness, node.id, ["completed", "failed"]);

    const row = await harness.tasks.getUnscoped(task.id);
    expect(row?.leaseOwner ?? null).toBeNull();
  });
});
