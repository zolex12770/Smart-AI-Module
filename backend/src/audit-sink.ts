import { auditLog, type DrizzleDb } from "@ai-platform/database";
import type { ToolCallAudit } from "@ai-platform/tools";
import { v4 as uuid } from "uuid";

/**
 * The one tool-call audit sink — docs/26_DECISIONS.md ADR-139, extracted by ADR-152.
 *
 * ADR-139 made every tool call write an `audit_log` row. The sink that does it lived inline in
 * the composition root, and the test harness had its own hand-written copy — which had drifted
 * in three ways: no truncation, no `serverId`, no `error`. The test named for this behaviour
 * therefore asserted the COPY's shape, so `truncateForAudit` was exercised by nothing at all
 * (`grep -rn truncateForAudit backend` returned two lines, both in `index.ts`).
 *
 * One factory, imported by both, so the harness cannot describe a sink the server does not have.
 */

/**
 * Arguments are recorded, but bounded — ADR-139.
 *
 * An audit trail that records only which tool ran cannot answer what it was asked to do, and a
 * `write_file` argument can be a whole file. The truncation is visible in the stored value
 * (`… (N characters)`) rather than silent, because a trail that quietly drops data is worse than
 * one that says it did.
 */
export function truncateForAudit(args: Record<string, unknown>): Record<string, unknown> {
  const LIMIT = 500;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > LIMIT) {
      out[key] = `${value.slice(0, LIMIT)}… (${value.length} characters)`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Fire-and-forget, with the rejection reported but swallowed: an audit write that fails must not
 * turn a successful tool call into a failed one, and the registry's own sink contract says the
 * same.
 */
export function createToolAuditSink(
  db: DrizzleDb,
  onError: (err: unknown, toolId: string) => void
): (entry: ToolCallAudit) => void {
  return (entry) => {
    void db
      .insert(auditLog)
      .values({
        id: uuid(),
        userId: entry.userId,
        projectId: entry.projectId,
        action: entry.serverId ? "tool.call.mcp" : "tool.call",
        resourceType: "tool",
        resourceId: entry.toolId,
        // The registry's outcomes are finer than these three, so the exact one is kept in
        // `detail` and this is the coarse verdict an auditor filters on.
        outcome: entry.ok ? "success" : entry.outcome === "disabled" ? "denied" : "failure",
        method: "system",
        ipAddress: null,
        requestId: null,
        detail: {
          outcome: entry.outcome,
          durationMs: entry.durationMs,
          ...(entry.serverId ? { serverId: entry.serverId } : {}),
          arguments: truncateForAudit(entry.arguments),
          ...(entry.error ? { error: entry.error.slice(0, 1_000) } : {}),
        },
        createdAt: new Date(),
      })
      .catch((error: unknown) => onError(error, entry.toolId));
  };
}
