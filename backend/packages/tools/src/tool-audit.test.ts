import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolCallAudit } from "./registry.js";
import type { ToolDefinition, ToolInvocationContext } from "@ai-platform/shared";

/**
 * A durable record of every tool call — docs/26_DECISIONS.md ADR-139.
 *
 * The only record was an OpenTelemetry span and a Prometheus counter: sampled, aggregated, and
 * retained for as long as the telemetry backend happens to keep it.
 * docs/10_TOOL_AND_MCP_ARCHITECTURE.md requires a record of which server, which tool, what
 * arguments and what outcome — and for an MCP tool, whose handler is a third party's code, "what
 * arguments did that server receive on behalf of this tenant" is not a dashboard question. It is
 * asked after an incident, about one project, weeks later, and no counter can answer it.
 *
 * These assert the properties that make the trail worth having: every path is recorded including
 * the refusals, the arguments are there, an MCP call is distinguishable from a native one, and a
 * broken audit sink cannot break the tool call it was auditing.
 */
const ctx: ToolInvocationContext = { projectId: "p1", userId: "u1" } as ToolInvocationContext;

const definition = (over: Partial<ToolDefinition> = {}): ToolDefinition =>
  ({
    id: "test.tool",
    name: "Test tool",
    description: "A tool",
    origin: { kind: "native", serverId: null, serverVersion: null },
    inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    outputSchema: null,
    permissionLevel: "read_only",
    riskLevel: "low",
    requiresApproval: "never",
    timeoutMs: 5_000,
    retryPolicy: { maxAttempts: 1, backoff: "fixed", idempotencyRequired: false },
    enabled: true,
    ...over,
  }) as ToolDefinition;

function registryWithSink(over: Partial<ToolDefinition> = {}, handler?: () => Promise<unknown>) {
  const audits: ToolCallAudit[] = [];
  const registry = new ToolRegistry({ auditSink: (e) => audits.push(e) });
  registry.register(
    definition(over),
    (handler ?? (async () => ({ ok: true, output: { read: true } }))) as never
  );
  return { registry, audits };
}

describe("every tool call reaches the audit trail", () => {
  it("records a successful call with its arguments and duration", async () => {
    const { registry, audits } = registryWithSink();
    const result = await registry.call("test.tool", { path: "notes.txt" }, ctx);

    expect(result.ok).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      toolId: "test.tool",
      serverId: null,
      projectId: "p1",
      userId: "u1",
      outcome: "ok",
      ok: true,
    });
    // The arguments, which are the only thing that says what the tool was asked to DO.
    expect(audits[0]!.arguments).toEqual({ path: "notes.txt" });
    expect(audits[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records a call to a tool that is switched off", async () => {
    // "A model spent its whole iteration budget on a disabled tool" is exactly the thing an
    // audit trail should be able to show, and this path never reaches the handler.
    const { registry, audits } = registryWithSink({ enabled: false });
    const result = await registry.call("test.tool", { path: "notes.txt" }, ctx);

    expect(result.ok).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: "disabled", ok: false });
    expect(audits[0]!.error).toMatch(/disabled/i);
  });

  it("records a call to a tool that does not exist", async () => {
    const { registry, audits } = registryWithSink();
    const result = await registry.call("test.invented-by-the-model", {}, ctx);

    expect(result.ok).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ toolId: "test.invented-by-the-model", outcome: "unknown_tool", ok: false });
  });

  it("records a call rejected for bad arguments", async () => {
    const { registry, audits } = registryWithSink();
    const result = await registry.call("test.tool", { path: 42, nope: true }, ctx);

    expect(result.ok).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.outcome).toBe("invalid_arguments");
    // The rejected arguments are recorded: what was attempted is the point.
    expect(audits[0]!.arguments).toEqual({ path: 42, nope: true });
  });

  it("records a handler that failed, with its message", async () => {
    const { registry, audits } = registryWithSink({}, async () => {
      throw new Error("the disk is full");
    });
    const result = await registry.call("test.tool", { path: "notes.txt" }, ctx);

    expect(result.ok).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.outcome).toBe("error");
    expect(audits[0]!.error).toMatch(/disk is full/);
  });

  it("names the MCP server a tool came from, so a third party's call is distinguishable", async () => {
    // The case the requirement is really about: this handler is somebody else's code.
    const { registry, audits } = registryWithSink({
      id: "mcp.reference-filesystem.read_text_file",
      origin: { kind: "mcp", serverId: "reference-filesystem", serverVersion: "1.0.0" },
    } as Partial<ToolDefinition>);

    await registry.call("mcp.reference-filesystem.read_text_file", { path: "notes.txt" }, ctx);

    expect(audits).toHaveLength(1);
    expect(audits[0]!.serverId).toBe("reference-filesystem");
  });

  it("does not let a broken audit sink break the call it was auditing", async () => {
    // An audit write goes to a database, and a database can be down. A successful tool call must
    // not become a failed one because the record of it could not be stored.
    const registry = new ToolRegistry({
      auditSink: () => {
        throw new Error("audit table is unreachable");
      },
    });
    registry.register(definition(), (async () => ({ ok: true, output: { read: true } })) as never);

    const result = await registry.call("test.tool", { path: "notes.txt" }, ctx);
    expect(result.ok).toBe(true);
  });

  it("works with no sink configured at all", async () => {
    // Optional on purpose: a test that is about tool behaviour should not have to build a trail.
    const registry = new ToolRegistry();
    registry.register(definition(), (async () => ({ ok: true, output: {} })) as never);
    expect((await registry.call("test.tool", { path: "x" }, ctx)).ok).toBe(true);
  });

  it("records one row per call, not one per registration", async () => {
    const { registry, audits } = registryWithSink();
    await registry.call("test.tool", { path: "a" }, ctx);
    await registry.call("test.tool", { path: "b" }, ctx);
    expect(audits.map((a) => a.arguments.path)).toEqual(["a", "b"]);
  });

  it("carries the tenant on every row, including the refusals", async () => {
    // An audit row that cannot say whose call it was is useless for the question it exists for.
    const { registry, audits } = registryWithSink({ enabled: false });
    await registry.call("test.tool", { path: "a" }, { projectId: "p2", userId: "u2" } as ToolInvocationContext);
    expect(audits[0]).toMatchObject({ projectId: "p2", userId: "u2" });
  });

  it("still records when the invocation carries no user", async () => {
    // A job worker runs tools with no user attached; the row says null rather than inventing one.
    const { registry, audits } = registryWithSink();
    await registry.call("test.tool", { path: "a" }, { projectId: "p1" } as ToolInvocationContext);
    expect(audits[0]!.userId).toBeNull();
  });
});
