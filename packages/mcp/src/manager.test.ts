import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@ai-platform/shared";
import { ToolRegistry } from "@ai-platform/tools";
import { McpManager, parseMcpServerConfigs } from "./manager.js";

/**
 * ADR-067. The audit's finding about MCP was not that it was broken but that it was
 * *unmanaged*: one hardcoded server, a connection that was never closed, no reconnection, no
 * health signal, and a planner that failed a whole task when the optional server was absent.
 *
 * `packages/mcp` also had no test script at all, so `npm test` skipped it silently — which is
 * how an untested security-relevant default (tools registered disabled) went unnoticed.
 *
 * These tests drive the manager against a stubbed connector rather than spawning real
 * subprocesses: what is under test is the lifecycle policy — retry, isolation of one server's
 * failure from another's, shutdown, health-driven takedown — not a transport. The transports
 * themselves are exercised end to end against real servers in http-transport.test.ts.
 *
 * Only `connectMcpServer` is stubbed; the rest of ./client.js is the real module, because
 * `parseMcpServerConfigs` validates http entries through the real URL rules and a blanket
 * module mock would replace those with `undefined`.
 */

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  connectMcpServer: vi.fn(),
}));

const { connectMcpServer } = await import("./client.js");
const mockConnect = connectMcpServer as unknown as ReturnType<typeof vi.fn>;

