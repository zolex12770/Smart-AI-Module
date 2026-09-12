import { EventEmitter } from "node:events";
import type {
  TaskNodePatch,
  TaskNodeRecord,
  TaskNodeRepository,
  TaskRecord,
  TaskRepository,
  TaskTransitionRepository,
} from "@ai-platform/database";
import { estimatePromptTokens, type ModelRouter } from "@ai-platform/model-router";
import type { ToolRegistry } from "@ai-platform/tools";
import {
  chatMessageSchema,
  toolCallSchema,
  type ChatMessage,
  type FailureClass,
  type NodeStatus,
  type RetryPolicy,
  type Task,
  type TaskEvent,
  type TaskType,
  type TokenUsage,
  type ToolCall,
  type ToolCallResult,
} from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import { planTask } from "./planner.js";
import { runReasoningLoop } from "./reasoning-loop.js";
import { resolveNodeInput } from "./template.js";
import { verifyNodeOutput, type VerificationContext } from "./verify.js";
import { withSpan } from "@ai-platform/observability";

const TERMINAL_TASK_STATES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
const TERMINAL_NODE_STATUSES = ["completed", "failed", "cancelled", "skipped"] as const;

/**
 * Statuses in which a node is actually consuming time somewhere, and therefore the ones
 * `timeoutMs` is measured against. Mirrors `PgTaskNodeRepository`'s own list deliberately:
 * `retrying` is absent from both because a node waiting out its backoff is idle, and
 * counting that wait against its execution timeout would kill nodes for being patient.
 */
const RUNNING_NODE_STATUSES = ["running", "waiting_model", "waiting_tool", "verifying"] as const;

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
  checkTokens(estimatedTokens: number, scope: { taskId: string; nodeId: string }): Promise<{ allowed: boolean; reason?: string }>;
  /** Post-call, with the provider's real figures. Never called for a call that did not happen. */
  record(entry: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    taskId: string;
    nodeId: string;
    /**
     * The natural key for THIS charge (ADR-054), supplied by the engine rather than derived
     * downstream from the node id.
     *
     * It had to move here because only the engine knows how many billable model calls a node
     * makes. The composition root keyed every charge `agent.node:<nodeId>`, which is right for
     * a `model_call` node — one node, one call — and silently wrong for a `reasoning` node,
     * which makes one call per turn: the ledger's unique index on the idempotency key accepted
     * turn 1 and dropped every later turn, so a ten-turn agent run billed for one turn. The
     * key is now unique per turn, and still stable across a re-execution of the same turn,
     * which is the property ADR-054 actually wanted.
     */
    idempotencyKey: string;
  }): Promise<void>;
}

/** How a node's declared `retryPolicy.backoff` is turned into wall-clock delay. */
export interface RetryBackoff {
  /** The delay for `fixed`, and the first delay for `exponential`. */
  baseDelayMs: number;
  /** Ceiling for `exponential`, so a long-lived task cannot schedule a retry days out. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_BACKOFF: RetryBackoff = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

/**
 * docs/11_AGENT_LOOP.md §4.3's backoff, made real.
 *
 * The audit found `retryPolicy.backoff` was chosen by the planner, written to the row, and
 * then never read by anything: every retry was re-dispatched in the very next dispatcher
 * pass, so `none`, `fixed` and `exponential` were three names for the same behaviour and a
 * flapping tool was hammered as fast as the loop could turn. The delay this returns is now
 * persisted as the node's `next_attempt_at`, which is what the dispatcher and `sweep()`
 * both gate re-dispatch on.
 *
 * `attempt` is the 1-based number of the attempt that just failed, so the first retry of an
 * `exponential` node waits `baseDelayMs`, the second twice that, and so on.
 */
export function retryDelayMs(
  backoff: RetryPolicy["backoff"],
  attempt: number,
  policy: RetryBackoff = DEFAULT_RETRY_BACKOFF
): number {
  switch (backoff) {
    case "none":
      return 0;
    case "fixed":
      return policy.baseDelayMs;
    case "exponential":
      return Math.min(policy.baseDelayMs * 2 ** Math.max(attempt - 1, 0), policy.maxDelayMs);
  }
}

export interface AgentEngineDeps {
  taskRepo: TaskRepository;
  nodeRepo: TaskNodeRepository;
  transitionRepo: TaskTransitionRepository;
  toolRegistry: ToolRegistry;
  modelRouter: ModelRouter;
  /** Optional so existing tests and any embedder without a ledger keep working unchanged;
   * `backend` always supplies one (ADR-046). */
  meter?: ModelCallMeter;
  /**
   * Passed to every tool invocation as `ToolInvocationContext.workspaceRoot`. The engine
   * never derives a path of its own: where work is allowed to touch the filesystem is the
   * composition root's decision (docs/13_SECURITY_ARCHITECTURE.md §5), and the native tools
   * resolve every relative path against it.
   */
  workspaceRoot?: string;
  /** Backoff tuning — see `retryDelayMs`. Unset fields fall back to `DEFAULT_RETRY_BACKOFF`. */
  retryBackoff?: Partial<RetryBackoff>;
  /**
   * Injectable clock, used for every deadline the engine writes or reads. Tests drive retry
   * backoff and node timeouts through it instead of sleeping for real.
   */
  now?: () => number;
  /** Ceilings for a `reasoning` node's loop (ADR-064). The model cannot raise them. */
  agentLimits?: { maxIterations?: number; maxTokensPerRun?: number };
  /**
   * Runs a `test_suite` node's command in the sandbox and reports its exit code (ADR-075).
   *
   * Injected rather than built here because WHERE code may execute is the composition root's
   * decision, not the engine's (docs/13_SECURITY_ARCHITECTURE.md §5) — the same reason
   * `workspaceRoot` is injected. Absent means `test_suite` verification FAILS rather than
   * passes: a check that cannot run has not been satisfied.
   */
  runTestCommand?: VerificationContext["runTestCommand"];
  /** Backs `model_judge` verification (ADR-075). Last-resort; absent means that method fails. */
  judgeOutput?: VerificationContext["judge"];
}

/** The authenticated principal a task runs as — resolved by the route, never client-supplied. */
export interface TaskOwner {
  /** Every row this task writes is scoped by it, and it scopes the task's tool policy (ADR-049). */
  projectId: string;
  /** Attributed to each tool call, and recorded on the task as `createdByUserId` (docs/13 §6). */
  userId: string;
}

/**
 * Implements the state machine + dispatcher from docs/11_AGENT_LOOP.md. See that doc for
 * the full design; see PROJECT_STATUS.md for exactly what's implemented in this increment
 * vs. deferred (conditional/loop/sub_agent node types, LLM-driven planning/replanning,
 * test_suite/model_judge/human verification).
 *
 * One engine instance is shared by the whole backend process — tasks run in-process
 * (no separate worker/queue yet, consistent with docs/26_DECISIONS.md ADR-006/ADR-007
 * deferring that infrastructure until Phase 7).
 *
 * Everything below runs *after* authorization: a route handler resolves the task inside the
 * caller's project (`taskRepo.get(projectId, id)`) and only then calls the engine, which is
 * why the engine itself reads through the repositories' `*Unscoped` methods. It operates
 * across every project by definition — crash recovery and the retry/timeout sweep are not
 * anyone's request — so a tenancy predicate here would be wrong, not merely redundant.
 */
export class AgentEngine {
  private readonly events = new EventEmitter();
  private readonly locks = new Map<string, Promise<void>>();
  /**
   * The controller for each node's in-flight call, so a timeout or a cancellation can stop
   * the work rather than only relabelling the row. Best effort by nature: a handler that
   * ignores its signal keeps running, which is why every outcome is re-checked against the
   * node's current status before it is written (`stillRunning`).
   */
  private readonly inFlight = new Map<string, AbortController>();
  private readonly backoff: RetryBackoff;
  private scheduler: NodeJS.Timeout | undefined;

