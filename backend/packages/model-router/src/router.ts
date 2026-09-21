import { ProviderError, type ChatRequest, type ChatStreamEvent, type LLMProvider } from "@ai-platform/shared";
import type { ModelRegistry, SelectionCriteria } from "./registry.js";

/**
 * Routing, retry and fallback — docs/12_MODEL_ROUTING.md §4, completed by ADR-058.
 *
 * The previous router had no retry, no backoff, never read `Retry-After`, and skipped a
 * silent provider without reporting it. All three are fixed here, and the guarantee the
 * fallback design rests on is unchanged and load-bearing:
 *
 *   **Fallback only happens BEFORE a provider yields its first real event.** Once tokens are
 *   flowing to the caller, switching providers would splice half an answer from one model
 *   onto a full answer from another. After the first event a failure is a clean stream error.
 *
 * Nothing is silent. Every retry, every backoff, and every provider skipped is reported to
 * `onFallback`/`onRetry`, which the composition root wires to the structured logger (ADR-044).
 */

export interface ProviderFallback {
  provider: string;
  /**
   * The provider tried NEXT, or null when this was the last candidate — ADR-132.
   *
   * `recordProviderFallback` has always taken a `from` and a `to`, and nothing ever called it,
   * because a report that names only the provider that failed cannot answer the question the
   * metric exists for: which provider is carrying the traffic when the preferred one is down.
   */
  to: string | null;
  stage: "no_first_event" | "error_event" | "empty_stream";
  message: string;
  error: unknown;
}

export interface ProviderRetry {
  provider: string;
  attempt: number;
  delayMs: number;
  message: string;
}

