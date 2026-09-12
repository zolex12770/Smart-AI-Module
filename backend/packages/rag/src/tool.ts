import type { ToolDefinition } from "@ai-platform/shared";
import { PERMISSION_LEVEL_DEFAULTS } from "@ai-platform/shared";
import type { ToolHandler } from "@ai-platform/tools";
import type { RetrieveDeps } from "./retrieve.js";
import { buildCitations, buildRagContext, searchDocuments } from "./retrieve.js";

export interface RagToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * Exposes retrieval as a normal tool, callable by the agent the same way native
 * filesystem/terminal tools are (docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3 — one uniform
 * interface regardless of origin).
 *
 * The tenant scope is the invocation context's `projectId` (ADR-049), never a tool argument:
 * a model that could name the project it searches could read another tenant's corpus by
 * guessing an id, and the whole point of putting scope in the context is that the model
 * cannot influence it. `maxDistance` is deliberately not an argument either — letting the
 * model widen the relevance threshold is letting it manufacture citations for a question the
 * corpus cannot answer. It is an operator knob on `RetrieveDeps` instead.
 */
export function createRagTools(deps: RetrieveDeps): RagToolEntry[] {
  const readOnly = PERMISSION_LEVEL_DEFAULTS.read_only;

  const searchTool: RagToolEntry = {
    definition: {
      id: "rag.search_documents",
      name: "Search Documents",
      description:
        "Searches this project's previously ingested documents for passages relevant to a " +
        "query, ranked by similarity. Use this before answering a question that might be " +
        "answered by an uploaded document, rather than guessing. Returns the matching " +
        "passages with a citation for each: the source document's id, filename and chunk " +
        "index. Cite them by their markers ([1], [2], ...) in your answer. An empty result " +
        "means nothing in the corpus was relevant enough to quote — say so rather than " +
        "answering from memory.",
      origin: { kind: "native", serverId: null, serverVersion: null },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          // Bounded now that the registry actually validates arguments against this schema
          // (ADR-059): before, an out-of-range topK from a model reached the SQL LIMIT.
          topK: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          results: { type: "array" },
          citations: { type: "array" },
          context: { type: "string" },
        },
      },
      permissionLevel: "read_only",
      riskLevel: readOnly.riskLevel,
      requiresApproval: readOnly.requiresApproval,
      timeoutMs: readOnly.timeoutMs,
      retryPolicy: { maxAttempts: readOnly.maxAttempts, backoff: "fixed", idempotencyRequired: false },
      enabled: true,
    },
    handler: async (args, context) => {
      // The registry validates against `inputSchema` before this runs, so these narrowings
      // are the type system catching up with a check that already happened — not a second,
      // laxer validation with different rules.
      const query = typeof args.query === "string" ? args.query : "";
      const topK = typeof args.topK === "number" ? args.topK : 5;

      const results = await searchDocuments(deps, { projectId: context.projectId, query, topK });
      return {
        ok: true,
        output: {
          results: results.map((r) => ({
            documentId: r.documentId,
            filename: r.filename,
            chunkIndex: r.chunkIndex,
            content: r.content,
            distance: r.distance,
          })),
          // The marker → source mapping, so `[1]` in the answer can be resolved back to a
          // real document by the UI and by any citation-verification pass (docs/09 §6).
          // Previously `[1]` was a bare positional label with nothing behind it.
          citations: buildCitations(results),
          // Pre-joined for direct template interpolation into a model prompt — see
          // packages/agent-core/src/template.ts's field-path-only limitation and
          // planner.ts's answer_from_documents task type.
          context: buildRagContext(results),
        },
      };
    },
  };

  return [searchTool];
}
