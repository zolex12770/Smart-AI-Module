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

export interface StreamChatOptions {
  onFallback?: (fallback: ProviderFallback) => void;
  onRetry?: (retry: ProviderRetry) => void;
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
    const signal = callOptions.signal ?? this.options.signal;

    // An explicitly named provider is never substituted: silently swapping it would violate
    // the caller's intent. It still gets retries, just no fallback.
    if (request.provider) {
      const provider = this.registry.get(request.provider);
      if (!provider) throw new ProviderError(`Unknown provider "${request.provider}".`);
      yield* this.streamWithRetry(provider, request, reportRetry, signal);
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
    for (const provider of candidates) {
      if (signal?.aborted) throw new ProviderError("Cancelled before a provider produced output.");
      if (this.circuitOpen(provider.name)) {
        report({
          provider: provider.name,
          stage: "no_first_event",
          message: "circuit open after repeated failures",
          error: new ProviderError("circuit open"),
        });
        continue;
      }

      const iterator = this.streamWithRetry(provider, request, reportRetry, signal)[Symbol.asyncIterator]();
      let first: IteratorResult<ChatStreamEvent>;
      try {
        first = await iterator.next();
      } catch (err) {
        lastError = err;
        this.recordFailure(provider.name);
        report({
          provider: provider.name,
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
        report({ provider: provider.name, stage: "empty_stream", message: "produced no events", error: lastError });
        continue;
      }
      if (first.value.type === "error") {
        lastError = new ProviderError(first.value.message);
        this.recordFailure(provider.name);
        report({ provider: provider.name, stage: "error_event", message: first.value.message, error: lastError });
        continue;
      }

      // Committed: this provider produced a real first event.
      this.recordSuccess(provider.name);
      yield first.value;
      while (true) {
        let next: IteratorResult<ChatStreamEvent>;
        try {
          next = await iterator.next();
        } catch (err) {
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
    signal?: AbortSignal
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt++) {
      const iterator = provider.streamChat(request)[Symbol.asyncIterator]();
      let first: IteratorResult<ChatStreamEvent>;
      try {
        first = await iterator.next();
      } catch (err) {
        const retryable = classifyProviderError(err) === "retryable";
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
      yield first.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
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
