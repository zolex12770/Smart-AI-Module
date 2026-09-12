import { context, trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";

export { SpanStatusCode };
export type { Span, Attributes };
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * OpenTelemetry tracing per docs/20_OBSERVABILITY.md — real spans, real parent/child
 * nesting via `AsyncLocalStorageContextManager` (registered by `NodeTracerProvider.register()`
 * with no args, confirmed by reading its source rather than assumed), real trace/span ids
 * correlated into log lines. Deliberately does NOT wire up auto-instrumentation
 * (`@opentelemetry/instrumentation-http` etc.) or an OTLP exporter to a real Collector: this
 * repo has no Docker (docs/20 §4's own acknowledged local-dev fallback — "structured console
 * logging... without full trace/metrics visualization... until Docker Desktop is installed")
 * and no Collector/Tempo/Grafana running to receive OTLP. Manual spans + a `ConsoleSpanExporter`
 * are the honest, verifiable substitute.
 *
 * The spans docs/20 §3.3 calls for — `agent.run`, `agent.step`, `tool.call`, `gen_ai.chat` and
 * job processing — are created explicitly at the point that matters, so no auto-instrumentation
 * gap can silently miss one. That sentence used to be here while only two of the five existed
 * (ADR-073); the missing three are now real, and `span-coverage.test.ts` asserts the tree they
 * form against an in-memory exporter, so the claim is checked rather than merely written down.
 * Swapping to a real OTLP exporter later (once a Collector exists) is a
 * one-line change to `spanProcessors` here, not an application-code change (docs/20 §4's stated
 * design goal), since none of the call sites that create spans know or care what the exporter is.
 */
let initialized = false;

export function initTracing(serviceName: string): void {
  if (initialized) return;
  initialized = true;
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  });
  provider.register();
}

export function getTracer(name = "ai-platform") {
  return trace.getTracer(name);
}

/** Trace/span id of whatever span is active on the current async context, for log correlation. */
export function currentTraceContext(): { traceId: string; spanId: string } | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/**
 * Runs `fn` inside a new active span named `name` — records success/failure status and
 * exceptions automatically, and always ends the span (even on throw), per the standard OTel
 * manual-instrumentation pattern (see the library's own `startActiveSpan` doc example, which
 * this mirrors).
 */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, context.active(), async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
