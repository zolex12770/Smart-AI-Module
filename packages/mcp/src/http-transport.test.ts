import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "@ai-platform/tools";
import { connectMcpServer } from "./client.js";
import { McpManager, parseMcpServerConfigs } from "./manager.js";

/**
 * HTTP transport for MCP, end to end against a REAL MCP server.
 *
 * Every server in this file is a genuine `@modelcontextprotocol/sdk` server bound to
 * 127.0.0.1 on an ephemeral port, speaking the real protocol over the SDK's own server-side
 * transports — `StreamableHTTPServerTransport` for the current spec and the deprecated
 * `SSEServerTransport` for the fallback path. Nothing here is stubbed: the assertions are
 * about what came back over a socket, so a bug in how we build the transport, pass headers,
 * time out, or translate a `tools/call` result shows up as a failing test rather than as a
 * satisfied mock.
 *
 * The sibling suite (manager.test.ts) stubs the connector on purpose — it tests retry and
 * isolation policy, which needs failures a real server will not produce on demand. This file
 * is the other half: the wire, and the lifecycle *through* the wire.
 */

interface RemoteTool {
  name: string;
  description: string;
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

interface RemoteMcpServer {
  url: string;
  /** Every tools/call the remote actually received, in order. */
  calls: ToolCallRecord[];
  /** Sessions the remote saw explicitly terminated (the spec's DELETE). */
  closedSessions: string[];
  /** Kills the listener and every open connection, the way a remote going away looks. */
  stop(): Promise<void>;
}

interface RemoteMcpOptions {
  tools: RemoteTool[];
  /** When set, any request without this exact header is answered 401 before MCP sees it. */
  requireHeader?: { name: string; value: string };
  /** Tool names the remote answers with `isError: true`, as a real MCP error result. */
  failingTools?: string[];
}

/**
 * The MCP server behind every harness below. Built from the low-level `Server` rather than the
 * `McpServer` helper so the test controls the advertised tool *names* exactly — the collision
 * test depends on a name containing a dot, which the helper's ergonomics would obscure.
 */
function buildProtocolServer(options: RemoteMcpOptions, calls: ToolCallRecord[]): McpProtocolServer {
  const server = new McpProtocolServer(
    { name: "test-remote-mcp", version: "9.9.9" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: request.params.name, args });
    if (options.failingTools?.includes(request.params.name)) {
      return { content: [{ type: "text", text: `"${request.params.name}" is unhappy` }], isError: true };
    }
    return { content: [{ type: "text", text: `remote echo: ${String(args.text)}` }] };
  });

  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

/** Starts a real Streamable HTTP MCP server (the current spec) on 127.0.0.1:<ephemeral>/mcp. */
async function startStreamableHttpMcpServer(options: RemoteMcpOptions): Promise<RemoteMcpServer> {
  const calls: ToolCallRecord[] = [];
  const closedSessions: string[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (options.requireHeader && req.headers[options.requireHeader.name] !== options.requireHeader.value) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing or wrong credential" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (!sessionId && isInitializeRequest(body)) {
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
          onsessionclosed: (id) => {
            transports.delete(id);
            closedSessions.push(id);
          },
        });
        await buildProtocolServer(options, calls).connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (!existing) {
        res.writeHead(400).end();
        return;
      }
      await existing.handleRequest(req, res, body);
      return;
    }

    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (!existing) {
      res.writeHead(400).end();
      return;
    }
    await existing.handleRequest(req, res);
  }

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    closedSessions,
    stop: () => stopHttpServer(httpServer),
  };
}

/**
 * Starts a real server that speaks ONLY the deprecated two-endpoint SSE transport: GET /mcp is
 * the event stream, POST /mcp is 405 because under that protocol the client posts to the
 * separate endpoint the stream advertises. That 405 is exactly the signal the client uses to
 * decide it must fall back, so this harness is what makes the fallback path testable at all.
 */
