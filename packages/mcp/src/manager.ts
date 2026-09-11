import { ValidationError } from "@ai-platform/shared";
import type { ToolRegistry } from "@ai-platform/tools";
import {
  connectMcpServer,
  isLoopbackHost,
  parseHttpUrl,
  type McpConnection,
  type McpServerConfig,
  type McpTransportKind,
} from "./client.js";

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
 *
 * The lifecycle is transport-agnostic: a remote http server goes through exactly the same
 * connect / discover / health / reconnect / disconnect path as a local stdio one, and the only
 * places the difference shows are the timeouts (see `McpManagerOptions`) — a subprocess that
 * dies tells us so, a remote that dies does not — and the `transport` field on the state,
 * which is there so an operator can see which wire a server actually came up on.
 */

export type McpServerStatus = "connected" | "connecting" | "failed" | "disconnected";

export interface McpServerState {
  id: string;
  status: McpServerStatus;
  /** Null until a connection succeeds — before that we do not know which wire a remote speaks. */
  transport: McpTransportKind | null;
  toolIds: string[];
  /**
   * Ids this server offered and was refused because they were already registered. An operator
   * needs to see these: an empty tool list plus a refusal is a very different story from an
   * empty tool list, and on a remote server it is the shape a name-squatting attempt takes.
   */
  refusedToolIds: string[];
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
  /**
   * Bounds the MCP handshake and tool discovery. Passed through to the connector because a
   * remote that accepts the TCP connection and then goes quiet would otherwise leave
   * `startAll` pending forever and take the API's boot with it.
   */
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /**
   * Bounds the health probe itself. A stdio server that has died reports EPIPE at once; a
   * remote one can simply stop answering, and an un-timed probe would never resolve — so the
   * health loop would keep believing a dead server was up, which is the exact failure this
   * check exists to catch.
   */
  healthTimeoutMs?: number;
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
        transport: null,
        toolIds: [],
        refusedToolIds: [],
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

