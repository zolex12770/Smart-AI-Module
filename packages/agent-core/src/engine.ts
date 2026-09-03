import { EventEmitter } from "node:events";
import type { TaskNodeRepository, TaskRepository, TaskTransitionRepository } from "@ai-platform/database";
import { estimatePromptTokens, type ModelRouter } from "@ai-platform/model-router";
import type { ToolRegistry } from "@ai-platform/tools";
import type { ChatMessage, ChatRole, Task, TaskEvent, TaskNode, TaskType, TokenUsage } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import { planTask } from "./planner.js";
import { resolveNodeInput } from "./template.js";
import { verifyNodeOutput } from "./verify.js";

const TERMINAL_TASK_STATES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
const TERMINAL_NODE_STATUSES = ["completed", "failed", "cancelled", "skipped"] as const;

/**
 * Quota check + usage recording for the engine's model calls — docs/26_DECISIONS.md ADR-046.
 *
 * `POST /api/v1/chat` has always checked quota before a provider call and written a real
 * `usage_records` row after it. The engine's `model_call` nodes went through the *same*
 * provider and did neither, so an agent task's spend was invisible to `GET /api/v1/usage` and
 * unbounded by `DAILY_TOKEN_LIMIT`/`MONTHLY_TOKEN_LIMIT`. Harmless while every provider was a
 * mock; a real hole the moment a real key exists (FR-061/FR-063 say "all LLM calls", not "all
 * chat calls").
 *
 * Deliberately a small structural interface rather than a dependency on `@ai-platform/quota`
 * and a concrete repository: agent-core stays testable with a scripted double, and the
 * composition root remains the only place that knows how quota and the usage ledger are built.
 */
export interface ModelCallMeter {
  /** Pre-flight, on an estimate — the real counts aren't known until the provider answers. */
  checkTokens(estimatedTokens: number): Promise<{ allowed: boolean; reason?: string }>;
  /** Post-call, with the provider's real figures. Never called for a call that did not happen. */
  record(entry: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    taskId: string;
    nodeId: string;
  }): Promise<void>;
}

export interface AgentEngineDeps {
  taskRepo: TaskRepository;
  nodeRepo: TaskNodeRepository;
  transitionRepo: TaskTransitionRepository;
  toolRegistry: ToolRegistry;
  modelRouter: ModelRouter;
  /** Optional so existing tests and any embedder without a ledger keep working unchanged;
   * `apps/api` always supplies one (ADR-046). */
  meter?: ModelCallMeter;
}

/**
 * Implements the state machine + dispatcher from docs/11_AGENT_LOOP.md. See that doc for
 * the full design; see PROJECT_STATUS.md for exactly what's implemented in this increment
 * vs. deferred (conditional/loop/sub_agent node types, LLM-driven planning/replanning,
 * test_suite/model_judge/human verification, in-flight call cancellation via AbortController).
 *
 * One engine instance is shared by the whole apps/api process — tasks run in-process
 * (no separate worker/queue yet, consistent with docs/26_DECISIONS.md ADR-006/ADR-007
 * deferring that infrastructure until Phase 7).
 */
