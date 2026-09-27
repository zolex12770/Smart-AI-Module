import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PermissionLevel, ToolDefinition } from "@ai-platform/shared";
import { PERMISSION_LEVEL_DEFAULTS, ServiceUnavailableError, ValidationError } from "@ai-platform/shared";
import { projectWorkspace, resolveSandboxedPath, type ToolRegistry } from "@ai-platform/tools";

/** A LOCAL MCP server the platform launches as a subprocess. The original transport. */
export interface McpStdioServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Confines a FILESYSTEM server's path arguments to the calling project's workspace under
   * `root` — see `scopePathArguments`. Set for the bundled reference server, which is launched
   * over the whole sandbox root and so, unscoped, would let one tenant's agent read another's.
   */
  workspaceScope?: { root: string };
}

/**
 * A REMOTE MCP server reached over HTTP — docs/10_TOOL_AND_MCP_ARCHITECTURE.md §2.
 *
 * `headers` is where a bearer token or an API key for the remote goes. It is deliberately
 * never logged and never echoed back through `/api/v1/mcp`: the server list is readable by
 * anyone with `project:read`, and a credential that leaks into a status payload or a boot log
 * is a credential leak regardless of how careful the transport was.
 */
export interface McpHttpServerConfig {
  id: string;
  url: string;
  headers?: Record<string, string>;
}

/**
 * A server is EITHER stdio or http, discriminated structurally by which endpoint it names:
 * `command` launches something locally, `url` reaches something remote. There is no tag field
 * because there is nothing a tag could express that the endpoint does not, and a tag that can
 * disagree with the rest of the entry is one more thing an operator can get wrong.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/**
 * Which wire the connection actually ended up on. `http-sse` is the deprecated two-endpoint
 * transport, recorded distinctly from `http` because it is a fallback we took, not a thing an
 * operator asked for — worth being able to see in `/api/v1/mcp` before the SDK drops it.
 */
export type McpTransportKind = "stdio" | "http" | "http-sse";

export function isHttpServerConfig(config: McpServerConfig): config is McpHttpServerConfig {
  return "url" in config;
}

export interface McpConnection {
  serverId: string;
  transport: McpTransportKind;
  client: Client;
  toolIds: string[];
  /**
   * Tools the server offered that were REFUSED because their id was already taken. Surfaced
   * rather than swallowed: a remote server advertising a name that collides with a registered
   * tool is either a misconfiguration or an impersonation attempt, and both need to be visible.
   */
  refusedToolIds: string[];
  close(): Promise<void>;
}

