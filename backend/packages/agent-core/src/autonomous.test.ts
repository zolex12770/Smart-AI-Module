import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  runMigrations,
  organizations,
  projects,
  users,
  PgTaskNodeRepository,
  PgTaskRepository,
  PgTaskTransitionRepository,
  type PgliteDb,
} from "@ai-platform/database";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { createCodingTools, createFilesystemTools, createSearchTools, ToolRegistry, type NativeToolEntry } from "@ai-platform/tools";
import type {
  ChatRequest,
  ChatStreamEvent,
  LLMProvider,
  ProviderCapabilities,
  Task,
  ToolCall,
} from "@ai-platform/shared";
import { PermissionError } from "@ai-platform/shared";
import { AgentEngine } from "./engine.js";

/**
 * docs/26_DECISIONS.md ADR-064 — the proof that the two agent architectures are actually
 * unified.
 *
 * Before this, the repository contained a deterministic task-graph engine AND a model-driven
 * reasoning loop, and nothing connected them: `POST /api/v1/agent/tasks` could only ever run a
 * hardcoded recipe, and the reasoning loop was infrastructure nobody could reach. The audit
 * called that out, and the honest reading was that the platform's "agent" was a workflow
 * runner.
 *
 * These tests create a real task through the real engine, against a real Postgres, and assert
 * that the MODEL chose the tools, that the tools really ran, that the filesystem really
 * changed, and that the harness's ceilings still bound the model. The provider is scripted —
 * there is no model server in this environment — but it is scripted at the protocol level and
 * the engine cannot tell the difference.
 */

/** A provider that emits real tool-call events from a script of turns. */
class ScriptedAgentProvider implements LLMProvider {
  readonly name = "scripted";
  readonly isMock = false;
  readonly model = "scripted-1";
  readonly turnsSeen: number[] = [];
  /** Every transcript this provider was handed, so a test can assert what the model SAW.
   *  A provider rejects an assistant turn whose tool calls lack results, and that rejection
   *  is invisible to a scripted provider unless the test checks the shape itself. */
  readonly requestsSeen: ChatRequest[] = [];
  private index = 0;

  constructor(private readonly turns: Array<{ text?: string; calls?: ToolCall[] }>) {}

  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, structuredOutput: false, vision: false, contextWindow: null };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    this.turnsSeen.push(request.messages.length);
    this.requestsSeen.push(request);
    const turn = this.turns[Math.min(this.index++, this.turns.length - 1)];
    const calls = turn.calls ?? [];
    for (const call of calls) yield { type: "tool_call", call };
    if (turn.text) yield { type: "token", delta: turn.text };
    yield {
      type: "done",
      message: { role: "assistant", content: turn.text ?? "", ...(calls.length ? { toolCalls: calls } : {}) },
      usage: { inputTokens: 20, outputTokens: 10 },
      provider: this.name,
      model: this.model,
      finishReason: calls.length ? "tool_calls" : "stop",
    };
  }
}

const ORG = "org-auto";
const PROJECT = "project-auto";
const USER = "user-auto";