export interface RetryPolicy {
  /** Attempts per provider, including the first. docs/12 §4.1 specifies 3. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 20_000 };

/**
 * One completed provider call, as the metrics want it — docs/26_DECISIONS.md ADR-132.
 *
 * `provider_requests_total` and `provider_tokens_total` were recorded in exactly ONE place: the
 * chat route's success branch, below a `continue` that skips everything but the terminal `done`
 * event. So the counters described chat that worked, and nothing else — not a chat that failed,
 * not summarisation, not RAG, not a single agent step. A dashboard built on them showed a
 * provider with a 100% success rate during an outage, because the failures were never counted.
 *
 * Reported from the router because the router is the one thing every model call goes through.
 */
export interface ProviderCallOutcome {
  provider: string;
  model?: string;
  /** `cancelled` is not a failure: the caller went away, which the provider did nothing wrong in. */
  status: "success" | "error" | "cancelled";
  durationMs: number;
  /** A BOUNDED label — an error class, never a message. Unbounded values ruin a metric. */
  errorType?: "retryable" | "fatal";
  inputTokens?: number;
  outputTokens?: number;
}

export interface StreamChatOptions {
  onFallback?: (fallback: ProviderFallback) => void;
  onRetry?: (retry: ProviderRetry) => void;
  /** Called once per completed provider call, whatever its outcome (ADR-132). */
  onCall?: (call: ProviderCallOutcome) => void;
  /** Hard requirements/preferences for provider selection. */
  criteria?: SelectionCriteria;
  signal?: AbortSignal;
}

export interface ModelRouterOptions extends StreamChatOptions {
  retryPolicy?: RetryPolicy;
  /** Consecutive failures before a provider is skipped for `circuitResetMs`. */
  circuitThreshold?: number;
  circuitResetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Errors worth retrying the SAME provider for, versus errors that should fail over. */
export function classifyProviderError(error: unknown): "retryable" | "fatal" {
  const message = error instanceof Error ? error.message : String(error);
  if (/\((429|408|500|502|503|504)\)/.test(message)) return "retryable";
  if (/timeout|timed out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed/i.test(message)) {
    return "retryable";
  }
  /**
   * An empty response is TRANSIENT, and treating it as fatal sent tool-requiring work to a
   * provider that could not do it (ADR-094).
   *
   * A local runtime occasionally returns a turn with no content and no tool calls — sampling,
   * not a broken request. The adapters correctly refuse to pass that off as an empty success
   * (ADR-045), but classifying the refusal as fatal made the router fail over immediately. On an
   * AGENT request the next provider was the mock, whose scripted reply then entered the agent's
   * transcript and burned an iteration: the identical request, asked again, produces a real tool
   * call. Observed, not theorised — a `fix_failing_test` run fell back to the mock on its first
   * turn, and a replay of the byte-identical request returned `finish_reason: tool_calls`.
   *
   * Retrying the SAME provider is what this classification is for: the request was fine.
   */
  if (/returned no content|returned an empty stream|produced no events|empty response/i.test(message)) {
    return "retryable";
  }
  // 400/401/403/404 and unparseable-argument errors will not fix themselves.
  return "fatal";
}

/** Honours a provider's own `Retry-After` when it told us one, as docs/12 §4.1 requires. */
export function retryAfterMsFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const seconds = /retry-after["':\s]+(\d+)/i.exec(message);
  if (seconds) return Number(seconds[1]) * 1000;
  const ms = /retry-after-ms["':\s]+(\d+)/i.exec(message);
  if (ms) return Number(ms[1]);
  return null;
}

interface CircuitState {
  failures: number;
  openedAt: number | null;
}

export class ModelRouter {
  private readonly retryPolicy: RetryPolicy;
  private readonly circuitThreshold: number;
  private readonly circuitResetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    private readonly registry: ModelRegistry,
    private readonly options: ModelRouterOptions = {}
  ) {
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.circuitThreshold = options.circuitThreshold ?? 5;
    this.circuitResetMs = options.circuitResetMs ?? 30_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  async *streamChat(
    request: ChatRequest,
    callOptions: StreamChatOptions = {}
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const report = (f: ProviderFallback) => (callOptions.onFallback ?? this.options.onFallback)?.(f);
    const reportRetry = (r: ProviderRetry) => (callOptions.onRetry ?? this.options.onRetry)?.(r);
    const reportCall = (c: ProviderCallOutcome) => (callOptions.onCall ?? this.options.onCall)?.(c);
    const signal = callOptions.signal ?? this.options.signal;

    // An explicitly named provider is never substituted: silently swapping it would violate
    // the caller's intent. It still gets retries, just no fallback.
    if (request.provider) {
      const provider = this.registry.get(request.provider);
      if (!provider) throw new ProviderError(`Unknown provider "${request.provider}".`);
      yield* this.streamWithRetry(provider, request, reportRetry, reportCall, signal);
      return;
    }

    const criteria: SelectionCriteria = {
      ...(callOptions.criteria ?? this.options.criteria ?? {}),
      // A request carrying tools may only go to a provider that can call them.
      requiresTools: (callOptions.criteria?.requiresTools ?? this.options.criteria?.requiresTools) || Boolean(request.tools?.length),
    };

    const candidates = this.registry.select(criteria);
    if (candidates.length === 0) {
      throw new ProviderError(
        `No configured model provider satisfies this request (tools required: ${Boolean(request.tools?.length)}).`
      );
    }

    let lastError: unknown;
    for (const [index, provider] of candidates.entries()) {
      // Named before it is needed so every `report` below can say where the traffic went.
      const nextProvider = candidates[index + 1]?.name ?? null;
      if (signal?.aborted) throw new ProviderError("Cancelled before a provider produced output.");
      if (this.circuitOpen(provider.name)) {
        report({
          provider: provider.name,
          to: nextProvider,
          stage: "no_first_event",
          message: "circuit open after repeated failures",
          error: new ProviderError("circuit open"),
        });
        continue;
      }

      const iterator = this.streamWithRetry(provider, request, reportRetry, reportCall, signal)[Symbol.asyncIterator]();
      let first: IteratorResult<ChatStreamEvent>;
      try {
        // Abortable here too, not only in the inner loop (ADR-146): this is the pull the CALLER
        // is waiting on, so a signal that cannot end it cannot end the call.
        first = await pullOrAbort(iterator, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        this.recordFailure(provider.name);
        report({
          provider: provider.name,
          to: nextProvider,
          stage: "no_first_event",
          message: err instanceof Error ? err.message : String(err),
          error: err,
        });
        continue;
      }

      if (first.done) {
        // Previously skipped WITHOUT reporting — a real hole in "a fallback is never silent".
        lastError = new ProviderError(`Provider "${provider.name}" produced no events.`);
        this.recordFailure(provider.name);
        report({ provider: provider.name, to: nextProvider, stage: "empty_stream", message: "produced no events", error: lastError });
        continue;
      }
      if (first.value.type === "error") {
        lastError = new ProviderError(first.value.message);
        this.recordFailure(provider.name);
        report({ provider: provider.name, to: nextProvider, stage: "error_event", message: first.value.message, error: lastError });
        continue;
      }

      // Committed: this provider produced a real first event.
      this.recordSuccess(provider.name);
      try {
        yield first.value;
        while (true) {
          let next: IteratorResult<ChatStreamEvent>;
          try {
            next = await pullOrAbort(iterator, signal);
          } catch (err) {
            // A CANCELLED call is not a provider failure, and must not be reported to the caller
            // as an answer that went wrong — it is the caller's own abort coming back (ADR-146).
            if (signal?.aborted) throw err;
            yield {
              type: "error",
              message: `The model provider failed partway through responding: ${
                err instanceof Error ? err.message : String(err)
              }`,
            };
            return;
          }
          if (next.done) return;
          yield next.value;
        }
      } finally {
        /**
         * Close the provider's own iterator — ADR-119.
         *
         * A consumer abandons this generator whenever a caller stops reading: the chat route's
         * `for await` ends when the browser disconnects, and a cancelled agent node does the same.
         * JavaScript then calls `return()` on THIS generator, but the provider's iterator was
         * obtained by hand (`[Symbol.asyncIterator]()`) and delegation never forwarded that call,
         * so the provider generator's own `finally` — the one that aborts the upstream HTTP
         * request — never ran. The provider kept generating, and kept billing, into a stream
         * nobody was reading. `return()` on a generator that already finished is a no-op.
         */
        await closeQuietly(iterator);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ProviderError("All configured LLM providers failed to respond.");
  }

  /**
   * Retries one provider with exponential backoff and full jitter, honouring `Retry-After`
   * as a floor. Retry only happens before the first event for the same reason fallback does.
   */
  private async *streamWithRetry(
    provider: LLMProvider,
    request: ChatRequest,
    reportRetry: (r: ProviderRetry) => void,
    reportCall: (c: ProviderCallOutcome) => void,
    signal?: AbortSignal
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt++) {
      // Per ATTEMPT, so a retried call is two measurements rather than one long one — which is
      // what a latency histogram has to mean to be read (ADR-132).
      const startedAt = this.now();
      const iterator = provider.streamChat(request)[Symbol.asyncIterator]();
      let first: IteratorResult<ChatStreamEvent>;
      try {
        first = await pullOrAbort(iterator, signal);
      } catch (err) {
        const classification = classifyProviderError(err);
        const retryable = classification === "retryable";
        reportCall({
          provider: provider.name,
          // Nothing was streamed, so there is no reported model: the configured one is all
          // this attempt ever knew (ADR-155).
          model: provider.model,
          status: "error",
          durationMs: this.now() - startedAt,
          errorType: retryable ? "retryable" : "fatal",
        });
        if (!retryable || attempt === this.retryPolicy.maxAttempts || signal?.aborted) throw err;
        const delay = this.backoffDelay(attempt, retryAfterMsFromError(err));
        reportRetry({
          provider: provider.name,
          attempt,
          delayMs: delay,
          message: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(delay);
        continue;
      }
      if (first.done) return;
      let settled = false;
      // Whether the provider actually FINISHED, which is not the same as whether it reported
      // token counts: a `done` event may carry no usage, and treating that as an abandoned
      // stream would report a successful call as cancelled.
      let sawDone = false;
      let usage: { inputTokens?: number; outputTokens?: number } = {};
      /**
       * The model that ACTUALLY answered — docs/26_DECISIONS.md ADR-155.
       *
       * Every outcome was reported with `provider.model`, the adapter's constructor-time
       * default. The adapters honour a per-request override (`request.model ?? this.model`) and
       * `chatRequestSchema` makes `model` a caller-supplied field that the chat route forwards
       * unchanged — so a deployment whose callers name a model saw every token, every cost and
       * every latency bucket attributed to the default instead. The `done` event reports what
       * was used; the constructor default is only the fallback for a stream that never said.
       */
      let effectiveModel = provider.model;
      const settle = (status: ProviderCallOutcome["status"], errorType?: ProviderCallOutcome["errorType"]) => {
        if (settled) return;
        settled = true;
        reportCall({
          provider: provider.name,
          model: effectiveModel,
          status,
          durationMs: this.now() - startedAt,
          ...(errorType ? { errorType } : {}),
          ...usage,
        });
      };
      try {
        if (first.value.type === "done") {
          sawDone = true;
          usage = first.value.usage ?? {};
          effectiveModel = first.value.model || effectiveModel;
        }
        yield first.value;
        while (true) {
          const next = await pullOrAbort(iterator, signal);
          if (next.done) return;
          // The terminal event carries the only token counts the provider reports.
          if (next.value.type === "done") {
            sawDone = true;
            usage = next.value.usage ?? {};
            effectiveModel = next.value.model || effectiveModel;
          }
          yield next.value;
        }
      } catch (err) {
        settle("error", classifyProviderError(err) === "retryable" ? "retryable" : "fatal");
        throw err;
      } finally {
        // Reached on a normal finish AND when the caller abandons the generator. A stream that
        // produced its `done` event succeeded; one abandoned before it did was cancelled, which
        // is not the provider failing and must not be counted as one.
        settle(sawDone ? "success" : "cancelled");
        // The provider's own iterator, closed when this generator is abandoned or finishes —
        // ADR-119. This is the layer that actually reaches the adapter's `finally`, where the
        // upstream HTTP request is aborted; the caller above closes THIS generator in turn.
        await closeQuietly(iterator);
      }
    }
  }

  private backoffDelay(attempt: number, retryAfterMs: number | null): number {
    const exponential = Math.min(this.retryPolicy.baseDelayMs * 2 ** (attempt - 1), this.retryPolicy.maxDelayMs);
    // Full jitter (AWS's recommendation) — avoids a thundering herd of synchronised retries.
    const jittered = Math.random() * exponential;
    return Math.max(retryAfterMs ?? 0, Math.ceil(jittered));
  }

  private circuitOpen(name: string): boolean {
    const state = this.circuits.get(name);
    if (!state?.openedAt) return false;
    if (this.now() - state.openedAt >= this.circuitResetMs) {
      // Half-open: allow one probe through rather than waiting for a manual reset.
      this.circuits.set(name, { failures: 0, openedAt: null });
      return false;
    }
    return true;
  }

  private recordFailure(name: string): void {
    const state = this.circuits.get(name) ?? { failures: 0, openedAt: null };
    const failures = state.failures + 1;
    this.circuits.set(name, {
      failures,
      openedAt: failures >= this.circuitThreshold ? this.now() : state.openedAt,
    });
  }

  private recordSuccess(name: string): void {
    this.circuits.set(name, { failures: 0, openedAt: null });
  }
}

/**
 * A pull that the abort signal can end — docs/26_DECISIONS.md ADR-146.
 *
 * Cancellation was built on the assumption that an adapter observes its signal: the router passes
 * one, the real adapters hand it to `fetch`, and an aborted fetch rejects. That is true of the
 * adapters in this repository and is true of nothing else. An adapter that ignores the signal —
 * a third-party one, a future one, or simply a provider that stops sending bytes without closing
 * the socket — leaves this loop parked on `iterator.next()` with no way out, and the whole
 * cancellation chain above it (route → engine → loop → router) waits on a promise that will never
 * settle. That is what made `AgentEngine.cancel` unable to return: the abort was issued and the
 * work did not notice.
 *
 * Racing the pull against the signal makes the guarantee the router's own, rather than every
 * adapter's. The abandoned pull is not left dangling: the caller's `finally` closes the iterator
 * (ADR-119), which is what releases the underlying response.
 */
async function pullOrAbort(
  iterator: AsyncIterator<ChatStreamEvent>,
  signal: AbortSignal | undefined
): Promise<IteratorResult<ChatStreamEvent>> {
  if (!signal) return iterator.next();
  if (signal.aborted) throw abortReason(signal);

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new ProviderError("The model call was cancelled.");
}

/**
 * Closing an iterator must never be the thing that hangs — docs/26_DECISIONS.md ADR-146.
 *
 * ADR-119 added `await iterator.return?.(undefined)` so an abandoned stream closes the provider's
 * generator, which is what aborts the upstream request. That is right, and it has one property
 * nobody looked for: `return()` on a generator suspended at an `await` — rather than at a `yield`
 * — does not take effect until the generator next reaches a suspension point. A provider parked
 * on a promise that never settles therefore never accepts the return, and the `await` on it never
 * resolves.
 *
 * So the cleanup inherited exactly the hang it was written to prevent, one layer up: an aborted
 * call rejected correctly, and then blocked forever in its own `finally`. That is what made
 * `AgentEngine.cancel` unable to complete even after the abort reached the router — the lock it
 * needed was held by a run stuck in cleanup.
 *
 * Closing is best-effort by nature: the signal has already been delivered and the socket is
 * already being torn down by the adapter's own `finally` when it has one. Bounding the wait costs
 * nothing real and removes a whole class of unkillable call.
 */
const CLOSE_TIMEOUT_MS = 2_000;

async function closeQuietly(iterator: AsyncIterator<ChatStreamEvent>): Promise<void> {
  if (!iterator.return) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      iterator.return(undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        // A cleanup timer must never hold a process (or a test run) open.
        timer.unref?.();
      }),
    ]);
  } catch {
    // A generator that throws on close has still been asked to stop, which is all this needed.
  } finally {
    if (timer) clearTimeout(timer);
  }
}