export class AgentEngine {
  private readonly events = new EventEmitter();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly deps: AgentEngineDeps) {
    this.events.setMaxListeners(100);
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    this.events.on(taskId, listener);
    return () => this.events.off(taskId, listener);
  }

  private emit(taskId: string, event: TaskEvent): void {
    this.events.emit(taskId, event);
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  async createAndStart(taskType: TaskType, input: Record<string, unknown>): Promise<Task> {
    const task = await this.deps.taskRepo.create({ id: uuid(), taskType, input });
    await this.logTransition(task.id, null, null, "IDLE", "engine");

    void this.runExclusive(task.id, () => this.planAndExecute(task.id, taskType, input)).catch((err) =>
      this.onUnexpectedError(task.id, err)
    );

    return task;
  }

  private async planAndExecute(taskId: string, taskType: TaskType, input: Record<string, unknown>): Promise<void> {
    await this.transitionTask(taskId, "UNDERSTANDING", "engine");
    // Real "understanding" for an LLM-driven planner would gather context via read-only
    // tool/memory calls here. Our deterministic planner (see planner.ts) already knows
    // everything it needs from `input`, so this step is a real no-op, not a fake one.
    await this.transitionTask(taskId, "PLANNING", "engine");

    let nodeInputs;
    try {
      nodeInputs = planTask(taskType, input, (toolId) => this.deps.toolRegistry.get(toolId));
    } catch (err) {
      await this.transitionTask(taskId, "FAILED", "engine", {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      this.emit(taskId, { type: "failed", taskId, error: String(err) });
      return;
    }

    for (const nodeInput of nodeInputs) {
      const node = await this.deps.nodeRepo.create(taskId, nodeInput);
      this.emit(taskId, { type: "node", taskId, node });
    }

    await this.transitionTask(taskId, "EXECUTING", "engine");
    await this.tick(taskId);
  }

  // ---------------------------------------------------------------------------
  // Approval
  // ---------------------------------------------------------------------------

  async approve(taskId: string, nodeId: string, approvedBy: string): Promise<void> {
    await this.runExclusive(taskId, async () => {
      const node = await this.deps.nodeRepo.get(nodeId);
      if (!node || node.status !== "waiting_approval") {
        throw new Error(`Node "${nodeId}" is not awaiting approval.`);
      }
      await this.updateNode(node, { status: "pending", approvedBy, approvedAt: Date.now() }, `user:${approvedBy}`);
      await this.transitionTask(taskId, "EXECUTING", `user:${approvedBy}`);
      await this.tick(taskId);
    });
  }

  async reject(taskId: string, nodeId: string, rejectedBy: string): Promise<void> {
    await this.runExclusive(taskId, async () => {
      const node = await this.deps.nodeRepo.get(nodeId);
      if (!node || node.status !== "waiting_approval") {
        throw new Error(`Node "${nodeId}" is not awaiting approval.`);
      }
      // docs/11_AGENT_LOOP.md §2.2: a rejection is information for the planner, not
      // automatically fatal. We don't have a replanner worth invoking yet (see class
      // docstring), so a rejected node's dependents cascade to `skipped` in the dispatch
      // tick and the task finalizes as CANCELLED rather than FAILED — an honest reflection
      // of "the human said no," not "something broke."
      await this.updateNode(node, { status: "cancelled" }, `user:${rejectedBy}`);
      await this.transitionTask(taskId, "EXECUTING", `user:${rejectedBy}`);
      await this.tick(taskId);
    });
  }

  async cancel(taskId: string, actor: string): Promise<void> {
    await this.runExclusive(taskId, async () => {
      const task = await this.deps.taskRepo.get(taskId);
      if (!task || isTerminalTask(task.state)) return;
      const nodes = await this.deps.nodeRepo.listByRoot(taskId);
      for (const node of nodes) {
        if (!isTerminalNode(node.status)) {
          await this.updateNode(node, { status: "cancelled" }, actor);
        }
      }
      await this.transitionTask(taskId, "CANCELLED", actor);
    });
  }

  // ---------------------------------------------------------------------------
  // Dispatcher (docs/11_AGENT_LOOP.md §3.4)
  // ---------------------------------------------------------------------------

  private async tick(taskId: string): Promise<void> {
    const task = await this.deps.taskRepo.get(taskId);
    if (!task || isTerminalTask(task.state) || task.state === "WAITING_FOR_APPROVAL" || task.state === "PAUSED") {
      return;
    }

    const nodes = await this.deps.nodeRepo.listByRoot(taskId);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Cascade: a pending node depending on a failed/cancelled/skipped node can never run.
    // Bug history (see PROJECT_STATUS.md): this loop originally checked staleness against
    // the `nodes` array captured at the top of tick(), which is never mutated — only
    // `byId` was updated — so a node already flipped to `skipped` kept re-matching
    // `status === "pending"` on the stale array object forever. A real path-traversal
    // rejection triggered this and produced 45,000+ duplicate transition rows in ~15s
    // before the process had to be killed. Fix: always read current status from `byId`,
    // never from the stale `nodes` array, for every check in this method.
    let changed = true;
    let cascadeIterations = 0;
    // Belt-and-suspenders bound (NFR-009: no unbounded loop) on top of the correctness
    // fix above — this loop can never legitimately need more passes than there are nodes.
    const maxCascadeIterations = nodes.length + 1;
    while (changed) {
      if (++cascadeIterations > maxCascadeIterations) {
        throw new Error(
          `Cascade-skip loop exceeded ${maxCascadeIterations} iterations for task ${taskId} — aborting ` +
            `rather than looping unboundedly. This indicates a bug in the dispatcher, not normal operation.`
        );
      }
      changed = false;
      for (const node of nodes) {
        const current = byId.get(node.id);
        if (!current || current.status !== "pending") continue;
        const blocked = node.dependsOn.some((depId) => {
          const dep = byId.get(depId);
          return dep && (dep.status === "failed" || dep.status === "cancelled" || dep.status === "skipped");
        });
        if (blocked) {
          await this.updateNode(current, { status: "skipped" }, "engine");
          byId.set(node.id, { ...current, status: "skipped" });
          changed = true;
        }
      }
    }

    const ready = nodes
      .map((n) => byId.get(n.id))
      .filter((n): n is TaskNode => Boolean(n))
      .filter(
        (n) =>
          n.status === "pending" &&
          n.dependsOn.every((depId) => {
            const dep = byId.get(depId);
            return dep?.status === "completed" || dep?.status === "skipped";
          })
      );

    if (ready.length === 0) {
      const allTerminal = nodes.length > 0 && [...byId.values()].every((n) => isTerminalNode(n.status));
      if (allTerminal) await this.finalizeTask(taskId, [...byId.values()]);
      return;
    }

    await Promise.all(ready.map((node) => this.executeNode(taskId, node, byId)));

    const after = await this.deps.taskRepo.get(taskId);
    if (after && after.state === "EXECUTING") {
      await this.tick(taskId);
    }
  }

  private async executeNode(
    taskId: string,
    node: TaskNode,
    byId: Map<string, TaskNode>
  ): Promise<void> {
    if (node.approvalRequired && !node.approvedAt) {
      await this.updateNode(node, { status: "waiting_approval" }, "engine");
      await this.transitionTask(taskId, "WAITING_FOR_APPROVAL", "engine");
      return;
    }

    let resolvedInput: Record<string, unknown>;
    try {
      resolvedInput = resolveNodeInput(node.input, (id) => byId.get(id)?.output ?? null);
    } catch (err) {
      await this.handleNodeFailure(taskId, node, err instanceof Error ? err.message : String(err));
      return;
    }

    if (node.kind === "tool_call") {
      // Commit-before-act (docs/11 §4.1): status + exact args persisted before dispatch.
      await this.updateNode(node, { status: "waiting_tool" }, "engine");
      if (!node.toolId) {
        await this.handleNodeFailure(taskId, node, "tool_call node has no toolId.");
        return;
      }
      const result = await this.deps.toolRegistry.call(node.toolId, resolvedInput);
      if (!result.ok) {
        await this.handleNodeFailure(taskId, node, result.error ?? "Tool call failed.");
        return;
      }
      await this.verifyAndAdvance(taskId, node, byId, result.output ?? {});
    } else {
      await this.updateNode(node, { status: "waiting_model" }, "engine");
      try {
        const messages = (resolvedInput.messages as ChatMessage[] | undefined) ?? [];
        // ADR-046 — the same order as the chat route: refuse before spending, record after.
        if (this.deps.meter) {
          const estimatedTokens = estimatePromptTokens(messages.map((m) => m.content).join(" "));
          const check = await this.deps.meter.checkTokens(estimatedTokens);
          if (!check.allowed) {
            // A node failure, not a thrown quota error: the task's own failure path already
            // records the reason on the node and in the transition log, so an operator can see
            // exactly which node was refused and why.
            await this.handleNodeFailure(taskId, node, check.reason ?? "Token quota exceeded.");
            return;
          }
        }
        const result = await runModelToCompletion(this.deps.modelRouter, messages, node.modelProvider);
        if (this.deps.meter) {
          // Recorded even when the router fell back to the mock — the ledger's job is to say
          // what actually happened, and `provider` on the row is what distinguishes them.
          await this.deps.meter.record({
            provider: result.provider,
            model: result.model,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            taskId,
            nodeId: node.id,
          });
        }
        await this.verifyAndAdvance(taskId, node, byId, {
          content: result.content,
          provider: result.provider,
          model: result.model,
        });
      } catch (err) {
        await this.handleNodeFailure(taskId, node, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async verifyAndAdvance(
    taskId: string,
    node: TaskNode,
    byId: Map<string, TaskNode>,
    output: Record<string, unknown>
  ): Promise<void> {
    await this.updateNode(node, { status: "verifying", output }, "engine");
    const nodeWithOutput = { ...node, output };

    let result;
    try {
      result = verifyNodeOutput(nodeWithOutput, output);
    } catch (err) {
      await this.handleNodeFailure(taskId, nodeWithOutput, err instanceof Error ? err.message : String(err));
      return;
    }

    if (result.pass) {
      await this.updateNode(nodeWithOutput, { status: "completed" }, "engine");
      byId.set(node.id, { ...nodeWithOutput, status: "completed" });
    } else {
      await this.handleNodeFailure(taskId, nodeWithOutput, result.reason ?? "Verification failed.");
    }
  }

  private async handleNodeFailure(taskId: string, node: TaskNode, message: string): Promise<void> {
    const attempts = node.attemptCount + 1;
    if (attempts < node.retryPolicy.maxAttempts) {
      await this.transitionTask(taskId, "RETRYING", "engine", { nodeId: node.id, attempt: attempts, message });
      await this.updateNode(node, { status: "retrying", attemptCount: attempts, errorMessage: message }, "engine");
      await this.updateNode(
        { ...node, status: "retrying" },
        { status: "pending" },
        "engine"
      );
      await this.transitionTask(taskId, "EXECUTING", "engine");
    } else {
      // docs/11_AGENT_LOOP.md's plan-invalidating replan loop is NOT implemented (see
      // class docstring) — retry exhaustion always terminates the node (and, via
      // finalizeTask's cascade, the whole task) as FAILED in this increment.
      await this.updateNode(node, { status: "failed", attemptCount: attempts, errorMessage: message }, "engine");
    }
  }

  private async finalizeTask(taskId: string, nodes: TaskNode[]): Promise<void> {
    const failed = nodes.find((n) => n.status === "failed");
    if (failed) {
      await this.transitionTask(taskId, "FAILED", "engine", { errorMessage: failed.errorMessage });
      this.emit(taskId, { type: "failed", taskId, error: failed.errorMessage ?? "Task failed." });
      return;
    }

    const rejected = nodes.some((n) => n.status === "cancelled" || n.status === "skipped");
    if (rejected) {
      await this.transitionTask(taskId, "CANCELLED", "engine");
      return;
    }

    const leafNodes = nodes.filter((n) => !nodes.some((other) => other.dependsOn.includes(n.id)));
    const output =
      leafNodes.length === 1
        ? leafNodes[0]?.output ?? {}
        : { results: leafNodes.map((n) => n.output) };

    await this.transitionTask(taskId, "COMPLETED", "engine", undefined, output);
    this.emit(taskId, { type: "completed", taskId, output });
  }

  // ---------------------------------------------------------------------------
  // Crash recovery (docs/11_AGENT_LOOP.md §4.2-4.3)
  // ---------------------------------------------------------------------------

  async resumeAll(): Promise<void> {
    const inFlightNodes = await this.deps.nodeRepo.listInFlight();
    const affectedTaskIds = new Set<string>();

    for (const node of inFlightNodes) {
      affectedTaskIds.add(node.rootTaskId);
      if (node.status === "waiting_model" || node.status === "retrying") {
        await this.updateNode(node, { status: "pending" }, "system:crash-recovery");
      } else if (node.status === "waiting_tool") {
        const toolDef = node.toolId ? this.deps.toolRegistry.get(node.toolId) : undefined;
        if (toolDef?.permissionLevel === "read_only") {
          await this.updateNode(node, { status: "pending" }, "system:crash-recovery");
        } else {
          // Non-atomic mutating call was in flight at crash time — outcome unknown.
          // Never auto-retry (docs/11 §4.3, docs/10 §3.3). Surface for manual reconciliation.
          await this.updateNode(node, { status: "needs_reconciliation" }, "system:crash-recovery");
          await this.transitionTask(node.rootTaskId, "PAUSED", "system:crash-recovery", {
            reason: `Node ${node.id} (tool ${node.toolId}) was mid-call at crash time and cannot be safely auto-retried.`,
          });
        }
      } else if (node.status === "verifying") {
        // Output was already persisted before the crash; re-verifying is a pure,
        // side-effect-free check, so it's always safe to just redo it.
        const siblings = await this.deps.nodeRepo.listByRoot(node.rootTaskId);
        const byId = new Map(siblings.map((n) => [n.id, n]));
        await this.verifyAndAdvance(node.rootTaskId, node, byId, node.output ?? {});
      }
    }

    for (const task of await this.deps.taskRepo.listNonTerminal()) {
      if (task.state === "WAITING_FOR_APPROVAL" || task.state === "PAUSED") continue; // safe to just wait
      if (task.state === "UNDERSTANDING" || task.state === "PLANNING") {
        const nodes = await this.deps.nodeRepo.listByRoot(task.id);
        if (nodes.length === 0) {
          void this.runExclusive(task.id, () => this.planAndExecute(task.id, task.taskType, task.input)).catch(
            (err) => this.onUnexpectedError(task.id, err)
          );
          continue;
        }
      }
      void this.runExclusive(task.id, () => this.tick(task.id)).catch((err) => this.onUnexpectedError(task.id, err));
    }

    void affectedTaskIds; // reconciliation-triggered ticks are covered by the loop above
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async runExclusive(taskId: string, fn: () => Promise<void>): Promise<void> {
    const prior = this.locks.get(taskId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    this.locks.set(
      taskId,
      next.catch(() => undefined)
    );
    return next;
  }

  private async updateNode(
    node: TaskNode,
    patch: Parameters<TaskNodeRepository["update"]>[1],
    actor: string
  ): Promise<void> {
    await this.deps.nodeRepo.update(node.id, patch);
    await this.deps.transitionRepo.append({
      taskId: node.rootTaskId,
      nodeId: node.id,
      fromState: node.status,
      toState: patch.status ?? node.status,
      actor,
      payload: patch.errorMessage ? { errorMessage: patch.errorMessage } : null,
    });
    const updated = await this.deps.nodeRepo.get(node.id);
    if (updated) this.emit(node.rootTaskId, { type: "node", taskId: node.rootTaskId, node: updated });
  }

  private async transitionTask(
    taskId: string,
    toState: Task["state"],
    actor: string,
    patch?: { errorMessage?: string | null; nodeId?: string; attempt?: number; message?: string; reason?: string },
    output?: Record<string, unknown>
  ): Promise<void> {
    const current = await this.deps.taskRepo.get(taskId);
    await this.deps.taskRepo.updateState(taskId, toState, {
      output,
      errorMessage: patch?.errorMessage,
    });
    await this.deps.transitionRepo.append({
      taskId,
      nodeId: patch?.nodeId ?? null,
      fromState: current?.state ?? null,
      toState,
      actor,
      payload: patch ? { ...patch } : null,
    });
    this.emit(taskId, { type: "state", taskId, state: toState });
  }

  private async logTransition(
    taskId: string,
    nodeId: string | null,
    fromState: string | null,
    toState: string,
    actor: string
  ): Promise<void> {
    await this.deps.transitionRepo.append({ taskId, nodeId, fromState, toState, actor });
  }

  private onUnexpectedError(taskId: string, err: unknown): void {
    // eslint-disable-next-line no-console
    console.error(`[agent-core] unexpected error in task ${taskId}:`, err);
  }
}

function isTerminalTask(state: Task["state"]): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

function isTerminalNode(status: TaskNode["status"]): boolean {
  return (TERMINAL_NODE_STATUSES as readonly string[]).includes(status);
}

async function runModelToCompletion(
  router: ModelRouter,
  messages: ChatMessage[],
  provider: string | null
): Promise<{ content: string; provider: string; model: string; usage: TokenUsage }> {
  const normalizedMessages = messages.map((m) => ({ role: m.role as ChatRole, content: m.content }));
  for await (const event of router.streamChat({ messages: normalizedMessages, provider: provider ?? undefined })) {
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") {
      // `usage` was previously discarded here — which is precisely why an agent task's real
      // token spend never reached the ledger (ADR-046).
      return { content: event.message.content, provider: event.provider, model: event.model, usage: event.usage };
    }
  }
  throw new Error("Model stream ended without a done event.");
}
