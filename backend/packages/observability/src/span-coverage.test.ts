import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "./logger.js";
import { currentTraceContext, withSpan } from "./tracing.js";

/**
 * docs/26_DECISIONS.md ADR-073 — proof that the spans nest, rather than a claim that they do.
 *
 * `tracing.ts` used to assert in its own docstring that "every span this platform actually
 * needs (agent.run, agent.step, tool.call, gen_ai.chat, job processing) is created explicitly
 * at the point that matters". Only two of those existed. The claim was checkable and nobody
 * had checked it, which is the failure mode this file exists to prevent: an exporter that
 * records what was really emitted, asserted on.
 *
 * Nesting is the property under test, not span count. A flat pile of spans is nearly useless —
 * the operational question is "this agent run was slow, WHERE did it spend its time", and only
 * a parent/child tree answers that. Nesting here depends on the AsyncLocalStorage context
 * manager surviving every `await` in between, which no type checks and only a run can show.
 */
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

/** Maps each recorded span to its parent's NAME, which is what makes an assertion readable. */
function parentageOf(): Record<string, string | null> {
  const spans = exporter.getFinishedSpans();
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s.name]));
  const out: Record<string, string | null> = {};
  for (const span of spans) {
    const parentId = span.parentSpanContext?.spanId;
    out[span.name] = parentId ? (byId.get(parentId) ?? null) : null;
  }
  return out;
}

describe("span nesting", () => {
  it("nests a tool call inside an agent step inside an agent run", async () => {
    // The exact shape backend produces for an agent task: engine.createAndStart opens
    // `agent.run`, executeNode opens `agent.step`, and ToolRegistry.call opens `tool.call`.
    await withSpan("agent.run", { task_id: "t1" }, async () =>
      withSpan("agent.step", { node_id: "n1" }, async () =>
        withSpan("tool.call", { "tool.id": "fs.read" }, async () => "done")
      )
    );

    expect(parentageOf()).toEqual({
      "tool.call": "agent.step",
      "agent.step": "agent.run",
      "agent.run": null,
    });
  });

  it("keeps every span in one trace", async () => {
    await withSpan("agent.run", {}, async () =>
      withSpan("agent.step", {}, async () => withSpan("gen_ai.chat", {}, async () => "ok"))
    );

    const traceIds = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId));
    // Three trace ids would mean three unrelated traces in the UI, and the run would be
    // impossible to reconstruct — the failure mode of losing the async context.
    expect(traceIds.size).toBe(1);
  });

  it("survives real asynchrony between parent and child", async () => {
    // Context propagation through AsyncLocalStorage is the whole mechanism; a synchronous test
    // would pass even if it were broken.
    await withSpan("agent.run", {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await withSpan("agent.step", {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    });

    expect(parentageOf()["agent.step"]).toBe("agent.run");
  });

  it("keeps sibling steps as siblings, not a chain", async () => {
    await withSpan("agent.run", {}, async () => {
      await withSpan("agent.step", { node_id: "a" }, async () => undefined);
      await withSpan("agent.step", { node_id: "b" }, async () => undefined);
    });

    const steps = exporter.getFinishedSpans().filter((s) => s.name === "agent.step");
    expect(steps).toHaveLength(2);
    // Both under the run: a chain would misreport the second step's duration as containing the
    // first, and would make a parallel plan look sequential.
    const run = exporter.getFinishedSpans().find((s) => s.name === "agent.run")!;
    for (const step of steps) {
      expect(step.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    }
  });

  it("records the failure on the span that failed, not on its parent", async () => {
    await withSpan("agent.run", {}, async () =>
      withSpan("agent.step", {}, async () => {
        throw new Error("provider refused");
      })
    ).catch(() => undefined);

    const spans = Object.fromEntries(exporter.getFinishedSpans().map((s) => [s.name, s]));
    expect(spans["agent.step"].status.code).toBe(2); // ERROR
    expect(spans["agent.step"].status.message).toContain("provider refused");
    // The run failed too — it propagated — but the useful diagnosis is which STEP did.
    expect(spans["agent.step"].events.some((e) => e.name === "exception")).toBe(true);
  });

  it("carries the project on every span, so a trace can be attributed and scoped", async () => {
    await withSpan("agent.run", { project_id: "p1" }, async () =>
      withSpan("tool.call", { project_id: "p1", "tool.id": "fs.read" }, async () => undefined)
    );

    for (const span of exporter.getFinishedSpans()) {
      // ADR-049: a trace that cannot say whose it is serves neither cost attribution nor
      // incident scoping.
      expect(span.attributes.project_id).toBe("p1");
    }
  });

  it("exposes the active trace id for log correlation", async () => {
    let seen: { traceId: string; spanId: string } | undefined;
    await withSpan("agent.run", {}, async () => {
      seen = currentTraceContext();
    });

    const run = exporter.getFinishedSpans().find((s) => s.name === "agent.run")!;
    // This is what puts a trace id on a log line; if it drifted from the real span the two
    // would be uncorrelatable and every "find the logs for this trace" search would come up
    // empty.
    expect(seen?.traceId).toBe(run.spanContext().traceId);
    expect(seen?.spanId).toBe(run.spanContext().spanId);
  });

  it("reports no trace context outside a span rather than inventing one", () => {
    expect(context.active()).toBeDefined();
    expect(trace.getActiveSpan()).toBeUndefined();
    expect(currentTraceContext()).toBeUndefined();
  });
});

/**
 * A log line written inside a span carries that span's ids — docs/26_DECISIONS.md ADR-155.
 *
 * `currentTraceContext` had no production caller at all: a repo-wide grep returned its own
 * definition and two uses inside this file. docs/20's `trace_id` correlation was therefore a
 * field name that appeared in no log line anywhere, so an operator holding a trace had no way to
 * find its logs — which is the whole reason for emitting both.
 */
describe("logs carry the active trace", () => {
  function captureLog(fn: (log: ReturnType<typeof createLogger>) => void | Promise<void>): Promise<string> {
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    return Promise.resolve(fn(createLogger("trace-test", sink))).then(() => output);
  }

  it("includes trace_id and span_id for a line written inside a span", async () => {
    const output = await captureLog(async (log) => {
      await withSpan("unit.under.test", {}, async () => {
        log.info({ project_id: "p1" }, "inside a span");
      });
    });

    const line = JSON.parse(output.trim().split("\n").pop()!) as Record<string, unknown>;
    expect(line.msg).toBe("inside a span");
    expect(String(line.traceId)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(line.spanId)).toMatch(/^[0-9a-f]{16}$/);
    // The line's own fields survive the mixin.
    expect(line.project_id).toBe("p1");
  });

  it("writes an ordinary line outside a span, rather than failing or inventing ids", async () => {
    const output = await captureLog((log) => {
      log.info({ project_id: "p1" }, "outside any span");
    });
    const line = JSON.parse(output.trim().split("\n").pop()!) as Record<string, unknown>;
    expect(line.msg).toBe("outside any span");
    expect(line.traceId).toBeUndefined();
  });
});
