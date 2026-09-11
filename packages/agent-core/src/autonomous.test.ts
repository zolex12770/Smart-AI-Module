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
import { createCodingTools, createFilesystemTools, createSearchTools, ToolRegistry } from "@ai-platform/tools";
import type {
  ChatRequest,
  ChatStreamEvent,
  LLMProvider,
  ProviderCapabilities,
  Task,
  ToolCall,
} from "@ai-platform/shared";
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
  private index = 0;

  constructor(private readonly turns: Array<{ text?: string; calls?: ToolCall[] }>) {}

  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, structuredOutput: false, vision: false, contextWindow: null };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    this.turnsSeen.push(request.messages.length);
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

  const build = (turns: Array<{ text?: string; calls?: ToolCall[] }>, limits?: { maxIterations?: number }) => {
    const provider = new ScriptedAgentProvider(turns);
    const registry = new ModelRegistry();
    registry.register(provider, { asDefault: true });

    const toolRegistry = new ToolRegistry();
    for (const { definition, handler } of [
      ...createFilesystemTools(sandboxRoot),
      ...createSearchTools(sandboxRoot),
      ...createCodingTools(sandboxRoot),
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
});
