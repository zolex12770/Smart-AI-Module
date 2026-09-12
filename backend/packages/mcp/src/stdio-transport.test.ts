import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolRegistry } from "@ai-platform/tools";
import { McpManager } from "./manager.js";

/**
 * The stdio half of the transport work — a REAL MCP server in a REAL subprocess.
 *
 * Adding http moved code every stdio server also runs through: transport selection, the
 * connect/discovery timeouts, the partial-registration unwind, and above all `disconnect`,
 * which now REMOVES a server's tools instead of only disabling them. "Preserve the existing
 * behaviour exactly for stdio" is a claim, and this file is what makes it a checked one —
 * previously nothing in this package ever spawned a server, so the stdio path had no test at
 * all and a regression in it would have been invisible.
 *
 * The server is generated at run time rather than checked in because it must import the SDK by
 * absolute file URL: a script in the OS temp directory has no `node_modules` above it, so a
 * bare "@modelcontextprotocol/sdk/..." specifier would not resolve. Resolving here and writing
 * the resolved URLs into the script keeps it a real, independent process.
 */

const ECHO_SERVER = `
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};

const server = new Server({ name: "test-stdio-mcp", version: "8.8.8" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "echoes text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: "stdio echo: " + String(request.params.arguments?.text) }],
}));

await server.connect(new StdioServerTransport());
`;

const CONTEXT = { projectId: "project-1", userId: "user-1" };

let workdir: string;
let serverScript: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "mcp-stdio-"));
  serverScript = join(workdir, "echo-server.mjs");
  writeFileSync(serverScript, ECHO_SERVER, "utf8");
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function stdioConfig() {
  return { id: "local", command: process.execPath, args: [serverScript] };
}

describe("MCP over a real stdio subprocess", () => {
  it("still connects, discovers and registers DISABLED, and round-trips a real call", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(registry, { sleep: async () => undefined, healthIntervalMs: 0 });

    try {
      const [state] = await manager.startAll([stdioConfig()]);

      expect(state.status).toBe("connected");
      expect(state.transport).toBe("stdio");
      expect(state.toolIds).toEqual(["mcp.local.echo"]);
      expect(registry.get("mcp.local.echo")?.enabled).toBe(false);
      expect(registry.get("mcp.local.echo")?.origin).toEqual({
        kind: "mcp",
        serverId: "local",
        serverVersion: "8.8.8",
      });

      registry.setEnabled("mcp.local.echo", true);
      const result = await registry.call("mcp.local.echo", { text: "down a pipe" }, CONTEXT);
      expect(result.ok).toBe(true);
      expect(result.output?.content).toBe("stdio echo: down a pipe");

      // Health over a live pipe is a pass, not a false alarm from the new probe timeout.
      await manager.checkHealth();
      expect(manager.status()[0].status).toBe("connected");
    } finally {
      await manager.stopAll();
    }
  });

  it("reconnects and reclaims its tool ids, then gives them up again on shutdown", async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager(registry, { sleep: async () => undefined, healthIntervalMs: 0 });

    try {
      await manager.startAll([stdioConfig()]);
      const state = await manager.reconnect("local");

      expect(state?.status).toBe("connected");
      expect(state?.toolIds).toEqual(["mcp.local.echo"]);
      expect(registry.list()).toHaveLength(1);

      registry.setEnabled("mcp.local.echo", true);
      const result = await registry.call("mcp.local.echo", { text: "again" }, CONTEXT);
      expect(result.ok).toBe(true);
    } finally {
      await manager.stopAll();
    }

    // stopAll closes the subprocess AND takes the tools with it, so nothing is left pointing
    // at a pipe that no longer has a process on the other end.
    expect(registry.list()).toEqual([]);
    const afterShutdown = await registry.call("mcp.local.echo", { text: "x" }, CONTEXT);
    expect(afterShutdown.ok).toBe(false);
    expect(afterShutdown.error).toMatch(/Unknown tool/);
  });
});
