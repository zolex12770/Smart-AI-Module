import { recordToolCall, withSpan, type Span } from "@ai-platform/observability";
import {
  PermissionError,
  ValidationError,
  validateToolArguments,
  type RequiresApproval,
  type RiskLevel,
  type ToolCallResult,
  type ToolHandler,
  type ToolInvocationContext,
  type ToolDefinition,
  type ToolSpec,
} from "@ai-platform/shared";



export interface ApprovalDecision {
  required: boolean;
  reason?: string;
}

export interface ToolRegistryOptions {
  /**
   * Risk at or above which `risk_threshold` tools demand approval. Making this a policy knob
   * is what turns the fourth approval mode from a synonym for "always" into a real setting.
   */
  approvalRiskThreshold?: RiskLevel;
  /** Records that a tool has been used before, for `first_use`. Persisted by the caller. */
  hasUsedBefore?: (projectId: string, toolId: string) => Promise<boolean>;
  markUsed?: (projectId: string, toolId: string) => Promise<void>;
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * The tool registry — docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3, completed by ADR-059.
 *
 * The ADR-047 audit found three things wrong with the previous version, all fixed here:
 *
 * 1. `inputSchema` was decorative — `call()` never validated arguments against it. It does
 *    now, before the handler is reached, which matters far more once a *model* is choosing
 *    the arguments.
 * 2. The four `requiresApproval` modes collapsed to a boolean, so `first_use` and
 *    `risk_threshold` silently behaved like `always`. All four are now distinct.
 * 3. The registry claimed to be "the one enforcement point for the permission gate" while
 *    checking only `enabled`. It now genuinely owns validation, approval policy, the
 *    enabled check and the timeout, and says so honestly.
 *
 * A timeout here still only bounds the *promise*; killing the underlying work is the
 * sandbox's job (packages/security), which the terminal tool uses.
 */
export class ToolRegistry {
  private readonly entries = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  constructor(private readonly options: ToolRegistryOptions = {}) {}

  register(definition: ToolDefinition, handler: ToolHandler): void {
    const existing = this.entries.get(definition.id);
    if (existing) {
      // Silently replacing a registration could re-enable a tool an operator disabled, or
      // swap a trusted implementation for another server's. Refuse instead.
      throw new ValidationError(
        `Tool "${definition.id}" is already registered by ${existing.definition.origin.serverId ?? "a native provider"}.`
      );
    }
    this.entries.set(definition.id, { definition, handler });
  }

  get(id: string): ToolDefinition | undefined {
    return this.entries.get(id)?.definition;
  }

  /**
   * Removes a registration outright — the counterpart `register` has always needed.
   *
   * Because `register` refuses to overwrite, an id can only ever be reclaimed by being
   * removed first, and nothing could remove one. That made `McpManager.reconnect` fail in a
   * way no test caught (the manager's suite stubs the connector): disconnect disabled a dead
   * server's tools but left them registered, so the reconnect's rediscovery hit
   * "Tool ... is already registered" on every id and the server could never come back. It
   * also left a disconnected server's tools listed and callable-looking, holding a handler
   * closed over a client whose transport is gone.
   *
   * Returns whether anything was removed, so a caller unwinding a partial registration can
   * distinguish "removed" from "never got that far" without a try/catch.
   */
  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  list(): ToolDefinition[] {
    return [...this.entries.values()].map((e) => e.definition);
  }

  /** Enabled tools only, in the JSON-Schema shape a model provider expects (ADR-047). */
  toolSpecs(filter?: (definition: ToolDefinition) => boolean): ToolSpec[] {
    return this.list()
      .filter((d) => d.enabled && (filter ? filter(d) : true))
      .map((d) => ({ name: d.id, description: d.description, inputSchema: d.inputSchema }));
  }

  setEnabled(id: string, enabled: boolean): ToolDefinition {
    const entry = this.entries.get(id);
    if (!entry) throw new ValidationError(`Unknown tool "${id}".`);
    entry.definition = { ...entry.definition, enabled };
    return entry.definition;
  }

  /**
   * Whether this specific call needs a human. Resolved per invocation because `first_use`
   * depends on history and `risk_threshold` depends on deployment policy.
   */
  async approvalFor(id: string, projectId: string): Promise<ApprovalDecision> {
    const definition = this.get(id);
    if (!definition) throw new ValidationError(`Unknown tool "${id}".`);
    const mode: RequiresApproval = definition.requiresApproval;

    switch (mode) {
      case "never":
        return { required: false };
      case "always":
        return { required: true, reason: `"${definition.name}" always requires approval.` };
      case "first_use": {
        if (!this.options.hasUsedBefore) {
          // Without a store there is no way to know it is not the first use; the safe
          // reading of "first use" is then "every use".
          return { required: true, reason: `First use of "${definition.name}" in this project.` };
        }
        const used = await this.options.hasUsedBefore(projectId, id);
        return used
          ? { required: false }
          : { required: true, reason: `First use of "${definition.name}" in this project.` };
      }
      case "risk_threshold": {
        const threshold = this.options.approvalRiskThreshold ?? "high";
        const required = RISK_ORDER[definition.riskLevel] >= RISK_ORDER[threshold];
        return required
          ? { required: true, reason: `Risk level "${definition.riskLevel}" is at or above the "${threshold}" threshold.` }
          : { required: false };
      }
    }
  }