describe("autonomous tasks run through the model-driven loop (ADR-064)", () => {
  let db: PgliteDb;
  let sandboxRoot: string;
  let workspaceDir: string;
  let tasks: PgTaskRepository;
  let nodes: PgTaskNodeRepository;

  const build = (
    turns: Array<{ text?: string; calls?: ToolCall[] }>,
    limits?: { maxIterations?: number },
    extraTools: NativeToolEntry[] = []
  ) => {
    const provider = new ScriptedAgentProvider(turns);
    const registry = new ModelRegistry();
    registry.register(provider, { asDefault: true });

    const toolRegistry = new ToolRegistry();
    for (const { definition, handler } of [
      ...createFilesystemTools(sandboxRoot),
      ...createSearchTools(sandboxRoot),
      ...createCodingTools(sandboxRoot),
      ...extraTools,
    ]) {
      toolRegistry.register(definition, handler);
    }

    const engine = new AgentEngine({
      taskRepo: tasks,
      nodeRepo: nodes,
      transitionRepo: new PgTaskTransitionRepository(db),
      toolRegistry,
      modelRouter: new ModelRouter(registry),
      workspaceRoot: sandboxRoot,
      agentLimits: limits,
    });
    return { engine, provider, toolRegistry };
  };

  const waitFor = async (taskId: string, states: Task["state"][], timeoutMs = 15_000): Promise<Task> => {
    const start = Date.now();
    for (;;) {
      const task = await tasks.getUnscoped(taskId);
      if (task && states.includes(task.state)) return task;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for ${states.join("/")}; last state was ${task?.state}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    sandboxRoot = mkdtempSync(join(tmpdir(), "autonomous-"));
    // ADR-090: the filesystem tools resolve inside the CALLER'S project workspace, so a
    // fixture written to the bare deployment root is not where the agent will look.
    workspaceDir = join(sandboxRoot, PROJECT);
    mkdirSync(workspaceDir, { recursive: true });
    const now = new Date();
    await db.insert(organizations).values({ id: ORG, name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "a@example.com", passwordHash: "x", displayName: "A", createdAt: now, updatedAt: now });
    await db
      .insert(projects)
      .values({ id: PROJECT, organizationId: ORG, name: "P", createdAt: now, updatedAt: now });
    tasks = new PgTaskRepository(db);
    nodes = new PgTaskNodeRepository(db);
  });

  afterEach(async () => {
    await db.$client.close();
    try {
      rmSync(sandboxRoot, { recursive: true, force: true });
    } catch {
      /* windows may hold a handle briefly */
    }
  });

  it("lets the model choose a tool, run it, read the result, and finish — with a real file changed", async () => {
    writeFileSync(join(workspaceDir, "answer.txt"), "the answer is 41\n");

    const { engine, provider } = build([
      // Turn 1: the model decides to look at the file. Nothing in the plan told it to.
      {
        calls: [{ id: "c1", name: "fs.read_file", arguments: { path: "answer.txt" } }],
      },
      // Turn 2: having read it, it decides to correct it.
      {
        calls: [
          {
            id: "c2",
            name: "code.apply_patch",
            arguments: {
              diff: [
                "--- a/answer.txt",
                "+++ b/answer.txt",
                "@@ -1 +1 @@",
                "-the answer is 41",
                "+the answer is 42",
              ].join("\n"),
            },
          },
        ],
      },
      { text: "I read answer.txt, found 41, and corrected it to 42." },
    ]);

    const task = await engine.createAndStart(
      "autonomous",
      { goal: "The answer in answer.txt is wrong. Fix it." },
      { projectId: PROJECT, userId: USER }
    );
    const finished = await waitFor(task.id, ["COMPLETED"]);

    expect(finished.state).toBe("COMPLETED");
    // The real, observable outcome: the file on disk changed.
    expect(readFileSync(join(workspaceDir, "answer.txt"), "utf8")).toContain("42");

    // The model was called three times, each turn seeing a longer transcript than the last —
    // which is what makes it a reasoning loop rather than three unrelated calls.
    expect(provider.turnsSeen).toHaveLength(3);
    expect(provider.turnsSeen[1]).toBeGreaterThan(provider.turnsSeen[0]);
    expect(provider.turnsSeen[2]).toBeGreaterThan(provider.turnsSeen[1]);

    const [node] = await nodes.listByRootUnscoped(task.id);
    expect(node.kind).toBe("reasoning");
    expect(node.status).toBe("completed");
    expect(node.output).toMatchObject({ toolCallCount: 2 });
  });

  it("feeds a tool FAILURE back to the model, which recovers instead of the task failing", async () => {
    const { engine } = build([
      // The model guesses a path that does not exist.
      { calls: [{ id: "c1", name: "fs.read_file", arguments: { path: "does-not-exist.txt" } }] },
      // Having seen the error, it searches instead of guessing again.
      { calls: [{ id: "c2", name: "fs.glob", arguments: { pattern: "**/*.txt" } }] },
      { text: "That file does not exist; the workspace is empty." },
    ]);

    const task = await engine.createAndStart(
      "autonomous",
      { goal: "Read the notes file." },
      { projectId: PROJECT, userId: USER }
    );
    const finished = await waitFor(task.id, ["COMPLETED", "FAILED"]);

    // A failed tool call is an observation, not a task failure.
    expect(finished.state).toBe("COMPLETED");
    expect(String((finished.output as { content?: string })?.content)).toContain("does not exist");
  });

  it("stops at the harness's iteration ceiling when the model will not stop calling tools", async () => {
    writeFileSync(join(workspaceDir, "loop.txt"), "x\n");
    const { engine } = build(
      [{ calls: [{ id: "c", name: "fs.read_file", arguments: { path: "loop.txt" } }] }],
      { maxIterations: 3 }
    );

    const task = await engine.createAndStart(
      "autonomous",
      { goal: "Loop forever." },
      { projectId: PROJECT, userId: USER }
    );
    const finished = await waitFor(task.id, ["FAILED", "COMPLETED"]);

    // The model would have gone on indefinitely; the harness is what stopped it, and it is
    // recorded as a failure with the reason rather than as a finished answer.
    expect(finished.state).toBe("FAILED");
    const [node] = await nodes.listByRootUnscoped(task.id);
    expect(node.errorMessage).toMatch(/max_iterations/);
  });

  it("parks for human approval when the model reaches for a destructive tool, without running it", async () => {
    const doomed = join(workspaceDir, "important.txt");
    writeFileSync(doomed, "please do not delete me\n");

    const { engine } = build([
      { calls: [{ id: "c1", name: "fs.delete_file", arguments: { path: "important.txt" } }] },
      { text: "Deleted." },
    ]);

    const task = await engine.createAndStart(
      "autonomous",
      { goal: "Delete important.txt" },
      { projectId: PROJECT, userId: USER }
    );
    await waitFor(task.id, ["WAITING_FOR_APPROVAL"]);

    const [node] = await nodes.listByRootUnscoped(task.id);
    expect(node.status).toBe("waiting_approval");
    // The gate is real: the file is still there.
    expect(readFileSync(doomed, "utf8")).toContain("please do not delete me");
    // And the reasoning that led here was preserved, so approving does not restart the task.
    expect(node.output).toMatchObject({ pendingCall: { name: "fs.delete_file" } });
    expect((node.output as { resume?: { transcript?: unknown[] } }).resume?.transcript?.length).toBeGreaterThan(0);
  });

  it("resumes from the preserved transcript once a human approves, and completes the action", async () => {
    const doomed = join(workspaceDir, "important.txt");
    writeFileSync(doomed, "please do not delete me\n");

    const { engine } = build([
      { calls: [{ id: "c1", name: "fs.delete_file", arguments: { path: "important.txt" } }] },
      { text: "Deleted important.txt as requested." },
    ]);

    const task = await engine.createAndStart(
      "autonomous",
      { goal: "Delete important.txt" },
      { projectId: PROJECT, userId: USER }
    );
    await waitFor(task.id, ["WAITING_FOR_APPROVAL"]);
    const [parked] = await nodes.listByRootUnscoped(task.id);

    await engine.approve(task.id, parked.id, USER);
    const finished = await waitFor(task.id, ["COMPLETED", "FAILED"]);

    expect(finished.state).toBe("COMPLETED");
    // The approved action really happened.
    expect(() => readFileSync(doomed, "utf8")).toThrow();
  });

  it("refuses an autonomous task with no goal rather than running an empty prompt", async () => {
    const { engine } = build([{ text: "nothing to do" }]);
    const task = await engine.createAndStart("autonomous", {}, { projectId: PROJECT, userId: USER });
    const finished = await waitFor(task.id, ["FAILED"]);
    expect(finished.errorMessage).toMatch(/goal/i);
  });

  /**
   * A multi-call turn that pauses for approval — docs/26_DECISIONS.md ADR-099.
   *
   * The loop stopped at the FIRST call needing approval and parked without appending a `tool`
   * message for it, or for any call the model had requested after it. The parked transcript
   * therefore held an assistant turn with three tool calls and one result — a shape OpenAI,
   * Anthropic and Google all reject outright. The approval was recorded, the node resumed, and
   * the first provider call of the resumed run failed.
   *
   * A scripted provider accepts anything, which is exactly why this asserts the SHAPE of the
   * transcript the model was handed rather than merely that the run completed.
   */
  it("parks and resumes a multi-call turn with a result for every tool call", async () => {
    const ran: string[] = [];
    const tool = (id: string, gated: boolean): NativeToolEntry => ({
      definition: {
        id,
        name: id,
        description: `test tool ${id}`,
        origin: { kind: "native", serverId: null, serverVersion: null },
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: null,
        permissionLevel: gated ? "destructive" : "read_only",
        riskLevel: gated ? "high" : "low",
        requiresApproval: gated ? ("always" as const) : ("never" as const),
        timeoutMs: 10_000,
        retryPolicy: { maxAttempts: 1, backoff: "fixed", idempotencyRequired: false },
        enabled: true,
      },
      handler: async () => {
        ran.push(id);
        return { ok: true, output: { ran: id } };
      },
    });

    const { engine, provider } = build(
      [
        // One turn, three calls: the first runs, the second needs a human, the third was never
        // reached. All three are in the assistant turn the transcript now carries.
        {
          calls: [
            { id: "call-free", name: "test.free", arguments: {} },
            { id: "call-gated", name: "test.gated", arguments: {} },
            { id: "call-after", name: "test.after", arguments: {} },
          ],
        },
        { text: "Done." },
      ],
      undefined,
      [tool("test.free", false), tool("test.gated", true), tool("test.after", false)]
    );

    const task = await engine.createAndStart(
      "autonomous",
      { goal: "Do the three things." },
      { projectId: PROJECT, userId: USER }
    );
    await waitFor(task.id, ["WAITING_FOR_APPROVAL"]);

    const [parked] = await nodes.listByRootUnscoped(task.id);
    expect(parked.status).toBe("waiting_approval");
    // Only the first call ran; the gated one did not, and neither did the one after it.
    expect(ran).toEqual(["test.free"]);

    // Both un-executed calls are persisted, not just the one a human was asked about.
    const pendingCalls = (parked.output as { pendingCalls?: Array<{ id: string }> }).pendingCalls ?? [];
    expect(pendingCalls.map((c) => c.id)).toEqual(["call-gated", "call-after"]);

    await engine.approve(task.id, parked.id, "test-operator");
    const finished = await waitFor(task.id, ["COMPLETED", "FAILED"]);
    expect(finished.state).toBe("COMPLETED");

    // The approved call ran; the one after it did not, because nobody approved it.
    expect(ran).toEqual(["test.free", "test.gated"]);

    // THE LOAD-BEARING ASSERTION: in the transcript the model was handed on resume, every tool
    // call in every assistant turn has a matching `tool` message. This is precisely the
    // invariant a real provider enforces, and precisely what parking used to break.
    const resumed = provider.requestsSeen.at(-1);
    expect(resumed).toBeDefined();
    const resultIds = new Set(
      resumed!.messages.filter((m) => m.role === "tool").map((m) => (m as { toolCallId?: string }).toolCallId)
    );
    const requestedIds = resumed!.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (m as { toolCalls?: Array<{ id: string }> }).toolCalls ?? [])
      .map((c) => c.id);
    expect(requestedIds).toEqual(["call-free", "call-gated", "call-after"]);
    for (const id of requestedIds) {
      expect(resultIds.has(id)).toBe(true);
    }

    // And the un-approved call's result says so plainly, rather than pretending it ran.
    const afterResult = resumed!.messages.find(
      (m) => m.role === "tool" && (m as { toolCallId?: string }).toolCallId === "call-after"
    );
    expect(afterResult?.content).toMatch(/Not executed/i);
  });


  /**
   * An approved call that throws must fail the node, not strand it — docs/26 ADR-098.
   *
   * `inFlight.set` happened, and then 72 lines ran — including the approved tool call, the single
   * riskiest statement in the method — before the try/catch/finally that releases it began. A
   * throw there skipped `handleNodeFailure` AND `inFlight.delete`, so the node stayed
   * `waiting_model` forever with its AbortController leaked and the run no longer cancellable.
   *
   * A `PermissionError` is the realistic trigger: the tool registry returns `ok: false` for
   * ordinary failures but deliberately RE-THROWS that one, which is what a permission revoked
   * between parking and approval looks like.
   */
  it("fails the node when an approved tool call throws on resume, instead of stranding it", async () => {
    const gated: NativeToolEntry = {
      definition: {
        id: "test.revoked",
        name: "test.revoked",
        description: "throws PermissionError when finally executed",
        origin: { kind: "native", serverId: null, serverVersion: null },
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: null,
        permissionLevel: "destructive",
        riskLevel: "high",
        requiresApproval: "always" as const,
        timeoutMs: 10_000,
        retryPolicy: { maxAttempts: 1, backoff: "fixed", idempotencyRequired: false },
        enabled: true,
      },
      handler: async () => {
        throw new PermissionError("This action is no longer permitted for this project.");
      },
    };

    const { engine } = build(
      [{ calls: [{ id: "call-revoked", name: "test.revoked", arguments: {} }] }, { text: "Done." }],
      undefined,
      [gated]
    );

    const task = await engine.createAndStart(
      "autonomous",
      { goal: "Do the thing that will be revoked." },
      { projectId: PROJECT, userId: USER }
    );
    await waitFor(task.id, ["WAITING_FOR_APPROVAL"]);
    const [parked] = await nodes.listByRootUnscoped(task.id);
    expect(parked.status).toBe("waiting_approval");

    await engine.approve(task.id, parked.id, "test-operator");

    // The load-bearing assertion: it reaches a TERMINAL state. Before the fix it sat in
    // `waiting_model` until this timed out.
    const finished = await waitFor(task.id, ["FAILED", "COMPLETED"]);
    expect(finished.state).toBe("FAILED");
    const [failedNode] = await nodes.listByRootUnscoped(task.id);
    expect(failedNode.status).toBe("failed");
    expect(failedNode.errorMessage).toContain("no longer permitted");
  });


  /**
   * An approval is for ONE call, not for an id — docs/26_DECISIONS.md ADR-108.
   *
   * Adapter-synthesised tool-call ids repeat every turn: the Google adapter names the first call of
   * every turn `gemini-call-1` and the local adapter `call_0`. The engine used to record approved
   * ids and skip the gate for any later call carrying one, so a single human approval let a
   * DIFFERENT destructive call through on a later turn. Proven with two `fs.delete_file` calls
   * before the fix; this reproduces it with a gated test tool.
   */
  it("parks again when a later turn reuses the approved call's id for a different call", async () => {
    const ran: string[] = [];
    const gated: NativeToolEntry = {
      definition: {
        id: "test.destroy",
        name: "test.destroy",
        description: "a destructive action that must always be approved",
        origin: { kind: "native", serverId: null, serverVersion: null },
        inputSchema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
          additionalProperties: false,
        },
        outputSchema: null,
        permissionLevel: "destructive",
        riskLevel: "critical",
        requiresApproval: "always" as const,
        timeoutMs: 10_000,
        retryPolicy: { maxAttempts: 1, backoff: "fixed", idempotencyRequired: false },
        enabled: true,
      },
      handler: async (args) => {
        ran.push(String((args as { target: string }).target));
        return { ok: true, output: { destroyed: (args as { target: string }).target } };
      },
    };

    const { engine } = build(
      [
        // The same synthesised id on two different turns, for two different targets.
        { calls: [{ id: "gemini-call-1", name: "test.destroy", arguments: { target: "first" } }] },
        { calls: [{ id: "gemini-call-1", name: "test.destroy", arguments: { target: "second" } }] },
        { text: "Done." },
      ],
      undefined,
      [gated]
    );

    const task = await engine.createAndStart(
      "autonomous",
      { goal: "Destroy the two targets." },
      { projectId: PROJECT, userId: USER }
    );
    await waitFor(task.id, ["WAITING_FOR_APPROVAL"]);
    const [firstPark] = await nodes.listByRootUnscoped(task.id);
    expect(ran).toEqual([]);

    await engine.approve(task.id, firstPark.id, "test-operator");

    // The approved call runs; the second call, same id, different target, must NOT.
    const state = await waitFor(task.id, ["WAITING_FOR_APPROVAL", "COMPLETED", "FAILED"]);
    expect(ran).toEqual(["first"]);
    expect(state.state).toBe("WAITING_FOR_APPROVAL");
    const [secondPark] = await nodes.listByRootUnscoped(task.id);
    expect((secondPark.output as { pendingCall?: { arguments?: { target?: string } } }).pendingCall?.arguments?.target).toBe("second");
  });
});
