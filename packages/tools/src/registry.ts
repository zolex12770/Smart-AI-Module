import type { ToolCallResult, ToolDefinition, ToolHandler } from "@ai-platform/shared";

/**
 * Single source of truth for every callable tool, native or MCP-sourced — implements
 * docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3. The orchestrator (packages/agent-core) never
 * calls a tool's handler directly; it always goes through `ToolRegistry.call`, which is
 * the one enforcement point for the permission gate (docs/10 §3.2 "Permission Gate").
 */
export class ToolRegistry {
  private readonly entries = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    this.entries.set(definition.id, { definition, handler });
  }

  get(id: string): ToolDefinition | undefined {
    return this.entries.get(id)?.definition;
  }

  list(): ToolDefinition[] {
    return [...this.entries.values()].map((e) => e.definition);
  }

  /**
   * Explicit operator action to enable/disable a tool — the only way a newly-discovered
   * MCP tool (registered disabled by default, docs/10 §3.2) becomes callable.
   */
  setEnabled(id: string, enabled: boolean): ToolDefinition {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown tool "${id}".`);
    entry.definition = { ...entry.definition, enabled };
    return entry.definition;
  }

  /**
   * Executes a tool call. Approval gating happens one layer up in agent-core (which
   * decides whether to even reach this call based on `requiresApproval` + task state),
   * so by the time `call` runs, approval (if required) has already been granted — this
   * function's job is just: does the tool exist, is it enabled, then run it.
   */
  async call(toolId: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const entry = this.entries.get(toolId);
    if (!entry) {
      return { ok: false, error: `Unknown tool "${toolId}".` };
    }
    if (!entry.definition.enabled) {
      return { ok: false, error: `Tool "${toolId}" is disabled.` };
    }

    const timeoutMs = entry.definition.timeoutMs;
    try {
      return await withTimeout(entry.handler(args), timeoutMs, toolId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool "${label}" timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