function fakeConnection(serverId: string, toolIds: string[], listTools = vi.fn().mockResolvedValue({ tools: [] })) {
  return {
    serverId,
    transport: "stdio" as const,
    toolIds,
    refusedToolIds: [],
    client: { listTools } as never,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** A minimal but valid registration, so the registry under test holds something real. */
function stubDefinition(id: string): ToolDefinition {
  return {
    id,
    name: id.split(".").pop() as string,
    description: "a tool that exists",
    origin: { kind: "mcp", serverId: "dying", serverVersion: null },
    inputSchema: { type: "object", properties: {} },
    outputSchema: null,
    permissionLevel: "read_only",
    riskLevel: "low",
    requiresApproval: "never",
    timeoutMs: 1_000,
    retryPolicy: { maxAttempts: 1, backoff: "none", idempotencyRequired: false },
    enabled: false,
  };
}

const noSleep = async () => undefined;

describe("McpManager", () => {
  it("connects several servers and reports each one's state", async () => {
    mockConnect.mockReset();
    mockConnect
      .mockResolvedValueOnce(fakeConnection("a", ["mcp.a.read"]))
      .mockResolvedValueOnce(fakeConnection("b", ["mcp.b.write", "mcp.b.list"]));

    const manager = new McpManager(new ToolRegistry(), { sleep: noSleep });
    const states = await manager.startAll([
      { id: "a", command: "node", args: ["a.js"] },
      { id: "b", command: "node", args: ["b.js"] },
    ]);

    expect(states.map((s) => [s.id, s.status, s.toolIds.length]).sort()).toEqual([
      ["a", "connected", 1],
      ["b", "connected", 2],
    ]);
    await manager.stopAll();
  });

  it("ISOLATES a failure: one server refusing to start does not stop the others", async () => {
    mockConnect.mockReset();
    mockConnect.mockImplementation(async (_registry: unknown, config: { id: string }) => {
      if (config.id === "broken") throw new Error("ENOENT: no such binary");
      return fakeConnection(config.id, [`mcp.${config.id}.read`]);
    });

    const manager = new McpManager(new ToolRegistry(), { sleep: noSleep, maxAttempts: 2 });
    const states = await manager.startAll([
      { id: "broken", command: "does-not-exist" },
      { id: "healthy", command: "node" },
    ]);

    const broken = states.find((s) => s.id === "broken")!;
    const healthy = states.find((s) => s.id === "healthy")!;
    expect(broken.status).toBe("failed");
    expect(broken.lastError).toMatch(/ENOENT/);
    // The whole point: the platform still has the working server.
    expect(healthy.status).toBe("connected");
    await manager.stopAll();
  });

  it("retries a flaky server and reports how many attempts it took", async () => {
    mockConnect.mockReset();
    mockConnect
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(fakeConnection("flaky", ["mcp.flaky.read"]));

    const manager = new McpManager(new ToolRegistry(), { sleep: noSleep, maxAttempts: 3 });
    const [state] = await manager.startAll([{ id: "flaky", command: "node" }]);

    expect(state.status).toBe("connected");
    expect(state.attempts).toBe(2);
    await manager.stopAll();
  });

  it("gives up after the configured attempts rather than retrying forever", async () => {
    mockConnect.mockReset();
    mockConnect.mockRejectedValue(new Error("always down"));

    const manager = new McpManager(new ToolRegistry(), { sleep: noSleep, maxAttempts: 3 });
    const [state] = await manager.startAll([{ id: "down", command: "node" }]);

    expect(state.status).toBe("failed");
    expect(state.attempts).toBe(3);
    expect(mockConnect).toHaveBeenCalledTimes(3);
  });

  it("closes every subprocess on shutdown — the connection used to just be dropped", async () => {
    mockConnect.mockReset();
    const a = fakeConnection("a", []);
    const b = fakeConnection("b", []);
    mockConnect.mockResolvedValueOnce(a).mockResolvedValueOnce(b);

    const manager = new McpManager(new ToolRegistry(), { sleep: noSleep });
    await manager.startAll([
      { id: "a", command: "node" },
      { id: "b", command: "node" },
    ]);
    await manager.stopAll();

    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
    expect(manager.status().every((s) => s.status === "disconnected")).toBe(true);
  });

  it("marks a server down and REMOVES its tools when it stops responding", async () => {
    mockConnect.mockReset();
    const listTools = vi.fn().mockRejectedValue(new Error("EPIPE"));
    mockConnect.mockResolvedValue(fakeConnection("dying", ["mcp.dying.read"], listTools));

    // A real registry holding a real registration, so the assertion is about the registry's
    // actual contents afterwards rather than about which methods the manager happened to call.
    const registry = new ToolRegistry();
    registry.register(stubDefinition("mcp.dying.read"), async () => ({ ok: true, output: {} }));
    registry.setEnabled("mcp.dying.read", true);

    const manager = new McpManager(registry, { sleep: noSleep, healthIntervalMs: 0 });
    await manager.startAll([{ id: "dying", command: "node" }]);
    await manager.checkHealth();

    expect(manager.status()[0].status).toBe("failed");
    // A dead server's tools must stop being offered, and a call must fail rather than reach a
    // handler holding a transport that is gone.
    expect(registry.get("mcp.dying.read")).toBeUndefined();
    expect(registry.toolSpecs().map((s) => s.name)).not.toContain("mcp.dying.read");
    const result = await registry.call("mcp.dying.read", {}, { projectId: "p", userId: "u" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });

  it("reconnects on operator request, replacing the old connection", async () => {
    mockConnect.mockReset();
    const first = fakeConnection("s", ["mcp.s.read"]);
    const second = fakeConnection("s", ["mcp.s.read", "mcp.s.write"]);
    mockConnect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const manager = new McpManager(new ToolRegistry(), { sleep: noSleep });
    await manager.startAll([{ id: "s", command: "node" }]);
    const state = await manager.reconnect("s");

    expect(first.close).toHaveBeenCalled();
    expect(state?.status).toBe("connected");
    expect(state?.toolIds).toHaveLength(2);
    await manager.stopAll();
  });

  it("returns null for a reconnect of a server that is not configured", async () => {
    const manager = new McpManager(new ToolRegistry(), { sleep: noSleep });
    expect(await manager.reconnect("nope")).toBeNull();
  });
});

describe("parseMcpServerConfigs", () => {
  it("parses a well-formed configuration", () => {
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([{ id: "fs", command: "node", args: ["server.js"], cwd: "/tmp" }])
    );
    expect(errors).toEqual([]);
    expect(configs).toEqual([{ id: "fs", command: "node", args: ["server.js"], env: undefined, cwd: "/tmp" }]);
  });

  it("treats no configuration as no servers, not as an error", () => {
    expect(parseMcpServerConfigs(undefined)).toEqual({ configs: [], errors: [] });
    expect(parseMcpServerConfigs("   ")).toEqual({ configs: [], errors: [] });
  });

  it("SKIPS a malformed entry rather than failing the whole boot", () => {
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([{ id: "good", command: "node" }, { command: "no-id" }, { id: "no-command" }])
    );
    expect(configs.map((c) => c.id)).toEqual(["good"]);
    expect(errors).toHaveLength(2);
  });

  it("rejects a duplicate id, which would otherwise silently shadow a server", () => {
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([{ id: "dup", command: "a" }, { id: "dup", command: "b" }])
    );
    expect(configs).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicate/);
  });

  it("reports invalid JSON as an error instead of throwing", () => {
    const { configs, errors } = parseMcpServerConfigs("{not json");
    expect(configs).toEqual([]);
    expect(errors[0]).toMatch(/not valid JSON/);
  });

  it("parses an http entry alongside a stdio one", () => {
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([
        { id: "fs", command: "node", args: ["server.js"] },
        { id: "docs", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } },
      ])
    );
    expect(errors).toEqual([]);
    expect(configs).toEqual([
      { id: "fs", command: "node", args: ["server.js"], env: undefined, cwd: undefined },
      { id: "docs", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } },
    ]);
  });

  it("REJECTS an entry that is both stdio and http rather than silently picking one", () => {
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([{ id: "both", command: "node", url: "https://mcp.example.com/mcp" }])
    );
    expect(configs).toEqual([]);
    expect(errors[0]).toMatch(/either stdio or http/);
  });

  it("SKIPS an http entry whose url is unusable rather than failing the boot", () => {
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([
        { id: "bad-url", url: "not a url" },
        { id: "wrong-scheme", url: "file:///etc/passwd" },
        { id: "ok", url: "https://mcp.example.com/mcp" },
      ])
    );
    expect(configs.map((c) => c.id)).toEqual(["ok"]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/invalid "url"/);
    expect(errors[1]).toMatch(/http\(s\)/);
  });

  it("REFUSES to send credentials over plaintext http to a remote host", () => {
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([{ id: "leaky", url: "http://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } }])
    );
    expect(configs).toEqual([]);
    expect(errors[0]).toMatch(/plaintext http/);
    // The message must name the server and the host, never the credential.
    expect(errors[0]).not.toMatch(/Bearer/);
  });

  it("allows plaintext http to loopback, where there is no network to intercept", () => {
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([{ id: "local", url: "http://127.0.0.1:9123/mcp", headers: { Authorization: "Bearer t" } }])
    );
    expect(errors).toEqual([]);
    expect(configs).toHaveLength(1);
  });

  it("rejects headers that are not a string map", () => {
    const { configs, errors } = parseMcpServerConfigs(
      JSON.stringify([
        { id: "a", url: "https://example.com/mcp", headers: ["Authorization: x"] },
        { id: "b", url: "https://example.com/mcp", headers: { "X-Count": 7 } },
      ])
    );
    expect(configs).toEqual([]);
    expect(errors[0]).toMatch(/not an object/);
    expect(errors[1]).toMatch(/non-string value for header "X-Count"/);
  });
});
