import { z } from "zod";

/** Tool registry types — implements docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3.1. */

export const toolOriginKindSchema = z.enum(["native", "mcp"]);

export const permissionLevelSchema = z.enum([
  "read_only",
  "write_local",
  "write_external",
  "destructive",
  "financial",
]);
export type PermissionLevel = z.infer<typeof permissionLevelSchema>;

export const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const requiresApprovalSchema = z.enum(["never", "first_use", "always", "risk_threshold"]);
export type RequiresApproval = z.infer<typeof requiresApprovalSchema>;

/** Default timeout/retry/approval by permission level — docs/10 §3.1 table. Tunable per deployment. */
export const PERMISSION_LEVEL_DEFAULTS: Record<
  PermissionLevel,
  { timeoutMs: number; maxAttempts: number; requiresApproval: RequiresApproval; riskLevel: RiskLevel }
> = {
  read_only: { timeoutMs: 30_000, maxAttempts: 3, requiresApproval: "never", riskLevel: "low" },
  write_local: { timeoutMs: 30_000, maxAttempts: 2, requiresApproval: "never", riskLevel: "medium" },
  write_external: { timeoutMs: 60_000, maxAttempts: 1, requiresApproval: "first_use", riskLevel: "high" },
  destructive: { timeoutMs: 60_000, maxAttempts: 1, requiresApproval: "always", riskLevel: "critical" },
  financial: { timeoutMs: 60_000, maxAttempts: 1, requiresApproval: "always", riskLevel: "critical" },
};

export const toolDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  origin: z.object({
    kind: toolOriginKindSchema,
    serverId: z.string().nullable(),
    serverVersion: z.string().nullable(),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  permissionLevel: permissionLevelSchema,
  riskLevel: riskLevelSchema,
  requiresApproval: requiresApprovalSchema,
  timeoutMs: z.number().int().positive(),
  retryPolicy: z.object({
    maxAttempts: z.number().int().min(1),
    backoff: z.enum(["none", "fixed", "exponential"]),
    idempotencyRequired: z.boolean(),
  }),
  enabled: z.boolean(),
});
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export interface ToolCallResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
}

export interface ToolHandler {
  (args: Record<string, unknown>): Promise<ToolCallResult>;
}
