import { ValidationError } from "./errors.js";
import { z } from "zod";

/** Tool registry types — implements docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3.1. */

export const toolOriginKindSchema = z.enum(["native", "mcp"]);

export const permissionLevelSchema = z.enum([
  "read_only",
  /**
   * Reads something OUTSIDE the deployment — ADR-104.
   *
   * Distinct from `read_only`, which reads the sandbox. A tool that can reach the network can
   * reach the network the deployment is on, and describing that as read-only would understate it
   * in the one place an operator looks. It is not `write_external` either: a GET writes nothing,
   * and forcing first-use approval on reading a documentation page would make the capability
   * unusable for the thing it exists for.
   */
  "network",
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
  // A fetch is bounded by its own timeout; 3 attempts because a transient DNS or TLS failure is
  // the common case and a GET is idempotent.
  network: { timeoutMs: 20_000, maxAttempts: 3, requiresApproval: "never", riskLevel: "medium" },
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

/**
 * Everything a tool handler may need about *who* is calling and under what constraints —
 * ADR-059. Before this, handlers received only their arguments, which is why nothing they
 * did could be scoped to a tenant or cancelled.
 */
export interface ToolInvocationContext {
  projectId: string;
  userId: string;
  /** Per-run workspace; the coding agent's tools resolve paths against this. */
  workspaceRoot?: string;
  signal?: AbortSignal;
}

export interface ToolHandler {
  (args: Record<string, unknown>, context: ToolInvocationContext): Promise<ToolCallResult>;
}

/**
 * Validates a model's tool arguments against the tool's declared JSON Schema before anything
 * executes — closing the "inputSchema is decorative" finding from the ADR-047 audit.
 *
 * Deliberately a small, dependency-free subset (type, required, enum, minimum/maximum,
 * additionalProperties, nested objects and arrays) rather than a full JSON Schema engine:
 * these are the constructs the platform's own tool definitions actually use, and a model's
 * mistake should produce a precise message it can act on, which a generic validator's error
 * strings do not.
 */
export function validateToolArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
  path = "arguments"
): void {
  const type = schema.type as string | undefined;
  if (type && type !== "object") {
    throw new ValidationError(`${path}: tool input schema must describe an object, got "${type}".`);
  }
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      throw new ValidationError(`${path}.${key} is required but was not provided.`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) {
        throw new ValidationError(`${path}.${key} is not a recognised parameter for this tool.`);
      }
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec || value === undefined || value === null) continue;
    validateValue(spec, value, `${path}.${key}`);
  }
}

function validateValue(spec: Record<string, unknown>, value: unknown, path: string): void {
  const expected = spec.type as string | undefined;
  if (expected) {
    const actual = Array.isArray(value) ? "array" : typeof value;
    const matches =
      expected === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : expected === "number"
          ? typeof value === "number"
          : expected === actual;
    if (!matches) {
      throw new ValidationError(`${path} must be of type "${expected}" but received ${actual}.`);
    }
  }
  if (Array.isArray(spec.enum) && !(spec.enum as unknown[]).includes(value)) {
    throw new ValidationError(`${path} must be one of: ${(spec.enum as unknown[]).join(", ")}.`);
  }
  if (typeof value === "number") {
    if (typeof spec.minimum === "number" && value < spec.minimum) {
      throw new ValidationError(`${path} must be >= ${spec.minimum}.`);
    }
    if (typeof spec.maximum === "number" && value > spec.maximum) {
      throw new ValidationError(`${path} must be <= ${spec.maximum}.`);
    }
  }
  if (typeof value === "string" && typeof spec.maxLength === "number" && value.length > spec.maxLength) {
    throw new ValidationError(`${path} must be at most ${spec.maxLength} characters.`);
  }
  if (expected === "object" && spec.properties) {
    validateToolArguments(spec, value as Record<string, unknown>, path);
  }
  if (expected === "array" && spec.items) {
    for (let i = 0; i < (value as unknown[]).length; i++) {
      validateValue(spec.items as Record<string, unknown>, (value as unknown[])[i], `${path}[${i}]`);
    }
  }
}
