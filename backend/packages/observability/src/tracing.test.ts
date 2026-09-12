import { resourceFromAttributes } from "@opentelemetry/resources";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTracer, withSpan } from "./tracing.js";

/**
 * Real span-nesting verification (docs/20_OBSERVABILITY.md §3) — uses its own
 * `InMemorySpanExporter`-backed provider (not `initTracing`'s console one) to assert that a
 * `tool.call` span created inside an `agent.step` span, itself inside an `agent.run` span,
 * actually ends up with the correct parent/child span ids — proving the async-context
 * propagation genuinely works across `await` boundaries, not just that the API compiles.
 *
 * The provider is registered exactly once in `beforeAll`, not per-test: found directly by a
 * failing test that `trace.setGlobalTracerProvider()` is idempotent — a *second* registration
 * is silently ignored (first-caller-wins, a real OTel API property, not a bug in this code),
 * so re-registering a fresh provider per test left `getTracer()` still bound to the first
 * test's exporter, and later tests' spans were "lost" from their own exporter's perspective.
 * Registering once and resetting the shared exporter between tests is the correct pattern.
 */
describe("tracing — real span parent/child nesting", () => {
  let exporter: InMemorySpanExporter;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "test" }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it("nests agent.step and tool.call spans correctly under agent.run, across real await boundaries", async () => {
    await withSpan("agent.run", { task_id: "t1" }, async () => {
      await new Promise((r) => setTimeout(r, 5)); // force a real async gap
      await withSpan("agent.step", { "agent.step.index": 0 }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        await withSpan("tool.call", { tool_name: "fs.read_file" }, async () => {
          await new Promise((r) => setTimeout(r, 5));
        });
      });
    });

    const spans = exporter.getFinishedSpans();
    const run = spans.find((s) => s.name === "agent.run")!;
    const step = spans.find((s) => s.name === "agent.step")!;
    const tool = spans.find((s) => s.name === "tool.call")!;

    expect(run).toBeDefined();
    expect(step).toBeDefined();
    expect(tool).toBeDefined();

    // Same trace throughout — this is the actual cross-span correlation property that matters.
    expect(step.spanContext().traceId).toBe(run.spanContext().traceId);
    expect(tool.spanContext().traceId).toBe(run.spanContext().traceId);

    // Real parent-child linkage, not just "same trace" — proves nesting survived the awaits.
    expect(step.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
  });

  it("records an exception and ERROR status when the wrapped function throws, but still ends the span", async () => {
    await expect(
      withSpan("agent.step", {}, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const spans = exporter.getFinishedSpans();
    const failed = spans.find((s) => s.name === "agent.step")!;
    expect(failed).toBeDefined(); // span.end() was still called despite the throw
    expect(failed.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(failed.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("getTracer returns a usable tracer instance", () => {
    const tracer = getTracer("custom-name");
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe("function");
  });
});
