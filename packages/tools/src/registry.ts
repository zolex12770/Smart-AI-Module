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
   */
  async call(toolId: string, args: Record<string, unknown>, context: ToolInvocationContext): Promise<ToolCallResult> {
    const entry = this.entries.get(toolId);
    if (!entry) return { ok: false, error: `Unknown tool "${toolId}".` };
    if (!entry.definition.enabled) {
      return { ok: false, error: `Tool "${toolId}" is disabled. An operator must enable it explicitly.` };
    }

    try {
      validateToolArguments(entry.definition.inputSchema, args, toolId);
    } catch (err) {
      // Returned rather than thrown: when a model supplied the arguments, this message is
      // fed back so it can correct itself, which is more useful than failing the run.
      return { ok: false, error: err instanceof ValidationError ? err.message : String(err) };
    }

    try {
      const result = await withTimeout(
        entry.handler(args, context),
        entry.definition.timeoutMs,
        `Tool "${toolId}" timed out after ${entry.definition.timeoutMs}ms.`
      );
      if (result.ok) await this.options.markUsed?.(context.projectId, toolId);
      return result;
    } catch (err) {
      if (err instanceof PermissionError) throw err;
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