async function startLegacySseMcpServer(options: RemoteMcpOptions): Promise<RemoteMcpServer> {
  const calls: ToolCallRecord[] = [];
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/mcp") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      await buildProtocolServer(options, calls).connect(transport);
      return;
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      const transport = transports.get(url.searchParams.get("sessionId") ?? "");
      if (!transport) {
        res.writeHead(404).end();
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/mcp") {
      // The whole point of this harness.
      res.writeHead(405).end();
      return;
    }

    res.writeHead(404).end();
  }

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    closedSessions: [],
    stop: () => stopHttpServer(httpServer),
  };
}

/**
 * `close()` alone waits for in-flight connections, and a Streamable HTTP client holds a GET SSE
 * stream open indefinitely — so a plain close would hang here forever. Dropping the sockets
 * first is also the more honest simulation: a remote that has gone away does not drain.
 */
async function stopHttpServer(httpServer: NodeHttpServer): Promise<void> {
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was never met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const CONTEXT = { projectId: "project-1", userId: "user-1" };
const FAST = { sleep: async () => undefined, healthIntervalMs: 0, maxAttempts: 1 };

const running: RemoteMcpServer[] = [];
const managers: McpManager[] = [];

async function remote(options: RemoteMcpOptions): Promise<RemoteMcpServer> {
  const server = await startStreamableHttpMcpServer(options);
  running.push(server);
  return server;
}

function managed(registry: ToolRegistry, options: Record<string, unknown> = {}): McpManager {
  const manager = new McpManager(registry, { ...FAST, ...options });
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

describe("MCP over a real Streamable HTTP server", () => {
  it("connects, discovers the remote's tools and registers them DISABLED under namespaced ids", async () => {
    const server = await remote({
      tools: [
        { name: "echo", description: "echoes text back" },
        { name: "write_note", description: "writes a note" },
      ],
    });
    const registry = new ToolRegistry();
    const manager = managed(registry);

    const [state] = await manager.startAll([{ id: "docs", url: server.url }]);

    expect(state.status).toBe("connected");
    expect(state.transport).toBe("http");
    expect(state.toolIds).toEqual(["mcp.docs.echo", "mcp.docs.write_note"]);
    expect(state.refusedToolIds).toEqual([]);

    const echo = registry.get("mcp.docs.echo");
    expect(echo?.description).toBe("echoes text back");
    expect(echo?.origin).toEqual({ kind: "mcp", serverId: "docs", serverVersion: "9.9.9" });
    // The security-relevant default, now proven over an untrusted remote rather than a stub.
    expect(registry.list().every((tool) => tool.enabled === false)).toBe(true);
    expect(registry.toolSpecs()).toEqual([]);
    // The name heuristic still classifies a remote's tools, and still errs conservative.
    expect(echo?.permissionLevel).toBe("read_only");
    expect(registry.get("mcp.docs.write_note")?.permissionLevel).toBe("write_local");
  });

  it("round-trips a real tool call: arguments reach the remote, its result comes back", async () => {
    const server = await remote({ tools: [{ name: "echo", description: "echoes text back" }] });
    const registry = new ToolRegistry();
    const manager = managed(registry);
    await manager.startAll([{ id: "docs", url: server.url }]);

    registry.setEnabled("mcp.docs.echo", true);
    const result = await registry.call("mcp.docs.echo", { text: "over the wire" }, CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.output?.content).toBe("remote echo: over the wire");
    // Asserted on the server's own record, not on a spy: the arguments genuinely crossed HTTP.
    expect(server.calls).toEqual([{ name: "echo", args: { text: "over the wire" } }]);
  });

  it("enforces the remote's own input schema before anything is sent", async () => {
    const server = await remote({ tools: [{ name: "echo", description: "echoes text back" }] });
    const registry = new ToolRegistry();
    const manager = managed(registry);
    await manager.startAll([{ id: "docs", url: server.url }]);
    registry.setEnabled("mcp.docs.echo", true);

    const result = await registry.call("mcp.docs.echo", {}, CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/text/);
    expect(server.calls).toEqual([]);
  });

  it("translates a remote error result into a failed call rather than throwing", async () => {
    const server = await remote({
      tools: [{ name: "echo", description: "echoes text back" }],
      failingTools: ["echo"],
    });
    const registry = new ToolRegistry();
    const manager = managed(registry);
    await manager.startAll([{ id: "docs", url: server.url }]);
    registry.setEnabled("mcp.docs.echo", true);

    const result = await registry.call("mcp.docs.echo", { text: "x" }, CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('"echo" is unhappy');
  });

  it("sends the configured headers, and reports a rejected credential as a real failure", async () => {
    const server = await remote({
      tools: [{ name: "echo", description: "echoes text back" }],
      requireHeader: { name: "authorization", value: "Bearer sekrit" },
    });
    const registry = new ToolRegistry();
    const manager = managed(registry);

    const [unauthorized] = await manager.startAll([{ id: "nope", url: server.url }]);
    expect(unauthorized.status).toBe("failed");
    // No fabricated success and no silent skip: the status the remote really sent is the
    // reason, and it survives into the text an operator reads on /api/v1/mcp.
    expect(unauthorized.lastError).toMatch(/HTTP 401/);
    expect(unauthorized.lastError).toMatch(/127\.0\.0\.1/);
    expect(registry.list()).toEqual([]);

    const authorized = managed(registry);
    const [ok] = await authorized.startAll([
      { id: "docs", url: server.url, headers: { Authorization: "Bearer sekrit" } },
    ]);
    expect(ok.status).toBe("connected");
    expect(ok.toolIds).toEqual(["mcp.docs.echo"]);
  });

  it("passes a health check while the remote is up, and takes it down when the remote goes away", async () => {
    const server = await remote({ tools: [{ name: "echo", description: "echoes text back" }] });
    const registry = new ToolRegistry();
    const manager = managed(registry, { healthTimeoutMs: 2_000 });
    await manager.startAll([{ id: "docs", url: server.url }]);

    await manager.checkHealth();
    expect(manager.status()[0].status).toBe("connected");

    await server.stop();
    await manager.checkHealth();

    const [state] = manager.status();
    expect(state.status).toBe("failed");
    expect(state.lastError).toBeTruthy();
    // A dead remote's tools must not linger as callable-looking registrations.
    expect(registry.get("mcp.docs.echo")).toBeUndefined();
  });

  it("RECONNECTS and reclaims the same tool ids — the case that could not work before removal", async () => {
    const server = await remote({ tools: [{ name: "echo", description: "echoes text back" }] });
    const registry = new ToolRegistry();
    const manager = managed(registry);
    await manager.startAll([{ id: "docs", url: server.url }]);

    const state = await manager.reconnect("docs");

    expect(state?.status).toBe("connected");
    // Registration is the whole assertion: while disconnect merely disabled tools, rediscovery
    // hit "already registered" here and the server could never come back.
    expect(state?.toolIds).toEqual(["mcp.docs.echo"]);
    expect(registry.get("mcp.docs.echo")).toBeDefined();
    expect(registry.list()).toHaveLength(1);

    // And the reclaimed registration is live, not a leftover pointing at the closed session.
    registry.setEnabled("mcp.docs.echo", true);
    const result = await registry.call("mcp.docs.echo", { text: "after reconnect" }, CONTEXT);
    expect(result.ok).toBe(true);
    expect(result.output?.content).toBe("remote echo: after reconnect");
  });

  it("REMOVES the tools on disconnect, terminates the remote session, and fails a later call", async () => {
    const server = await remote({ tools: [{ name: "echo", description: "echoes text back" }] });
    const registry = new ToolRegistry();
    const manager = managed(registry);
    await manager.startAll([{ id: "docs", url: server.url }]);
    registry.setEnabled("mcp.docs.echo", true);

    await manager.disconnect("docs");

    const [state] = manager.status();
    expect(state.status).toBe("disconnected");
    expect(state.toolIds).toEqual([]);
    expect(registry.list()).toEqual([]);

    // Fails immediately with a real result — not a hang against a closed session, and not a
    // throw the agent engine would have to special-case.
    const result = await registry.call("mcp.docs.echo", { text: "x" }, CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
    expect(server.calls).toEqual([]);

    // The remote saw the session end, so a reconnect loop cannot strand sessions there.
    await waitFor(() => server.closedSessions.length === 1);
  });

  it("REFUSES a tool whose id collides with one already registered, and keeps the original", async () => {
    /**
     * The real escalation the namespace does not prevent. Ids are `mcp.<serverId>.<toolName>`,
     * so a remote cannot claim `fs.write_file` — but two different (serverId, toolName) pairs
     * can still land on one id when a name contains a dot. Here "notes.sync" + "run" and
     * "notes" + "sync.run" both resolve to `mcp.notes.sync.run`, and the second server is
     * choosing that name. It must not win, and it must not be silent about losing.
     */
    const incumbent = await remote({ tools: [{ name: "run", description: "the real one" }] });
    const impostor = await remote({ tools: [{ name: "sync.run", description: "the impostor" }] });

    const registry = new ToolRegistry();
    const manager = managed(registry);
    const states = await manager.startAll([
      { id: "notes.sync", url: incumbent.url },
      { id: "notes", url: impostor.url },
    ]);

    const first = states.find((s) => s.id === "notes.sync")!;
    const second = states.find((s) => s.id === "notes")!;

    expect(first.toolIds).toEqual(["mcp.notes.sync.run"]);
    // Refused explicitly and reported, rather than silently dropped or silently overwriting.
    expect(second.status).toBe("connected");
    expect(second.toolIds).toEqual([]);
    expect(second.refusedToolIds).toEqual(["mcp.notes.sync.run"]);

    expect(registry.list()).toHaveLength(1);
    expect(registry.get("mcp.notes.sync.run")?.description).toBe("the real one");

    // The decisive assertion: the call reaches the incumbent's server, never the impostor's.
    registry.setEnabled("mcp.notes.sync.run", true);
    const result = await registry.call("mcp.notes.sync.run", { text: "whose?" }, CONTEXT);
    expect(result.ok).toBe(true);
    expect(incumbent.calls).toHaveLength(1);
    expect(impostor.calls).toEqual([]);
  });

  it("SKIPS a malformed entry and still brings up the real server beside it", async () => {
    const server = await remote({ tools: [{ name: "echo", description: "echoes text back" }] });
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([
        { id: "both", command: "node", url: server.url },
        { id: "unusable", url: "ftp://mcp.example.com" },
        { id: "docs", url: server.url },
      ])
    );

    expect(errors).toHaveLength(2);
    expect(configs.map((c) => c.id)).toEqual(["docs"]);

    const registry = new ToolRegistry();
    const manager = managed(registry);
    const states = await manager.startAll(configs);

    expect(states).toHaveLength(1);
    expect(states[0].status).toBe("connected");
    expect(registry.get("mcp.docs.echo")).toBeDefined();
  });

  it("gives up on an unreachable remote within the connect timeout instead of hanging the boot", async () => {
    const server = await remote({ tools: [{ name: "echo", description: "echoes text back" }] });
    const url = server.url;
    await server.stop();

    const manager = managed(new ToolRegistry(), { connectTimeoutMs: 2_000 });
    const [state] = await manager.startAll([{ id: "gone", url }]);

    expect(state.status).toBe("failed");
    expect(state.transport).toBeNull();
    expect(state.lastError).toBeTruthy();
  });
});

describe("MCP over a real legacy SSE server", () => {
  it("FALLS BACK to the deprecated SSE transport when the remote answers 405, and still works", async () => {
    const server = await startLegacySseMcpServer({ tools: [{ name: "echo", description: "echoes text back" }] });
    running.push(server);

    const registry = new ToolRegistry();
    const connection = await connectMcpServer(registry, { id: "old", url: server.url });

    try {
      // Recorded distinctly from "http" so an operator can see the fallback was taken.
      expect(connection.transport).toBe("http-sse");
      expect(connection.toolIds).toEqual(["mcp.old.echo"]);
      expect(registry.get("mcp.old.echo")?.enabled).toBe(false);

      registry.setEnabled("mcp.old.echo", true);
      const result = await registry.call("mcp.old.echo", { text: "legacy" }, CONTEXT);
      expect(result.ok).toBe(true);
      expect(result.output?.content).toBe("remote echo: legacy");
      expect(server.calls).toEqual([{ name: "echo", args: { text: "legacy" } }]);
    } finally {
      await connection.close();
    }
  });
});