  /**
   * Closes one server's connection and REMOVES its tools from the registry.
   *
   * Removal, not merely disabling. The previous version disabled them and left them
   * registered, reasoning that "tool is disabled" reads better to a task than "unknown tool".
   * That traded a slightly nicer message for two real defects:
   *
   *   1. `reconnect` could never work against a real server. `ToolRegistry.register` refuses
   *      to overwrite an id, so rediscovery after a reconnect was rejected for every tool the
   *      server had previously registered — permanently, for the life of the process. Nothing
   *      caught it because this manager's own suite stubs the connector and registers nothing.
   *   2. A disconnected server's tools stayed in `list()`, each holding a handler closed over
   *      a client whose transport is gone, so an operator could enable one and every call
   *      through it would go to a dead connection.
   *
   * The registry's unknown-tool path returns a failed `ToolCallResult` rather than throwing or
   * hanging, so a task naming a removed tool still fails cleanly and immediately; "the server
   * is down" lives in the state this manager exposes through `/api/v1/mcp`, which is where an
   * operator looks for it anyway.
   *
   * `setEnabled` before `unregister` is deliberate ordering, not leftovers: a caller that has
   * already resolved the definition observes `enabled: false` rather than a definition that
   * silently stopped existing, so the transition to unavailable only ever runs one way.
   */
  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    this.connections.delete(serverId);
    try {
      await connection.close();
    } catch {
      /* the subprocess or the remote may already be gone; nothing useful to do about it */
    }
    const state = this.states.get(serverId);
    if (state) {
      for (const toolId of state.toolIds) {
        try {
          this.registry.setEnabled(toolId, false);
        } catch {
          /* already gone */
        }
        this.registry.unregister(toolId);
      }
      this.states.set(serverId, { ...state, status: "disconnected", toolIds: [], connectedAt: null });
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
        const connection = await connectMcpServer(this.registry, config, {
          connectTimeoutMs: this.options.connectTimeoutMs,
          requestTimeoutMs: this.options.requestTimeoutMs,
          logger: this.options.logger,
        });
        this.connections.set(config.id, connection);
        this.states.set(config.id, {
          id: config.id,
          status: "connected",
          transport: connection.transport,
          toolIds: connection.toolIds,
          refusedToolIds: connection.refusedToolIds,
          lastError: null,
          connectedAt: new Date().toISOString(),
          attempts: attempt,
        });
        this.options.logger?.info(
          {
            server_id: config.id,
            transport: connection.transport,
            tools: connection.toolIds.length,
            refused_tools: connection.refusedToolIds.length,
            attempt,
          },
          "MCP server connected — tools registered disabled pending explicit enable"
        );
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.states.set(config.id, {
          id: config.id,
          status: attempt === maxAttempts ? "failed" : "connecting",
          transport: null,
          toolIds: [],
          refusedToolIds: [],
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
   *
   * The probe is time-boxed. For stdio that is belt and braces (a dead child closes the pipe),
   * but a remote server can accept a connection and then never answer, and an un-timed
   * `listTools` would simply never settle: the loop would hold that server as `connected`
   * forever, which is precisely the state this check exists to disprove.
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
    const timeout = this.options.healthTimeoutMs ?? 10_000;
    for (const [serverId, connection] of this.connections) {
      try {
        await connection.client.listTools(undefined, { timeout });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.warn(
          { server_id: serverId, error: message },
          "MCP server stopped responding — marking it down and removing its tools"
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
 *
 * Each entry is EITHER stdio or http, and the two are told apart by which endpoint they name:
 *
 *   {"id":"fs","command":"node","args":["server.js"],"cwd":"/workspace"}
 *   {"id":"docs","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ..."}}
 *
 * An entry carrying both is rejected rather than resolved by precedence: silently preferring
 * one would mean an operator who added a `url` to an existing stdio entry, intending to move
 * the server, keeps running the old subprocess and never finds out.
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
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || !id.trim()) {
      errors.push(`MCP_SERVERS[${index}] has no "id".`);
      continue;
    }

    const hasCommand = typeof e.command === "string" && e.command.trim().length > 0;
    const hasUrl = typeof e.url === "string" && e.url.trim().length > 0;
    if (hasCommand && hasUrl) {
      errors.push(
        `MCP_SERVERS[${index}] ("${id}") sets both "command" and "url"; a server is either stdio or http, not both.`
      );
      continue;
    }
    if (!hasCommand && !hasUrl) {
      errors.push(`MCP_SERVERS[${index}] ("${id}") has no "command" (stdio) and no "url" (http).`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`MCP_SERVERS has a duplicate id "${id}".`);
      continue;
    }

    if (hasUrl) {
      const httpConfig = parseHttpEntry(index, id, e, errors);
      if (!httpConfig) continue;
      seen.add(id);
      configs.push(httpConfig);
      continue;
    }

    seen.add(id);
    configs.push({
      id,
      command: e.command as string,
      args: Array.isArray(e.args) ? e.args.map(String) : [],
      // Never inherited: an MCP subprocess must not receive the API's environment (ADR-055).
      env: e.env && typeof e.env === "object" ? (e.env as Record<string, string>) : undefined,
      cwd: typeof e.cwd === "string" ? e.cwd : undefined,
    });
  }
  return { configs, errors };
}

/**
 * Validates one http entry, returning null (and pushing a reason) when it must be skipped.
 *
 * The refusal that is a policy rather than a syntax check: an entry that would put credentials
 * on a plaintext connection to a host that is not loopback is rejected. `headers` exists to
 * carry a bearer token or an API key, and `http://` to a remote host puts that token in clear
 * on the wire and into every proxy log between here and there. It is skipped, not sanitised by
 * dropping the headers, because a connection made without the credentials the operator
 * configured would either fail confusingly or — worse — succeed unauthenticated.
 */
function parseHttpEntry(
  index: number,
  id: string,
  e: Record<string, unknown>,
  errors: string[]
): McpServerConfig | null {
  const rawUrl = (e.url as string).trim();
  let url: URL;
  try {
    url = parseHttpUrl(rawUrl, id);
  } catch (err) {
    errors.push(
      `MCP_SERVERS[${index}] ${err instanceof ValidationError ? err.message : `("${id}") has an unusable "url".`}`
    );
    return null;
  }

  let headers: Record<string, string> | undefined;
  if (e.headers !== undefined) {
    if (typeof e.headers !== "object" || e.headers === null || Array.isArray(e.headers)) {
      errors.push(`MCP_SERVERS[${index}] ("${id}") has "headers" that is not an object.`);
      return null;
    }
    const entries = Object.entries(e.headers as Record<string, unknown>);
    const nonString = entries.find(([, value]) => typeof value !== "string");
    if (nonString) {
      // Named, but never the value: the value is the credential.
      errors.push(`MCP_SERVERS[${index}] ("${id}") has a non-string value for header "${nonString[0]}".`);
      return null;
    }
    if (entries.length > 0) headers = Object.fromEntries(entries) as Record<string, string>;
  }

  if (headers && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    errors.push(
      `MCP_SERVERS[${index}] ("${id}") sends "headers" over plaintext http to ${url.hostname}; use https, or drop the credentials.`
    );
    return null;
  }

  return { id, url: url.toString(), headers };
}