  constructor(private readonly deps: AgentEngineDeps) {
    this.events.setMaxListeners(100);
    this.backoff = { ...DEFAULT_RETRY_BACKOFF, ...deps.retryBackoff };
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    this.events.on(taskId, listener);
    return () => this.events.off(taskId, listener);
  }

  private emit(taskId: string, event: TaskEvent): void {
    this.events.emit(taskId, event);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  /**
   * `owner` carries the two facts the task cannot be run without and must never guess: the
   * project every row it writes belongs to, and the user its tool calls are attributed to.
   * Both come from the authenticated request (ADR-049), so there is deliberately no default.
   */
  async createAndStart(
    taskType: TaskType,
    input: Record<string, unknown>,
    owner: TaskOwner
  ): Promise<TaskRecord> {
    const task = await this.deps.taskRepo.create({
      id: uuid(),
      projectId: owner.projectId,
      createdByUserId: owner.userId,
      taskType,
      input,
    });
    await this.logTransition(task.id, null, null, "IDLE", `user:${owner.userId}`);

    // `agent.run` wraps the ENTIRE task, not just planning (ADR-073). Started here rather than
    // inside `planAndExecute` so that a task which dies during planning still produces a span —
    // an agent that fails before it does anything is exactly the case an operator needs to see,
    // and it is the case a span opened later would miss. It is deliberately not awaited: the
    // span's lifetime follows the detached run, and `createAndStart` must return the task id to
    // the caller immediately.
    void withSpan(
      "agent.run",
      {
        task_id: task.id,
        "agent.task_type": taskType,
        project_id: owner.projectId,
        user_id: owner.userId,
      },
      () => this.runExclusive(task.id, () => this.planAndExecute(task.id, taskType, input))
    ).catch((err) => this.onUnexpectedError(task.id, err));

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
      const node = await this.deps.nodeRepo.getUnscoped(nodeId);
      if (!node || node.status !== "waiting_approval") {
        throw new Error(`Node "${nodeId}" is not awaiting approval.`);
      }
      await this.updateNode(node, { status: "pending", approvedBy, approvedAt: this.now() }, `user:${approvedBy}`);
      await this.transitionTask(taskId, "EXECUTING", `user:${approvedBy}`);
      await this.tick(taskId);
    });
  }

  async reject(taskId: string, nodeId: string, rejectedBy: string): Promise<void> {
    await this.runExclusive(taskId, async () => {
      const node = await this.deps.nodeRepo.getUnscoped(nodeId);
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
      const task = await this.deps.taskRepo.getUnscoped(taskId);
      if (!task || isTerminalTask(task.state)) return;
      const nodes = await this.deps.nodeRepo.listByRootUnscoped(taskId);
      for (const node of nodes) {
        if (!isTerminalNode(node.status)) {
          // Stop the work, not just the bookkeeping: without this a cancelled node's tool
          // call would keep running to completion and only its row would say otherwise.
          this.inFlight.get(node.id)?.abort(new Error(`Task "${taskId}" was cancelled by ${actor}.`));
          await this.updateNode(node, { status: "cancelled", startedAt: null, nextAttemptAt: null }, actor);
        }
      }
      await this.transitionTask(taskId, "CANCELLED", actor);
    });
  }

  // ---------------------------------------------------------------------------
  // Dispatcher (docs/11_AGENT_LOOP.md §3.4)
  // ---------------------------------------------------------------------------