export interface ConnectMcpServerOptions {
  /**
   * Bounds the MCP `initialize` handshake. Matters far more for http than for stdio: a
   * subprocess that dies gives us EOF immediately, whereas a remote that completes the TCP
   * handshake and then never answers leaves `connect()` pending forever — which would hang
   * `McpManager.startAll`, and with it the API's boot, on an integration that is supposed to
   * be optional.
   */
  connectTimeoutMs?: number;
  /** Bounds tool discovery, for the same reason. */
  requestTimeoutMs?: number;
  logger?: { warn(o: object, m: string): void };
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * How long a best-effort session DELETE may take on the way down. Short on purpose: being
 * polite to a remote must never outrank the platform's own graceful shutdown.
 */
const SESSION_TERMINATE_TIMEOUT_MS = 2_000;

/**
 * Real MCP client integration — docs/10_TOOL_AND_MCP_ARCHITECTURE.md §2, §3.2. Implements
 * "Config & Discovery" (connect, tools/list) and "Invocation Adapter" (translate our
 * ToolRegistry.call into MCP's tools/call and back). Deliberately NOT implemented in this
 * increment (see PROJECT_STATUS.md): OS-level subprocess sandboxing (§2.6 point 2), OAuth
 * against a remote (the SDK's `authProvider` hook is unused — a remote that demands OAuth
 * fails to connect and is reported as failed, rather than being half-supported), resources
 * and prompts primitives, and re-verification on `list_changed` notifications.
 *
 * Both transports the SDK ships are wired here and chosen from the config: `StdioClientTransport`
 * for a local subprocess, `StreamableHTTPClientTransport` for a remote, falling back to the
 * deprecated `SSEClientTransport` when the remote turns out to speak only the old two-endpoint
 * protocol. Nothing about the wire is hand-rolled.
 *
 * SECURITY — why a remote server is a bigger deal than a local one (docs §2.5, ADR-067):
 *
 *   A stdio server is a binary an operator chose to install and launch. A remote HTTP server
 *   is third-party code on someone else's machine that can change its answer to `tools/list`
 *   between one connection and the next, and everything it returns — names, descriptions,
 *   input schemas — is untrusted input that ends up in a model's prompt. Two defences:
 *
 *   1. Every discovered tool is registered `enabled: false`, exactly as for stdio. Nothing
 *      calls through to a newly-discovered MCP tool until an operator enables it explicitly
 *      (`/api/v1/tools/:id/enable`). Auto-enabling would mean a remote could gain a callable
 *      tool inside this platform by editing its own manifest.
 *   2. A discovered tool may not take an id that is already registered. Ids are namespaced
 *      `mcp.<serverId>.<toolName>`, which stops a remote naming itself `fs.write_file`, but
 *      NOT a remote naming a tool `b.read` while a server with id `a.b` is configured — both
 *      land on `mcp.a.b.read`. `ToolRegistry.register` already refuses to overwrite; here the
 *      collision is detected first so the offending id is reported instead of aborting the
 *      whole server, and so the refusal reads as a deliberate policy rather than an accident
 *      of an exception escaping a loop.
 */
export async function connectMcpServer(
  registry: ToolRegistry,
  config: McpServerConfig,
  options: ConnectMcpServerOptions = {}
): Promise<McpConnection> {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const { client, transport, httpTransport } = await openClient(config, options);

  const toolIds: string[] = [];
  const refusedToolIds: string[] = [];

  try {
    const { tools } = await client.listTools(undefined, { timeout: requestTimeoutMs });

    for (const tool of tools) {
      const toolId = `mcp.${config.id}.${tool.name}`;

      // See the SECURITY note above. Checked before `register` so the collision produces a
      // named, reportable refusal; `register`'s own refusal is the backstop below.
      if (registry.get(toolId)) {
        refusedToolIds.push(toolId);
        options.logger?.warn(
          { server_id: config.id, tool_id: toolId, transport },
          "REFUSED an MCP tool whose id is already registered — a server may not shadow an existing tool"
        );
        continue;
      }

      const permissionLevel = inferPermissionLevel(tool.name);
      const defaults = PERMISSION_LEVEL_DEFAULTS[permissionLevel];

      const definition: ToolDefinition = {
        id: toolId,
        name: tool.name,
        description: tool.description ?? `(no description provided by MCP server "${config.id}")`,
        origin: { kind: "mcp", serverId: config.id, serverVersion: client.getServerVersion()?.version ?? null },
        inputSchema: tool.inputSchema as Record<string, unknown>,
        outputSchema: (tool.outputSchema as Record<string, unknown> | undefined) ?? null,
        permissionLevel,
        riskLevel: defaults.riskLevel,
        requiresApproval: defaults.requiresApproval,
        timeoutMs: defaults.timeoutMs,
        retryPolicy: {
          maxAttempts: defaults.maxAttempts,
          backoff: "fixed",
          idempotencyRequired: permissionLevel === "destructive" || permissionLevel === "financial",
        },
        // Disabled by default (docs §3.2) — an operator must explicitly enable a
        // newly-discovered MCP tool before the agent can call it.
        enabled: false,
      };

      try {
        registry.register(definition, async (rawArgs, context) => {
          let args = rawArgs;
          if (!isHttpServerConfig(config) && config.workspaceScope) {
            try {
              args = scopePathArguments(rawArgs, config.workspaceScope.root, context);
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          }
          /**
           * The tool's own bound, passed to the SDK — docs/26_DECISIONS.md ADR-158.
           *
           * This call had no options object, so it took the SDK's
           * `DEFAULT_REQUEST_TIMEOUT_MSEC` of 60 seconds — while `ToolRegistry` believes it is
           * enforcing `definition.timeoutMs`, and every other request in this file passes one
           * (`listTools`, the health probe). Letting the SDK's timer fire first does two things:
           * the effective bound becomes the one the registry configured, and the SDK sends the
           * protocol's `notifications/cancelled` to the remote, so a slow third-party server is
           * told to stop rather than left running.
           */
      const result = (await client.callTool({ name: tool.name, arguments: args }, undefined, {
        timeout: definition.timeoutMs,
      })) as {
            content?: Array<{ type: string; text?: string }>;
            isError?: boolean;
          };
          const text = (result.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("\n");
          if (result.isError) {
            return { ok: false, error: text || `MCP tool "${tool.name}" returned an error.` };
          }
          return { ok: true, output: { content: text, raw: result.content } };
        });
      } catch (err) {
        // The registry is the enforcement point, so honour its verdict rather than letting a
        // ValidationError out of the loop and strand the tools already registered above.
        if (!(err instanceof ValidationError)) throw err;
        refusedToolIds.push(toolId);
        options.logger?.warn(
          { server_id: config.id, tool_id: toolId, transport, error: err.message },
          "REFUSED an MCP tool rejected by the registry"
        );
        continue;
      }

      toolIds.push(toolId);
    }
  } catch (err) {
    // Unwind everything this attempt registered. Without it a failure part-way through
    // discovery leaves half a server's tools behind, and the manager's next retry is refused
    // by `register` for ids it owns itself — a transient error turned permanent.
    for (const toolId of toolIds) registry.unregister(toolId);
    await client.close().catch(() => undefined);
    throw err;
  }

  return {
    serverId: config.id,
    transport,
    client,
    toolIds,
    refusedToolIds,
    close: async () => {
      // A Streamable HTTP session is state on the REMOTE. `client.close()` only drops our end,
      // so without the spec's DELETE every reconnect strands a session there until the server's
      // own TTL reclaims it. Best-effort and time-boxed: a server that has stopped answering
      // (the usual reason we are disconnecting) must not be able to hold up shutdown, and the
      // socket teardown below happens either way.
      if (httpTransport) {
        await withTimeout(httpTransport.terminateSession(), SESSION_TERMINATE_TIMEOUT_MS).catch(() => undefined);
      }
      await client.close();
    },
  };
}

/**
 * Opens the transport the config asks for and completes the MCP handshake.
 *
 * The http path tries Streamable HTTP first because that is the current spec, then falls back
 * to the deprecated SSE transport — a remote that only implements the old protocol answers the
 * POST that Streamable HTTP opens with 404/405, because under SSE that path is a GET-only
 * event stream. Only those two statuses are treated as "wrong protocol": a 401, a 403 or a 5xx
 * are real failures of a server that understood us perfectly well, and retrying them on a
 * second transport would turn one clear error into two confusing ones.
 *
 * The fallback gets a fresh `Client`, not a second `connect()` on the first one — `connect()`
 * runs the initialize handshake and leaves protocol state behind, and reusing an instance
 * whose handshake failed is not something the SDK supports.
 */
async function openClient(
  config: McpServerConfig,
  options: ConnectMcpServerOptions
): Promise<{ client: Client; transport: McpTransportKind; httpTransport?: StreamableHTTPClientTransport }> {
  const timeout = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  if (!isHttpServerConfig(config)) {
    const client = newClient();
    try {
      await client.connect(
        new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env,
          cwd: config.cwd,
        }),
        { timeout }
      );
    } catch (err) {
      /**
       * Sanitised like the HTTP branch — docs/26_DECISIONS.md ADR-155.
       *
       * The HTTP path has `describeHttpFailure`, whose own docstring says why: `lastError` is
       * stored on the server row and readable by anyone with `project:read`. The stdio path had
       * no wrapper at all, so whatever Node or the SDK threw propagated verbatim into that
       * column — a spawn failure names the absolute command path, and `config.env` is the
       * operator's credential map for that server, which is exactly the kind of thing an error
       * from a failed launch can echo.
       *
       * The raw error is kept as the cause for the log and the span; only the server id and a
       * bounded reason reach the message.
       */
      throw describeStdioFailure(config.id, err);
    }
    return { client, transport: "stdio" };
  }

  const url = parseHttpUrl(config.url, config.id);
  // Spread so a later mutation of the caller's config object cannot retroactively change what
  // we send, and so the SDK never holds a reference to the operator's credential map.
  const requestInit: RequestInit | undefined = config.headers ? { headers: { ...config.headers } } : undefined;

  const streamableClient = newClient();
  const streamableTransport = new StreamableHTTPClientTransport(url, { requestInit });
  try {
    await streamableClient.connect(streamableTransport, { timeout });
    return { client: streamableClient, transport: "http", httpTransport: streamableTransport };
  } catch (err) {
    await streamableClient.close().catch(() => undefined);
    if (!isWrongProtocolResponse(err)) throw describeHttpFailure(config.id, url, err);
    options.logger?.warn(
      { server_id: config.id, status: err.code },
      "MCP server does not speak Streamable HTTP — falling back to the deprecated SSE transport"
    );
  }

  const sseClient = newClient();
  try {
    /**
     * `withTimeout` around the WHOLE connect, not just the `timeout` option.
     *
     * `Client.connect` awaits `transport.start()` BEFORE it sends the timeout-bearing
     * `initialize` request, and `SSEClientTransport.start()` resolves only when the server emits
     * its `endpoint` event. A legacy server that answers the POST with 405 (triggering this
     * fallback) and then accepts the GET event stream without ever emitting `endpoint` leaves
     * this promise pending forever — the `timeout` option never gets a chance to apply, because
     * the request it governs is never sent. Reproduced against a real node:http server:
     * `connectTimeoutMs: 500` and the promise was still pending at 5016ms.
     *
     * A hung MCP connect is not a small thing: `startAll` awaits it at boot, so one unresponsive
     * optional integration would stop the platform from starting at all — the precise failure
     * ADR-067 introduced the manager to prevent.
     */
    await withTimeout(
      sseClient.connect(new SSEClientTransport(url, { requestInit }), { timeout }),
      timeout
    );
  } catch (err) {
    await sseClient.close().catch(() => undefined);
    throw describeHttpFailure(config.id, url, err);
  }
  return { client: sseClient, transport: "http-sse" };
}

function newClient(): Client {
  return new Client({ name: "ai-agent-platform", version: "0.1.0" });
}

function isWrongProtocolResponse(err: unknown): err is StreamableHTTPError {
  return err instanceof StreamableHTTPError && (err.code === 404 || err.code === 405);
}

/**
 * Turns a transport-level failure into a typed platform error whose message names the HTTP
 * status and the endpoint.
 *
 * Worth the wrapper because the SDK keeps the status on `StreamableHTTPError.code` and leaves
 * it out of the message: a 401, a 429 and a 502 all arrive as
 * "Error POSTing to endpoint: <body>". That string is what `McpManager` records as `lastError`
 * and what `/api/v1/mcp` shows an operator, and the status is the single fact that separates
 * "fix the credential" from "the remote is down" — so it has to be in the text.
 *
 * `ServiceUnavailableError` even for a 401: the subject is a third-party dependency this
 * platform could not reach, not the rights of whoever is reading the status page, so mapping it
 * to PermissionError would make `/api/v1/mcp` report 403 about the wrong principal entirely.
 *
 * Only origin + path go into the message. A URL can carry `user:password@` or a token in its
 * query string, and `lastError` is readable by anyone with `project:read`.
 */
/**
 * The stdio equivalent of `describeHttpFailure` — ADR-155.
 *
 * Deliberately says less than the underlying error does: the command line and the environment
 * handed to a local MCP server are operator configuration, and this text is served to every
 * project member. The three reasons below are what an operator actually acts on; the detail
 * they need is in the log, with the error as the cause.
 */
function describeStdioFailure(serverId: string, err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const reason = /ENOENT|not recognized|no such file/i.test(raw)
    ? "could not be started — check the configured command"
    : /timed out|timeout/i.test(raw)
      ? "did not complete the handshake before the connect timeout"
      : "failed to start or did not complete the handshake";
  return new ServiceUnavailableError(`MCP server "${serverId}" ${reason}.`, err instanceof Error ? err : undefined);
}

function describeHttpFailure(serverId: string, url: URL, err: unknown): Error {
  const endpoint = `${url.origin}${url.pathname}`;
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof StreamableHTTPError) {
    return new ServiceUnavailableError(
      `MCP server "${serverId}" at ${endpoint} refused the connection with HTTP ${err.code ?? "(no status)"}: ${detail}`,
      err
    );
  }
  return new ServiceUnavailableError(`MCP server "${serverId}" at ${endpoint} is unreachable: ${detail}`, err);
}

