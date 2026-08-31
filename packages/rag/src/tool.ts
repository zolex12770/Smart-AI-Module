import type { ToolDefinition, ToolHandler } from "@ai-platform/shared";
import { PERMISSION_LEVEL_DEFAULTS } from "@ai-platform/shared";
import type { RetrieveDeps } from "./retrieve.js";
import { searchDocuments } from "./retrieve.js";

export interface RagToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/** Exposes retrieval as a normal tool, callable by the agent the same way native
 * filesystem/terminal tools are (docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3 — one uniform
 * interface regardless of origin). */
export function createRagTools(deps: RetrieveDeps): RagToolEntry[] {
  const readOnly = PERMISSION_LEVEL_DEFAULTS.read_only;

  const searchTool: RagToolEntry = {
    definition: {
      id: "rag.search_documents",
      name: "Search Documents",
      description:
        "Searches previously ingested documents for chunks relevant to a query, ranked " +
        "by similarity. Use this before answering a question that might be answered by " +
        "an uploaded document, rather than guessing. Returns the top matching chunks " +
        "with their source document id.",
      origin: { kind: "native", serverId: null, serverVersion: null },
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, topK: { type: "number" } },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { results: { type: "array" }, context: { type: "string" } },
      },
      permissionLevel: "read_only",
      riskLevel: readOnly.riskLevel,
      requiresApproval: readOnly.requiresApproval,
      timeoutMs: readOnly.timeoutMs,
      retryPolicy: { maxAttempts: readOnly.maxAttempts, backoff: "fixed", idempotencyRequired: false },
      enabled: true,
    },
    handler: async (args) => {
      const query = String(args.query ?? "");
      const topK = typeof args.topK === "number" ? args.topK : 5;
      const matches = await searchDocuments(deps, query, topK);
      return {
        ok: true,
        output: {
          results: matches.map((m) => ({
            documentId: m.documentId,
            chunkIndex: m.chunkIndex,
            content: m.content,
            distance: m.distance,
          })),
          // Pre-joined for direct template interpolation into a model prompt — see
          // packages/agent-core/src/template.ts's field-path-only limitation and
          // planner.ts's answer_from_documents task type.
          context: matches.map((m, i) => `[${i + 1}] ${m.content}`).join("\n\n"),
        },
      };
    },
  };

  return [searchTool];
}