  private async tick(taskId: string): Promise<void> {
    const task = await this.deps.taskRepo.getUnscoped(taskId);
    if (!task || isTerminalTask(task.state) || task.state === "WAITING_FOR_APPROVAL" || task.state === "PAUSED") {
      return;
    }

    const nodes = await this.deps.nodeRepo.listByRootUnscoped(taskId);
    const byId = new Map<string, TaskNodeRecord>(nodes.map((n) => [n.id, n]));
    const now = this.now();

    // Backoff, applied (docs/11 §4.3). A `retrying` node re-enters the ready set only once
    // its persisted `next_attempt_at` has passed. `none` sets that deadline to the moment of
    // failure, so a zero-delay retry still runs in this same dispatch pass; `fixed` and
    // `exponential` genuinely wait, and are picked up by whichever tick or `sweep()` first
    // runs after the deadline. This check and `sweep()` read the same column, so the two
    // paths into a retry cannot disagree about when one is due.
    let promoted = false;
    for (const node of nodes) {
      const current = byId.get(node.id);
      if (!current || current.status !== "retrying") continue;
      if ((current.nextAttemptAt ?? now) > now) continue;
      await this.updateNode(current, { status: "pending", nextAttemptAt: null }, "engine");
      byId.set(node.id, { ...current, status: "pending", nextAttemptAt: null });
      promoted = true;
    }
    if (promoted && task.state !== "EXECUTING") {
      await this.transitionTask(taskId, "EXECUTING", "engine");
    }

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
      .filter((n): n is TaskNodeRecord => Boolean(n))
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

    await Promise.all(ready.map((node) => this.executeNode(task, node, byId)));

    // Re-tick on any non-terminal state, not only EXECUTING: a node that entered backoff
    // leaves the task in RETRYING, and its *siblings* whose dependencies just completed
    // still have to be dispatched. `tick`'s own guard above is what stops the recursion for
    // WAITING_FOR_APPROVAL and PAUSED, and the ready set shrinks every pass, so this
    // terminates.
    const after = await this.deps.taskRepo.getUnscoped(taskId);
    if (after && !isTerminalTask(after.state)) {
      await this.tick(taskId);
    }
  }

  private async executeNode(
    task: TaskRecord,
    node: TaskNodeRecord,
    byId: Map<string, TaskNodeRecord>
  ): Promise<void> {
    // One span per node, nested under `agent.run` through the AsyncLocalStorage context the
    // tracer provider installs (ADR-073). This is the span that answers "where did the run
    // spend its time and which step failed" — with `tool.call` and `gen_ai.chat` nesting
    // beneath it, a whole task reads as one tree rather than as a pile of unrelated log lines.
    return withSpan(
      "agent.step",
      {
        task_id: task.id,
        node_id: node.id,
        "agent.node_kind": node.kind,
        "agent.attempt": node.attemptCount ?? 0,
        project_id: task.projectId,
      },
      () => this.executeNodeInSpan(task, node, byId)
    );
  }

  private async executeNodeInSpan(
    task: TaskRecord,
    node: TaskNodeRecord,
    byId: Map<string, TaskNodeRecord>
  ): Promise<void> {
    if (!node.approvedAt) {
      let decision: { required: boolean; reason?: string };
      try {
        decision = await this.approvalDecision(task, node);
      } catch (err) {
        // An unknown or unregistered tool: retrying cannot make it appear.
        await this.handleNodeFailure(
          task.id,
          node,
          err instanceof Error ? err.message : String(err),
          "plan-invalidating"
        );
        return;
      }
      if (decision.required) {
        await this.updateNode(node, { status: "waiting_approval" }, "engine", { reason: decision.reason });
        await this.transitionTask(task.id, "WAITING_FOR_APPROVAL", "engine", {
          nodeId: node.id,
          reason: decision.reason,
        });
        return;
      }
    }

    let resolvedInput: Record<string, unknown>;
    try {
      resolvedInput = resolveNodeInput(node.input, (id) => byId.get(id)?.output ?? null);
    } catch (err) {
      // A dangling `{{node.output.field}}` reference is a defect in the plan, not a flaky
      // call — the referenced output will not appear on a second attempt.
      await this.handleNodeFailure(task.id, node, err instanceof Error ? err.message : String(err), "plan-invalidating");
      return;
    }

    if (node.kind === "tool_call") {
      await this.executeToolNode(task, node, byId, resolvedInput);
    } else if (node.kind === "reasoning") {
      await this.executeReasoningNode(task, node, byId, resolvedInput);
    } else {
      await this.executeModelNode(task, node, byId, resolvedInput);
    }
  }

  /**
   * docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3.1's four approval modes, resolved per invocation
   * (ADR-059).
   *
   * The planner used to collapse `requiresApproval` to a boolean at plan time, which made
   * `first_use` and `risk_threshold` behave exactly like `always`. Neither question is
   * answerable at plan time: whether a tool has been used in this project before is history,
   * and what counts as too risky is deployment policy. Both belong to the registry, and only
   * at the moment of the call — so the dispatcher asks it then, scoped to the task's project.
   *
   * `node.approvalRequired` survives as an *unconditional*, plan-level gate layered on top:
   * a planner may decide a particular step needs a human whatever the tool's own policy says.
   */
  private async approvalDecision(
    task: TaskRecord,
    node: TaskNodeRecord
  ): Promise<{ required: boolean; reason?: string }> {
    if (node.approvalRequired) {
      return { required: true, reason: "The plan marked this step as requiring human approval." };
    }
    if (node.kind !== "tool_call" || !node.toolId) return { required: false };
    return this.deps.toolRegistry.approvalFor(node.toolId, task.projectId);
  }