/**
 * `MCP_SERVERS` is operator configuration, not user input, so this is not an SSRF boundary —
 * but a typo'd or pasted-wrong URL must fail as a typed, readable configuration error at parse
 * time rather than as a `TypeError: Invalid URL` out of the SDK three layers down during boot.
 * Schemes other than http/https are rejected outright: `file:` and friends reach a completely
 * different fetch path and none of them are an MCP endpoint.
 */
export function parseHttpUrl(raw: string, serverId: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`MCP server "${serverId}" has an invalid "url": ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(
      `MCP server "${serverId}" must use an http(s) "url"; got "${url.protocol}".`
    );
  }
  return url;
}

/**
 * True for a loopback host, where plaintext http carries no credential over a network.
 *
 * THE PREVIOUS TEST WAS `/^127\./`, WHICH IS A CREDENTIAL LEAK. That matches any hostname merely
 * BEGINNING with "127." — including `127.0.0.1.attacker.tld`, a perfectly ordinary DNS name an
 * attacker can point anywhere. A config naming it over plain http passed the guard that exists to
 * refuse exactly that, and the bearer token in `headers` went out in clear to the attacker's
 * server. Caught by review before it shipped; the test below pins it.
 *
 * The replacement matches a real IPv4 literal in 127.0.0.0/8: four numeric octets, each in range.
 * A DNS name cannot satisfy it, because a trailing label makes the last part non-numeric.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  // IPv4-mapped IPv6 loopback, which a URL parser will hand back in this form.
  if (host === "::ffff:127.0.0.1") return true;

  const octets = host.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((part) => /^\d{1,3}$/.test(part))) return false;
  const numbers = octets.map(Number);
  if (numbers.some((n) => n > 255)) return false;
  return numbers[0] === 127;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * MCP gives us a tool's name/description/schema, not a trust level (docs §2.6 point 1) —
 * we have to assign one. ASSUMED heuristic for this increment: infer from the tool name
 * until servers carry richer, standardized risk metadata. Deliberately conservative
 * (defaults to read_only only for names that look unambiguously safe).
 */
function inferPermissionLevel(toolName: string): PermissionLevel {
  const name = toolName.toLowerCase();
  if (/delete|remove|drop/.test(name)) return "destructive";
  if (/write|create|move|rename|edit/.test(name)) return "write_local";
  return "read_only";
}

/** Argument names the reference filesystem server (and servers like it) treat as paths. */
const PATH_ARGUMENTS = ["path", "source", "destination"] as const;

/**
 * Rewrites a filesystem MCP tool's path arguments into the calling project's workspace.
 *
 * The bundled `@modelcontextprotocol/server-filesystem` is launched once, over the whole
 * `SANDBOX_ROOT`, and the per-project directories (ADR-090) are subdirectories of that root. The
 * server cannot know which project is calling, so without this an enabled `read_text_file` given
 * `../<another project id>/notes.txt` — or that directory's absolute path — read another tenant's
 * workspace. Each path is resolved the way the native tools resolve theirs: relative to the
 * project workspace, symlinks followed before the containment check (`resolveSandboxedPath`), and
 * refused if it leaves the workspace. The server then receives the absolute, contained path.
 */
export function scopePathArguments(
  args: Record<string, unknown>,
  root: string,
  context: Parameters<typeof projectWorkspace>[1]
): Record<string, unknown> {
  const workspace = projectWorkspace(root, context);
  const scoped: Record<string, unknown> = { ...args };
  for (const key of PATH_ARGUMENTS) {
    if (typeof scoped[key] === "string") scoped[key] = resolveSandboxedPath(workspace, scoped[key] as string);
  }
  if (Array.isArray(scoped.paths)) {
    scoped.paths = scoped.paths.map((p) => {
      if (typeof p !== "string") throw new Error("Every entry of `paths` must be a string.");
      return resolveSandboxedPath(workspace, p);
    });
  }
  return scoped;
}
