import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PermissionLevel, ToolDefinition } from "@ai-platform/shared";
import { PERMISSION_LEVEL_DEFAULTS } from "@ai-platform/shared";
import type { ToolRegistry } from "@ai-platform/tools";

export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpConnection {
  serverId: string;
  client: Client;
  toolIds: string[];
  close(): Promise<void>;
}

/**
 * Real MCP client integration — docs/10_TOOL_AND_MCP_ARCHITECTURE.md §2, §3.2. Implements
 * "Config & Discovery" (connect, tools/list) and "Invocation Adapter" (translate our
 * ToolRegistry.call into MCP's tools/call and back). Deliberately NOT implemented in this
 * increment (see PROJECT_STATUS.md): OS-level subprocess sandboxing (§2.6 point 2),
 * reconnect-with-backoff, remote HTTP/OAuth transport, resources/prompts primitives,
 * and re-verification on `list_changed` notifications — this connects once at boot to a
 * local stdio server and registers what it finds.
 *
 * Security-relevant default (docs §3.2 "Config & Discovery"): every discovered tool is
 * registered with `enabled: false`. An MCP server's own tool descriptions are untrusted
 * input (tool-poisoning risk, docs §2.5) — nothing calls through to a newly-discovered
 * MCP tool until an operator explicitly enables it via `ToolRegistry` (see
 * apps/api/src/routes/v1/agent.ts `/api/v1/tools/:id/enable`).
 */
export async function connectMcpServer(
  registry: ToolRegistry,
  config: McpServerConfig
): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env,
    cwd: config.cwd,
  });

  const client = new Client({ name: "ai-agent-platform", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const toolIds: string[] = [];

  for (const tool of tools) {
    const toolId = `mcp.${config.id}.${tool.name}`;
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

    registry.register(definition, async (args) => {
      const result = (await client.callTool({ name: tool.name, arguments: args })) as {
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

    toolIds.push(toolId);
  }

  return {
    serverId: config.id,
    client,
    toolIds,
    close: () => client.close(),
  };
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