  private async executeToolNode(
    task: TaskRecord,
    node: TaskNodeRecord,
    byId: Map<string, TaskNodeRecord>,
    resolvedInput: Record<string, unknown>
  ): Promise<void> {
    if (!node.toolId) {
      await this.handleNodeFailure(task.id, node, "tool_call node has no toolId.", "plan-invalidating");
      return;
    }
    // `created_by_user_id` is nullable only because a task outlives the account that started
    // it. A tool call still has to be attributable to a principal (docs/13 §6), and inventing
    // one would be worse than refusing, so an orphaned task stops here rather than acting.
    const userId = task.createdByUserId;
    if (!userId) {
      await this.handleNodeFailure(
        task.id,
        node,
        `Task "${task.id}" has no creating user on record, so a tool call cannot be attributed to a principal.`,
        "plan-invalidating"
      );
      return;
    }

    // Commit-before-act (docs/11 §4.1): status + exact args persisted before dispatch.
    // `startedAt` goes with them — it is what `timeoutMs` is measured from, and what lets
    // another instance see that this attempt is overdue (ADR-052).
    await this.updateNode(node, { status: "waiting_tool", startedAt: this.now() }, "engine");

    const controller = new AbortController();
    this.inFlight.set(node.id, controller);
    let result: ToolCallResult;
    try {
      result = await this.withNodeDeadline(
        node,
        controller,
        this.deps.toolRegistry.call(node.toolId, resolvedInput, {
          projectId: task.projectId,
          userId,
          workspaceRoot: this.deps.workspaceRoot,
          signal: controller.signal,
        })
      );
    } catch (err) {
      await this.handleNodeFailure(task.id, node, err instanceof Error ? err.message : String(err));
      return;
    } finally {
      this.inFlight.delete(node.id);
    }

    if (!(await this.stillRunning(node, "waiting_tool"))) return;
    if (!result.ok) {
      await this.handleNodeFailure(task.id, node, result.error ?? "Tool call failed.");
      return;
    }
    await this.verifyAndAdvance(task.id, node, byId, result.output ?? {});
  }

