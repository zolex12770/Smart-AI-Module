import type { ToolRegistry } from "@ai-platform/tools";
import { connectMcpServer, type McpConnection, type McpServerConfig } from "./client.js";

/**
 * Multi-server MCP lifecycle — docs/26_DECISIONS.md ADR-067, docs/10_TOOL_AND_MCP_ARCHITECTURE.md §2.
 *
 * The ADR-047 audit found five specific problems with the previous integration, all of which
 * came from there being no manager at all — just a single `connectMcpServer` call in the
 * composition root whose result was assigned to a local and dropped:
 *
 *   1. Exactly one server, hardcoded.
 *   2. The connection was never closed, so shutdown leaked the subprocess.
 *   3. No reconnection: if the server died, every enabled tool silently began failing.
 *   4. No health signal an operator could look at.
 *   5. The planner hardcoded an MCP tool id and *failed the whole task* when the server was
 *      absent, which made an optional integration a hidden hard dependency.
 *
 * This owns all five. The rule it enforces is the one the brief states directly: **MCP is
 * optional and failure-isolated.** One server failing to start must never prevent another from
 * starting, and must never prevent the platform from running.
 */

export type McpServerStatus = "connected" | "connecting" | "failed" | "disconnected";

export interface McpServerState {
  id: string;
  status: McpServerStatus;
  toolIds: string[];
  lastError: string | null;
  connectedAt: string | null;
  attempts: number;
}

export interface McpManagerOptions {
  /** Attempts before a server is left `failed` until an operator asks for a reconnect. */
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** How often to check that connected servers are still answering. 0 disables. */
  healthIntervalMs?: number;
  logger?: { info(o: object, m: string): void; warn(o: object, m: string): void };
  sleep?: (ms: number) => Promise<void>;
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly states = new Map<string, McpServerState>();
  private readonly configs = new Map<string, McpServerConfig>();
  private healthTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: McpManagerOptions = {}
  ) {}

  /**
   * Connects every configured server. Deliberately returns rather than throws: a server that
   * cannot start is recorded as `failed` and the platform continues without it, because an
   * optional integration must not be able to stop a boot.
   */
  async startAll(configs: McpServerConfig[]): Promise<McpServerState[]> {
    for (const config of configs) {
      this.configs.set(config.id, config);
      this.states.set(config.id, {
        id: config.id,
        status: "connecting",
        toolIds: [],
        lastError: null,
        connectedAt: null,
        attempts: 0,
      });
    }
    // In parallel: one slow server must not delay the others' availability.
    await Promise.all(configs.map((config) => this.connectWithRetry(config)));
    this.startHealthChecks();
    return this.status();
  }

  status(): McpServerState[] {
    return [...this.states.values()];
  }

  /** Operator-initiated reconnect. Returns null when the id is not configured. */
  async reconnect(serverId: string): Promise<McpServerState | null> {
    const config = this.configs.get(serverId);
    if (!config) return null;
    await this.disconnect(serverId);
    await this.connectWithRetry(config);
    return this.states.get(serverId) ?? null;
  }

  /** Closes one server's subprocess and forgets its tools. */
  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    this.connections.delete(serverId);
    try {
      await connection.close();
    } catch {
      /* the subprocess may already be gone; nothing useful to do about it */
    }
    const state = this.states.get(serverId);
    if (state) {
      // Tools stay registered but disabled: an id that vanishes mid-session would make a
      // task referencing it fail with "unknown tool" rather than the truer "server is down".
      for (const toolId of state.toolIds) {
        try {
          this.registry.setEnabled(toolId, false);
        } catch {
          /* already gone */
        }
      }
      this.states.set(serverId, { ...state, status: "disconnected", connectedAt: null });
    }
  }

  /** Shuts every server down. Called from the process's graceful-shutdown path. */
  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  private async connectWithRetry(config: McpServerConfig): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const base = this.options.baseRetryDelayMs ?? 500;
    const max = this.options.maxRetryDelayMs ?? 10_000;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.stopped) return;
      try {
        const connection = await connectMcpServer(this.registry, config);
        this.connections.set(config.id, connection);
        this.states.set(config.id, {
          id: config.id,
          status: "connected",
          toolIds: connection.toolIds,
          lastError: null,
          connectedAt: new Date().toISOString(),
          attempts: attempt,
        });
        this.options.logger?.info(
          { server_id: config.id, tools: connection.toolIds.length, attempt },
          "MCP server connected — tools registered disabled pending explicit enable"
        );
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.states.set(config.id, {
          id: config.id,
          status: attempt === maxAttempts ? "failed" : "connecting",
          toolIds: [],
          lastError: message,
          connectedAt: null,
          attempts: attempt,
        });
        this.options.logger?.warn(
          { server_id: config.id, attempt, error: message },
          attempt === maxAttempts
            ? "MCP server failed to connect — continuing without it (MCP is optional)"
            : "MCP server connection failed, retrying"
        );
        if (attempt < maxAttempts) await sleep(Math.min(base * 2 ** (attempt - 1), max));
      }
    }
  }

  /**
   * Liveness, by asking each connected server to list its tools. A dead subprocess would
   * otherwise present as a set of enabled tools that all fail — the failure mode the audit
   * called out — instead of a server visibly marked down.
   */
  private startHealthChecks(): void {
    const interval = this.options.healthIntervalMs ?? 60_000;
    if (interval <= 0) return;
    this.healthTimer = setInterval(() => {
      void this.checkHealth();
    }, interval);
    // Never hold the process open just to poll a health check.
    this.healthTimer.unref?.();
  }

  async checkHealth(): Promise<void> {
    for (const [serverId, connection] of this.connections) {
      try {
        await connection.client.listTools();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.warn(
          { server_id: serverId, error: message },
          "MCP server stopped responding — marking it down and disabling its tools"
        );
        await this.disconnect(serverId);
        this.states.set(serverId, {
          ...(this.states.get(serverId) as McpServerState),
          status: "failed",
          lastError: message,
        });
      }
    }
  }
}

/**
 * Parses `MCP_SERVERS` — a JSON array of server configs — so a deployment can run any set of
 * servers without a code change. Invalid entries are skipped with a reason rather than failing
 * the boot, because one malformed entry must not cost an operator the whole platform.
 */
export function parseMcpServerConfigs(raw: string | undefined): {
  configs: McpServerConfig[];
  errors: string[];
} {
  if (!raw?.trim()) return { configs: [], errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { configs: [], errors: [`MCP_SERVERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!Array.isArray(parsed)) return { configs: [], errors: ["MCP_SERVERS must be a JSON array."] };

  const configs: McpServerConfig[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const e = entry as Partial<McpServerConfig>;
    if (typeof e?.id !== "string" || !e.id.trim()) {
      errors.push(`MCP_SERVERS[${index}] has no "id".`);
      continue;
    }
    if (typeof e.command !== "string" || !e.command.trim()) {
      errors.push(`MCP_SERVERS[${index}] ("${e.id}") has no "command".`);
      continue;
    }
    if (seen.has(e.id)) {
      errors.push(`MCP_SERVERS has a duplicate id "${e.id}".`);
      continue;
    }
    seen.add(e.id);
    configs.push({
      id: e.id,
      command: e.command,
      args: Array.isArray(e.args) ? e.args.map(String) : [],
      // Never inherited: an MCP subprocess must not receive the API's environment (ADR-055).
      env: e.env && typeof e.env === "object" ? (e.env as Record<string, string>) : undefined,
      cwd: typeof e.cwd === "string" ? e.cwd : undefined,
    });
  }
  return { configs, errors };
}