  /**
   * Executes a tool. Order matters and is deliberate: existence, then enabled, then argument
   * validation, then the handler under a timeout. Approval is resolved by the *caller* (the
   * agent engine), because only it can pause a task and ask a human.
   *
   * The whole body runs inside a `tool.call` span (ADR-073). It goes HERE rather than at the
   * two call sites — the engine's tool nodes and the reasoning loop — because a span added per
   * call site is one a third call site can silently skip, and "which tools are slow, and which
   * fail" is precisely the question that must not have a blind spot. The span covers argument
   * validation and the rejection paths too: a tool rejected for being disabled or for bad
   * arguments never reaches the handler, and an operator watching only successful executions
   * would see nothing at all while a model burned its whole iteration budget on them.
   */
  async call(toolId: string, args: Record<string, unknown>, context: ToolInvocationContext): Promise<ToolCallResult> {
    return withSpan(
      "tool.call",
      {
        "tool.id": toolId,
        // Tenancy on every span: a trace that cannot say whose it is serves neither cost
        // attribution nor incident scoping (ADR-049).
        project_id: context.projectId,
        user_id: context.userId,
      },
      async (span) => {
        // The outcome the span records is the one the metric records, so a dashboard and a trace
        // can never disagree about the same call. A holder rather than a return-value change
        // because `invoke` writes it at several early-return points (unknown tool, disabled,
        // invalid arguments) that never reach the handler.
        const outcome = { value: "unknown" };
        const result = await this.invoke(span, toolId, args, context, outcome);
        /**
         * Counted as well as spanned (ADR-082): "which tools fail, and how often" is a rate
         * question, and a span answers it only by scanning every trace.
         *
         * A tool that is not registered is counted as the literal `unknown_tool`, never under
         * the name that was asked for. `tool_name` is a Prometheus label, and metrics.ts
         * guarantees that "every label is bounded by construction" — the registry's own key set
         * is what bounds this one. Passing `toolId` through unchecked broke that guarantee in
         * the one case where the value is attacker- or model-controlled: a model that invents a
         * name (a normal event in a driven loop — `invoke` has a whole branch for it) minted a
         * brand new time series on every call, and a loop that hallucinates a fresh name each
         * turn is an unbounded-cardinality explosion in the metrics backend, which degrades
         * every other query that shares it. The span still carries the exact `tool.id`, so the
         * name that was actually attempted is not lost — it lives where high-cardinality data
         * belongs. `outcome` is untouched: it already takes one of a fixed set of values.
         */
        recordToolCall({ tool: this.entries.has(toolId) ? toolId : "unknown_tool", outcome: outcome.value });
        return result;
      }
    );
  }

  private async invoke(
    span: Span,
    toolId: string,
    args: Record<string, unknown>,
    context: ToolInvocationContext,
    outcome: { value: string }
  ): Promise<ToolCallResult> {
    const entry = this.entries.get(toolId);
    if (!entry) {
      // `outcome` rather than span status: an unknown tool is a normal, expected event in a
      // model-driven loop (the model guessed a name), not an error in the platform. Marking it
      // ERROR would bury real failures under model hallucinations.
      span.setAttribute("tool.outcome", "unknown_tool");
      outcome.value = "unknown_tool";
      return { ok: false, error: `Unknown tool "${toolId}".` };
    }
    span.setAttribute("tool.risk_level", entry.definition.riskLevel);
    if (!entry.definition.enabled) {
      span.setAttribute("tool.outcome", "disabled");
      outcome.value = "disabled";
      return { ok: false, error: `Tool "${toolId}" is disabled. An operator must enable it explicitly.` };
    }

    try {
      validateToolArguments(entry.definition.inputSchema, args, toolId);
    } catch (err) {
      // Returned rather than thrown: when a model supplied the arguments, this message is
      // fed back so it can correct itself, which is more useful than failing the run.
      span.setAttribute("tool.outcome", "invalid_arguments");
      outcome.value = "invalid_arguments";
      return { ok: false, error: err instanceof ValidationError ? err.message : String(err) };
    }

    try {
      const result = await withTimeout(
        entry.handler(args, context),
        entry.definition.timeoutMs,
        `Tool "${toolId}" timed out after ${entry.definition.timeoutMs}ms.`
      );
      if (result.ok) await this.options.markUsed?.(context.projectId, toolId);
      span.setAttribute("tool.outcome", result.ok ? "ok" : "failed");
      outcome.value = result.ok ? "ok" : "failed";
      return result;
    } catch (err) {
      if (err instanceof PermissionError) throw err;
      span.setAttribute("tool.outcome", "error");
      outcome.value = "error";
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { ToolHandler, ToolInvocationContext };