  /**
   * The model-driven executor — docs/26_DECISIONS.md ADR-064.
   *
   * This is where the two agent architectures meet. Everything else in this engine decides
   * *when* work runs: dependencies, retries, leases, approval, crash recovery. This method
   * decides nothing about *what* work is done — it hands the model the goal and the tools the
   * project has enabled, and the model chooses the actions, the order, and when it is
   * finished. The task graph stays the orchestration and state layer; the intelligence lives
   * in the loop.
   *
   * Approval is the one place the harness interrupts the model mid-thought. When a chosen tool
   * needs a human, the loop stops, the transcript so far is persisted on the node, and the node
   * parks at `waiting_approval`. Approving it re-dispatches this method, which resumes from
   * that transcript with the pending call pre-authorised — so a human decision does not throw
   * away the reasoning that led to it.
   */
  private async executeReasoningNode(
    task: TaskRecord,
    node: TaskNodeRecord,
    byId: Map<string, TaskNodeRecord>,
    resolvedInput: Record<string, unknown>
  ): Promise<void> {
    const goal = String(resolvedInput.goal ?? "").trim();
    if (!goal) {
      await this.handleNodeFailure(task.id, node, "reasoning node has no `goal`.", "plan-invalidating");
      return;
    }
    const userId = task.createdByUserId;
    if (!userId) {
      await this.handleNodeFailure(
        task.id,
        node,
        `Task "${task.id}" has no creating user on record, so tool calls cannot be attributed to a principal.`,
        "plan-invalidating"
      );
      return;
    }

    // A resumed run carries the transcript it was interrupted at, plus the call the human just
    // approved. A fresh run starts from the goal alone.
    const resumed = readResumeState(node.output);
    const priorMessages: ChatMessage[] = resumed?.transcript ?? [
      { role: "system", content: AUTONOMOUS_SYSTEM_PROMPT },
      { role: "user", content: goal },
    ];
    const preApprovedCallIds = new Set<string>(resumed?.approvedCallIds ?? []);

    const allowed = Array.isArray(resolvedInput.allowedTools)
      ? new Set((resolvedInput.allowedTools as unknown[]).map(String))
      : null;
    const tools = this.deps.toolRegistry.toolSpecs((d) => (allowed ? allowed.has(d.id) : true));

    await this.updateNode(node, { status: "waiting_model", startedAt: this.now() }, "engine");
    const controller = new AbortController();
    this.inFlight.set(node.id, controller);

    /**
     * On resume, run the call the human actually approved BEFORE handing control back to the
     * model. Without this the loop would simply re-prompt from the parked transcript, whose
     * last turn is the assistant asking for the tool — so the model would be answering as if
     * the action had happened when it never did, and an approval would silently do nothing.
     * Appending the real result as a `tool` message is also what keeps the transcript a valid
     * conversation: an assistant turn with tool calls must be followed by their results.
     */
    const approvedCall = resumed?.pendingCall;
    if (approvedCall) {
      const outcome = await this.deps.toolRegistry.call(approvedCall.name, approvedCall.arguments, {
        projectId: task.projectId,
        userId,
        workspaceRoot: this.deps.workspaceRoot,
        signal: controller.signal,
      });
      priorMessages.push({
        role: "tool",
        content: outcome.ok
          ? JSON.stringify(outcome.output ?? {})
          : `Error: ${outcome.error ?? "the tool failed without a message"}`,
        toolCallId: approvedCall.id,
        name: approvedCall.name,
      });
    }

    /**
     * Filled in when the loop stops for approval, so the node can be parked with context.
     * A holder object rather than a `let`: it is written inside the executeTool closure, and
     * TypeScript's control-flow analysis cannot see that, so a bare variable would narrow to
     * `null` at every read site below.
     */
    const approval: { pending: { call: ToolCall; reason: string } | null } = { pending: null };

    /**
     * Which turn of THIS NODE'S conversation the loop is on, counted across resumes.
     *
     * `runReasoningLoop` restarts its own `iteration` at 1 every time it is entered, so a node
     * that parked for approval and was resumed would produce a second turn 1 — and keying the
     * charge on the loop's iteration alone would make the resumed turns collide with the
     * original ones and be dropped as duplicates. The assistant turns already in the transcript
     * are the stable offset: a resume continues from where it stopped, while a crash-recovery
     * re-execution of the same persisted transcript replays the same numbers, which is exactly
     * the ADR-054 dedupe this key is for.
     */
    const priorTurns = priorMessages.filter((m) => m.role === "assistant").length;
    let turn = priorTurns;

    /**
     * ADR-046's "refuse before spending", applied per TURN rather than once per node.
     *
     * `executeModelCallNode` has always checked quota before its single provider call; this
     * path checked nothing at all, so an agent task could spend an unbounded number of turns'
     * worth of tokens against an exhausted quota — the larger of the two holes, since a
     * reasoning node is the expensive kind of node. The check goes immediately before each
     * turn's provider call because that is the only point where refusing still prevents the
     * spend; a single pre-flight check on the goal would authorise a ten-turn run on the
     * strength of a one-turn estimate.
     */
    const checkTurnQuota = async (messages: ChatMessage[]): Promise<void> => {
      if (!this.deps.meter) return;
      const estimated = estimatePromptTokens(messages.map((m) => m.content).join(" "));
      const check = await this.deps.meter.checkTokens(estimated, { taskId: task.id, nodeId: node.id });
      // Thrown, not returned: the loop has no "refused" outcome, and the throw is caught below
      // and recorded as this node's failure reason — the same end state a refused `model_call`
      // node reaches, with the same message.
      if (!check.allowed) throw new Error(check.reason ?? "Token quota exceeded.");
    };
    const modelRouter = this.deps.modelRouter;
    const meter = this.deps.meter;

    try {
      const result = await this.withNodeDeadline(
        node,
        controller,
        runReasoningLoop(
          {
            tools,
            async *streamChat(request) {
              await checkTurnQuota(request.messages);
              yield* modelRouter.streamChat(
                { messages: request.messages, tools: request.tools, toolChoice: request.toolChoice },
                { signal: controller.signal }
              );
            },
            executeTool: async ({ call }) => {
              // Approval is resolved per call, per project — the four modes are real (ADR-059).
              if (!preApprovedCallIds.has(call.id)) {
                const decision = await this.deps.toolRegistry.approvalFor(call.name, task.projectId);
                if (decision.required) {
                  approval.pending = { call, reason: decision.reason ?? "Approval required." };
                  return { ok: false, content: "", awaitingApproval: true };
                }
              }
              const outcome = await this.deps.toolRegistry.call(call.name, call.arguments, {
                projectId: task.projectId,
                userId,
                workspaceRoot: this.deps.workspaceRoot,
                signal: controller.signal,
              });
              // The model reads this string, so a failure has to be legible to it: an error it
              // can act on is worth more than a stack trace it cannot.
              return {
                ok: outcome.ok,
                content: outcome.ok
                  ? JSON.stringify(outcome.output ?? {})
                  : `Error: ${outcome.error ?? "the tool failed without a message"}`,
              };
            },
            onEvent: (event) => {
              // The loop emits `iteration` immediately before each turn's provider call and
              // `usage` immediately after it, so this counter names the turn the usage belongs
              // to. `turn` is seeded from the transcript, not from zero, so a resumed run
              // continues the numbering instead of restarting it (see `priorTurns`).
              if (event.type === "iteration") turn = priorTurns + event.iteration;
              if (event.type === "usage" && meter) {
                void meter
                  .record({
                    provider: "reasoning",
                    model: "loop",
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    taskId: task.id,
                    nodeId: node.id,
                    /**
                     * Per TURN, not per node — this is the fix for a reasoning node billing
                     * for exactly one of its turns. Every turn used to be recorded under
                     * `agent.node:<nodeId>`, and `usage_records`' unique index on the
                     * idempotency key silently discarded all but the first, so a ten-iteration
                     * agent run charged the project for one iteration's tokens.
                     */
                    idempotencyKey: `agent.node:${node.id}:turn:${turn}`,
                  })
                  .catch(() => undefined);
              }
            },
          },
          priorMessages,
          {
            signal: controller.signal,
            maxIterations: this.deps.agentLimits?.maxIterations,
            maxTotalTokens: this.deps.agentLimits?.maxTokensPerRun,
          }
        )
      );

      if (!(await this.stillRunning(node, "waiting_model"))) return;

      const paused = approval.pending;
      if (result.stopReason === "awaiting_approval" && paused) {
        // Persist enough to resume exactly here, including WHY a human was asked.
        await this.updateNode(
          node,
          {
            status: "waiting_approval",
            output: {
              resume: { transcript: result.transcript, approvedCallIds: [...preApprovedCallIds, paused.call.id] },
              pendingCall: { id: paused.call.id, name: paused.call.name, arguments: paused.call.arguments },
              reason: paused.reason,
            },
          },
          "engine",
          { reason: paused.reason }
        );
        await this.transitionTask(task.id, "WAITING_FOR_APPROVAL", "engine");
        return;
      }

      if (result.stopReason === "cancelled") {
        await this.updateNode(node, { status: "cancelled" }, "engine");
        return;
      }
      if (result.stopReason === "max_iterations" || result.stopReason === "budget_exhausted") {
        // Not a crash and not a success: the model ran out of the budget the harness set. It
        // is reported as a failure with the reason named, never as a completed answer.
        await this.handleNodeFailure(
          task.id,
          node,
          `The agent stopped after ${result.iterations} turns (${result.stopReason}) without reaching an answer.`
        );
        return;
      }

      await this.verifyAndAdvance(task.id, node, byId, {
        content: result.answer,
        toolCallCount: result.toolCallCount,
        iterations: result.iterations,
        usage: result.usage,
      });
    } catch (err) {
      await this.handleNodeFailure(task.id, node, err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight.delete(node.id);
    }
  }

  private async executeModelNode(
    task: TaskRecord,
    node: TaskNodeRecord,
    byId: Map<string, TaskNodeRecord>,
    resolvedInput: Record<string, unknown>
  ): Promise<void> {
    // Parsed, not cast: `input` is `Record<string, unknown>` off a jsonb column, so its
    // shape is a claim until something checks it. A malformed plan should fail this node
    // with a precise reason, not reach the provider as an unchecked assertion.
    const parsedMessages = chatMessageSchema.array().safeParse(resolvedInput.messages ?? []);
    if (!parsedMessages.success) {
      await this.handleNodeFailure(
        task.id,
        node,
        `model_call node input.messages is not a valid chat message array: ${parsedMessages.error.message}`,
        "plan-invalidating"
      );
      return;
    }
    const messages: ChatMessage[] = parsedMessages.data;

    await this.updateNode(node, { status: "waiting_model", startedAt: this.now() }, "engine");

    const controller = new AbortController();
    this.inFlight.set(node.id, controller);
    try {
      // ADR-046 — the same order as the chat route: refuse before spending, record after.
      if (this.deps.meter) {
        const estimatedTokens = estimatePromptTokens(messages.map((m) => m.content).join(" "));
        const check = await this.deps.meter.checkTokens(estimatedTokens, { taskId: task.id, nodeId: node.id });
        if (!check.allowed) {
          // A node failure, not a thrown quota error: the task's own failure path already
          // records the reason on the node and in the transition log, so an operator can see
          // exactly which node was refused and why.
          await this.handleNodeFailure(task.id, node, check.reason ?? "Token quota exceeded.");
          return;
        }
      }
      const result = await this.withNodeDeadline(
        node,
        controller,
        runModelToCompletion(this.deps.modelRouter, messages, node.modelProvider, controller.signal)
      );
      if (!(await this.stillRunning(node, "waiting_model"))) return;
      if (this.deps.meter) {
        // Recorded even when the router fell back to the mock — the ledger's job is to say
        // what actually happened, and `provider` on the row is what distinguishes them.
        await this.deps.meter.record({
          provider: result.provider,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          taskId: task.id,
          nodeId: node.id,
          // One model call per `model_call` node, so the node id alone is the natural key
          // (ADR-054): a node re-executed by crash recovery must not bill the project twice.
          idempotencyKey: `agent.node:${node.id}`,
        });
      }
      await this.verifyAndAdvance(task.id, node, byId, {
        content: result.content,
        provider: result.provider,
        model: result.model,
      });
    } catch (err) {
      await this.handleNodeFailure(task.id, node, err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight.delete(node.id);
    }
  }

  /**
   * docs/11_AGENT_LOOP.md §3.1's per-node `timeoutMs`, made real.
   *
   * The value was planned, persisted and then never enforced anywhere: only the tool
   * registry's own per-tool timeout bounded anything, and a `model_call` node had no
   * deadline at all. Racing the call here is the enforcement that matters, because it is the
   * only one that can stop the work while it is still this process's to stop; `sweep()`'s
   * `listTimedOut` pass is the backstop for an attempt whose process died holding it.
   */
  private async withNodeDeadline<T>(node: TaskNodeRecord, controller: AbortController, work: Promise<T>): Promise<T> {
    const message = `Node "${node.id}" exceeded its ${node.timeoutMs}ms timeout.`;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(new Error(message));
            reject(new Error(message));
          }, node.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Whether the outcome we are holding is still the node's to write. A cancellation or a
   * timeout can land while a call is in flight, and aborting is only ever best effort — a
   * handler that ignores its signal can still return successfully afterwards. Writing that
   * result would silently resurrect a node an operator (or the deadline) already stopped.
   */
  private async stillRunning(node: TaskNodeRecord, expected: NodeStatus): Promise<boolean> {
    const current = await this.deps.nodeRepo.getUnscoped(node.id);
    return current?.status === expected;
  }

  private async verifyAndAdvance(
    taskId: string,
    node: TaskNodeRecord,
    byId: Map<string, TaskNodeRecord>,
    output: Record<string, unknown>
  ): Promise<void> {
    await this.updateNode(node, { status: "verifying", output }, "engine");
    const nodeWithOutput = { ...node, output };

    let result;
    try {
      /**
       * The verification context (ADR-075). `byId` already holds every node in this task with
       * its persisted output, so a grounded check — "is this answer supported by what the
       * retrieval node actually returned" — needs no extra read. The sandbox runner and the
       * judge are injected at the composition root; a check whose dependency is missing FAILS
       * rather than passes, so an unrunnable check can never be mistaken for a satisfied one.
       */
      result = await verifyNodeOutput(nodeWithOutput, output, {
        dependencyOutput: (id) => (byId.get(id)?.output as Record<string, unknown> | undefined) ?? null,
        runTestCommand: this.deps.runTestCommand,
        judge: this.deps.judgeOutput,
      });
    } catch (err) {
      await this.handleNodeFailure(taskId, nodeWithOutput, err instanceof Error ? err.message : String(err));
      return;
    }

    if (result.pass) {
      // The scheduling bookkeeping is cleared with the same write that completes the node:
      // a finished node is not executing and is not owed a retry, and leaving either field
      // set would make `listTimedOut`/`listDueForRetry` answer for it later.
      await this.updateNode(
        nodeWithOutput,
        { status: "completed", startedAt: null, nextAttemptAt: null, failureClass: null },
        "engine"
      );
      byId.set(node.id, { ...nodeWithOutput, status: "completed", startedAt: null, nextAttemptAt: null, failureClass: null });
    } else {
      await this.handleNodeFailure(taskId, nodeWithOutput, result.reason ?? "Verification failed.");
    }
  }

  /**
   * docs/11_AGENT_LOOP.md §4.3. `failureClass` is what decides retry versus stop:
   * `retryable-execution` is a flaky call worth another attempt, `plan-invalidating` is a
   * fault a second identical attempt cannot fix (an unknown tool, a dangling template
   * reference, an unattributable call) and so terminates the node immediately.
   *
   * Retry exhaustion — and every plan-invalidating failure — still terminates the node (and,
   * via finalizeTask's cascade, the whole task) as FAILED in this increment: docs/11's
   * plan-invalidating *replan* loop is not implemented yet, which is why the class docstring
   * lists it as deferred. The column is written honestly regardless, so the replanner has
   * the input it will need.
   */
  private async handleNodeFailure(
    taskId: string,
    node: TaskNodeRecord,
    message: string,
    failureClass: FailureClass = "retryable-execution"
  ): Promise<void> {
    const attempts = node.attemptCount + 1;
    const canRetry = failureClass === "retryable-execution" && attempts < node.retryPolicy.maxAttempts;

    if (!canRetry) {
      await this.updateNode(
        node,
        {
          status: "failed",
          attemptCount: attempts,
          errorMessage: message,
          failureClass,
          startedAt: null,
          nextAttemptAt: null,
        },
        "engine"
      );
      return;
    }

    const delayMs = retryDelayMs(node.retryPolicy.backoff, attempts, this.backoff);
    const nextAttemptAt = this.now() + delayMs;
    // The node stays `retrying` until that deadline passes — it is NOT flipped straight back
    // to `pending` as it used to be, which is precisely what made the declared backoff
    // decorative. `tick` and `sweep` both re-dispatch it from this column.
    await this.updateNode(
      node,
      {
        status: "retrying",
        attemptCount: attempts,
        errorMessage: message,
        failureClass,
        startedAt: null,
        nextAttemptAt,
      },
      "engine",
      { attempt: attempts, backoff: node.retryPolicy.backoff, delayMs, nextAttemptAt }
    );
    await this.transitionTask(taskId, "RETRYING", "engine", {
      nodeId: node.id,
      attempt: attempts,
      message,
    });
  }

  private async finalizeTask(taskId: string, nodes: TaskNodeRecord[]): Promise<void> {
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
  // Scheduler (docs/11_AGENT_LOOP.md §4.3)
  // ---------------------------------------------------------------------------

  /**
   * One scheduler pass: fail whatever has run past its deadline, then dispatch whatever
   * backoff has come due.
   *
   * Deliberately a poll over persisted deadlines rather than a timer per node. A timer dies
   * with the process, whereas `started_at` and `next_attempt_at` survive a restart and are
   * visible to every instance sharing the database (ADR-052) — so a retry scheduled thirty
   * seconds before a crash still happens, and a node stranded mid-call by a dead instance is
   * still failed. Idempotent and cheap: every step re-reads the node it is about to touch and
   * does nothing if another path already moved it.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    await this.failTimedOutNodes(now);
    await this.dispatchDueRetries(now);
  }

  /**
   * Runs `sweep()` on an interval. Optional and started by the composition root, so an engine
   * embedded in a process that already has its own scheduler does not end up with two. The
   * timer is `unref`'d: a poll loop must never be the reason a process (or a test run)
   * refuses to exit.
   */
  startScheduler(intervalMs = 1_000): void {
    if (this.scheduler) return;
    this.scheduler = setInterval(() => {
      void this.sweep().catch((err) => this.onUnexpectedError("scheduler", err));
    }, intervalMs);
    this.scheduler.unref();
  }

  stopScheduler(): void {
    if (!this.scheduler) return;
    clearInterval(this.scheduler);
    this.scheduler = undefined;
  }

  private async failTimedOutNodes(now: number): Promise<void> {
    for (const node of await this.deps.nodeRepo.listTimedOut(new Date(now))) {
      // In-process, `withNodeDeadline` has normally already failed this node; what reaches
      // here is an attempt whose process died mid-call, which no in-memory timer could fire
      // for. Aborting first is still right for the case where this instance owns the call
      // but its clock and the database's disagreed about the deadline.
      this.inFlight.get(node.id)?.abort(new Error(`Node "${node.id}" exceeded its ${node.timeoutMs}ms timeout.`));
      await this.runExclusive(node.rootTaskId, async () => {
        const current = await this.deps.nodeRepo.getUnscoped(node.id);
        if (!current || !isRunningNode(current.status)) return;
        await this.handleNodeFailure(
          node.rootTaskId,
          current,
          `Node "${current.id}" exceeded its ${current.timeoutMs}ms timeout.`
        );
        await this.tick(node.rootTaskId);
      });
    }
  }

  private async dispatchDueRetries(now: number): Promise<void> {
    const due = await this.deps.nodeRepo.listDueForRetry(new Date(now));
    for (const taskId of new Set(due.map((n) => n.rootTaskId))) {
      // `tick` is what applies the deadline check and the promotion to `pending`, so this
      // poll and the dispatch loop cannot end up with two different notions of "due".
      await this.runExclusive(taskId, () => this.tick(taskId));
    }
  }

  // ---------------------------------------------------------------------------
  // Crash recovery (docs/11_AGENT_LOOP.md §4.2-4.3)
  // ---------------------------------------------------------------------------

  async resumeAll(): Promise<void> {
    const inFlightNodes = await this.deps.nodeRepo.listInFlight();

    for (const node of inFlightNodes) {
      if (node.status === "waiting_model") {
        await this.updateNode(node, { status: "pending", startedAt: null }, "system:crash-recovery");
      } else if (node.status === "retrying") {
        // A backoff is NOT restarted by a restart, and not lost to one either: the deadline
        // is a column, so `sweep()` below picks the node up exactly when it was already due.
        // A row written before the column existed has no deadline at all; treating it as due
        // now is what stops an upgrade stranding it forever.
        if (node.nextAttemptAt === null) {
          await this.updateNode(node, { nextAttemptAt: this.now() }, "system:crash-recovery");
        }
      } else if (node.status === "waiting_tool") {
        const toolDef = node.toolId ? this.deps.toolRegistry.get(node.toolId) : undefined;
        if (toolDef?.permissionLevel === "read_only") {
          await this.updateNode(node, { status: "pending", startedAt: null }, "system:crash-recovery");
        } else {
          // Non-atomic mutating call was in flight at crash time — outcome unknown.
          // Never auto-retry (docs/11 §4.3, docs/10 §3.3). Surface for manual reconciliation.
          await this.updateNode(node, { status: "needs_reconciliation", startedAt: null }, "system:crash-recovery");
          await this.transitionTask(node.rootTaskId, "PAUSED", "system:crash-recovery", {
            reason: `Node ${node.id} (tool ${node.toolId}) was mid-call at crash time and cannot be safely auto-retried.`,
          });
        }
      } else if (node.status === "verifying") {
        // Output was already persisted before the crash; re-verifying is a pure,
        // side-effect-free check, so it's always safe to just redo it.
        const siblings = await this.deps.nodeRepo.listByRootUnscoped(node.rootTaskId);
        const byId = new Map<string, TaskNodeRecord>(siblings.map((n) => [n.id, n]));
        await this.verifyAndAdvance(node.rootTaskId, node, byId, node.output ?? {});
      }
    }

    for (const task of await this.deps.taskRepo.listNonTerminal()) {
      if (task.state === "WAITING_FOR_APPROVAL" || task.state === "PAUSED") continue; // safe to just wait
      if (task.state === "UNDERSTANDING" || task.state === "PLANNING") {
        const nodes = await this.deps.nodeRepo.listByRootUnscoped(task.id);
        if (nodes.length === 0) {
          void this.runExclusive(task.id, () => this.planAndExecute(task.id, task.taskType, task.input)).catch(
            (err) => this.onUnexpectedError(task.id, err)
          );
          continue;
        }
      }
      void this.runExclusive(task.id, () => this.tick(task.id)).catch((err) => this.onUnexpectedError(task.id, err));
    }

    // Deadlines that fell due while the process was down exist only in the database. One
    // pass now means a restart does not have to wait out a whole scheduler interval before
    // an overdue retry or a stranded node is dealt with.
    await this.sweep();
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
    node: TaskNodeRecord,
    patch: TaskNodePatch,
    actor: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    await this.deps.nodeRepo.update(node.id, patch);
    await this.deps.transitionRepo.append({
      taskId: node.rootTaskId,
      nodeId: node.id,
      fromState: node.status,
      toState: patch.status ?? node.status,
      actor,
      // The extra payload is how a gate or a backoff explains itself in the append-only log:
      // "which node, and why" is otherwise unrecoverable after the fact.
      payload: buildTransitionPayload(patch, payload),
    });
    const updated = await this.deps.nodeRepo.getUnscoped(node.id);
    if (updated) this.emit(node.rootTaskId, { type: "node", taskId: node.rootTaskId, node: updated });
  }

  private async transitionTask(
    taskId: string,
    toState: Task["state"],
    actor: string,
    patch?: { errorMessage?: string | null; nodeId?: string; attempt?: number; message?: string; reason?: string },
    output?: Record<string, unknown>
  ): Promise<void> {
    const current = await this.deps.taskRepo.getUnscoped(taskId);
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

  private onUnexpectedError(scope: string, err: unknown): void {
    // eslint-disable-next-line no-console
    console.error(`[agent-core] unexpected error in ${scope}:`, err);
  }
}

function isTerminalTask(state: Task["state"]): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

function isTerminalNode(status: NodeStatus): boolean {
  return (TERMINAL_NODE_STATUSES as readonly string[]).includes(status);
}

function isRunningNode(status: NodeStatus): boolean {
  return (RUNNING_NODE_STATUSES as readonly string[]).includes(status);
}

function buildTransitionPayload(
  patch: TaskNodePatch,
  extra?: Record<string, unknown>
): Record<string, unknown> | null {
  const payload: Record<string, unknown> = { ...extra };
  if (patch.errorMessage) payload.errorMessage = patch.errorMessage;
  return Object.keys(payload).length > 0 ? payload : null;
}

async function runModelToCompletion(
  router: ModelRouter,
  messages: ChatMessage[],
  provider: string | null,
  signal: AbortSignal
): Promise<{ content: string; provider: string; model: string; usage: TokenUsage }> {
  for await (const event of router.streamChat({ messages, provider: provider ?? undefined }, { signal })) {
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") {
      // `usage` was previously discarded here — which is precisely why an agent task's real
      // token spend never reached the ledger (ADR-046).
      return { content: event.message.content, provider: event.provider, model: event.model, usage: event.usage };
    }
  }
  throw new Error("Model stream ended without a done event.");
}

/**
 * The standing instruction for an autonomous run. Deliberately short: a long persona prompt
 * competes with the user's actual goal for the model's attention, and everything genuinely
 * enforceable (budgets, approval, isolation) is enforced by the harness rather than requested
 * politely here.
 */
export const AUTONOMOUS_SYSTEM_PROMPT = [
  "You are an autonomous agent working inside a sandboxed project workspace.",
  "Use the tools available to you to accomplish the user's goal. Inspect before you change anything.",
  "If a tool fails, read the error, adjust, and try a different approach rather than repeating the same call.",
  "When you have accomplished the goal, reply with a concise summary of what you did and what the result was.",
  "If the goal cannot be accomplished with the tools you have, say so plainly instead of guessing.",
].join(" ");

/** Reads the resume state a paused reasoning node persisted, tolerating anything malformed. */
function readResumeState(
  output: Record<string, unknown> | null
): { transcript: ChatMessage[]; approvedCallIds: string[]; pendingCall: ToolCall | null } | null {
  const resume = (output as { resume?: unknown } | null)?.resume;
  if (!resume || typeof resume !== "object") return null;
  const { transcript, approvedCallIds } = resume as { transcript?: unknown; approvedCallIds?: unknown };
  const parsed = chatMessageSchema.array().safeParse(transcript);
  if (!parsed.success) return null;

  // The call a human approved, validated rather than trusted: it round-tripped through a
  // jsonb column, so its shape is a claim until something checks it.
  const pending = toolCallSchema.safeParse((output as { pendingCall?: unknown } | null)?.pendingCall);

  return {
    transcript: parsed.data,
    approvedCallIds: Array.isArray(approvedCallIds) ? approvedCallIds.map(String) : [],
    pendingCall: pending.success ? pending.data : null,
  };
}
