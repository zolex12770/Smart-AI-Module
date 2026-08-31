# Model Routing: ModelRegistry, ModelRouter, and ProviderAdapter Design

**Status:** Architecture/design document. No implementation yet — this defines the contracts, data model, and decision logic that the eventual code should implement. Companion documents: `04_MODEL_PROVIDER_RESEARCH.md` (the provider facts this design normalizes) and `28_API_PROVIDER_MATRIX.md` (the skimmable reference table).

**Design context:** We are building a model-agnostic agent platform targeting three concrete providers today (Anthropic, OpenAI, Google Gemini/Vertex), with the explicit expectation that a fourth or fifth provider (Bedrock-hosted Claude, Azure OpenAI, a local/open-weights model server) gets added later without touching call sites. That constraint — "adding a provider is a new adapter file, not a refactor" — drives every decision below.

---

## 1. The normalization problem

Section 6 of `04_MODEL_PROVIDER_RESEARCH.md` already identifies the four places the three providers disagree hardest: tool-calling shape, streaming event taxonomy, prompt-caching semantics, and system-prompt placement. A model-agnostic platform cannot expose any of the three providers' native request/response shapes to application code — it must define its **own** shape and translate at the edges. That translation layer is the `ProviderAdapter`.

### 1.1 Standardized internal request schema

```
AgentRequest {
  model_ref: string                 // logical model reference, e.g. "quality:high" or a pinned "anthropic:claude-opus-5"
  system: string | null             // single normalized system prompt
  messages: Message[]               // normalized conversation history
  tools: ToolDef[]                  // provider-agnostic tool declarations
  tool_choice: "auto" | "required" | "none" | { forced_tool: string }
  max_output_tokens: int
  temperature: float | null         // omitted -> provider default; NOTE: rejected outright by some providers' reasoning models — see §1.5
  response_format: ResponseFormat | null   // { type: "text" } | { type: "json_schema", schema: {...}, strict: bool }
  vision_inputs: bool               // derived from messages, not set by caller; informs capability gating
  stream: bool
  caching_hint: "none" | "auto" | "aggressive"   // see §1.4 — a hint, not a guarantee
  metadata: { request_id, user_id, task_type, ... }  // for routing + observability, stripped before hitting any provider
}

Message {
  role: "user" | "assistant" | "system_operator"  // "system_operator" = a mid-conversation operator note; adapters
                                                    // that don't support it (see matrix) fold it into the next user turn
  content: ContentBlock[]
}

ContentBlock =
    { type: "text", text: string }
  | { type: "image", source: { kind: "base64"|"url"|"file_ref", data|url|file_id } }
  | { type: "document", source: {...}, mime_type: string }
  | { type: "tool_call", id: string, name: string, arguments: object }        // assistant turn
  | { type: "tool_result", tool_call_id: string, content: ContentBlock[], is_error: bool }  // user turn

ToolDef {
  name: string
  description: string
  parameters: JSONSchema     // draft-2020-12 subset common to all three providers
  strict: bool               // adapter maps to provider's strict-mode equivalent, or emulates via validate+retry if unsupported
}
```

**Why this shape:** it is closest to Anthropic's `content` block model (block-typed, ordered, tool calls as first-class blocks interleaved with text) because that shape is the strict superset — it's trivial to *flatten* into OpenAI's `tool_calls` array or Gemini's `parts` array, but reconstructing block order from a flattened `tool_calls` array (OpenAI Chat Completions) loses information you'd need going the other direction. Pick the superset as your canonical form; each adapter's job is narrowing, not widening.

### 1.2 Standardized internal response schema

```
AgentResponse {
  id: string
  model_used: string             // the concrete provider model ID actually served, post-routing
  provider: "anthropic" | "openai" | "google"
  content: ContentBlock[]        // same union as request; assistant's turn
  stop_reason: "end_turn" | "max_tokens" | "tool_call" | "content_filter" | "error"
  usage: { input_tokens, output_tokens, cached_input_tokens, reasoning_tokens? }
  latency_ms: int
  raw_provider_response: object  // escape hatch for debugging; never consumed by generic code paths
}
```

`stop_reason` is a normalized enum. Mapping: Anthropic's `end_turn`/`max_tokens`/`tool_use`/`refusal` → `end_turn`/`max_tokens`/`tool_call`/`content_filter`; OpenAI's `stop`/`length`/`tool_calls`/`content_filter` → the same four; Gemini's `STOP`/`MAX_TOKENS`/(functionCall present)/`SAFETY` → the same four. Any provider-specific reason with no clean mapping (Anthropic's `pause_turn` for long-running server tools, for instance) becomes its own explicit enum value rather than being silently folded into `error` — losing that distinction is exactly the kind of bug that's invisible until a long-running tool call gets treated as a failure.

### 1.3 Streaming normalization

Internally, expose one event stream type regardless of provider:

```
StreamEvent =
    { type: "text_delta", text: string }
  | { type: "tool_call_start", id, name }
  | { type: "tool_call_arguments_delta", id, partial_json: string }
  | { type: "tool_call_end", id }
  | { type: "message_done", response: AgentResponse }
  | { type: "error", error: NormalizedError }
```

Anthropic maps almost directly (`content_block_delta` with `text_delta`/`input_json_delta` → `text_delta`/`tool_call_arguments_delta`). OpenAI's Responses API also maps directly (`response.output_text.delta` / `response.function_call_arguments.delta`). OpenAI's Chat Completions and Gemini's `streamGenerateContent` are both **whole-chunk** streams (each chunk is a full, growing `delta`/`GenerateContentResponse` object, not a typed micro-event) — for these, the adapter must diff successive chunks itself to synthesize `tool_call_arguments_delta` events, since the wire format never says "here is 12 more characters of the argument JSON" the way Anthropic and OpenAI Responses do natively. This is a real cost of supporting Gemini's `generateContent` and OpenAI's Chat Completions surfaces and should be budgeted as adapter-side work, not assumed free.

### 1.4 Prompt caching — a hint, not a contract

Given how differently the three providers implement caching (§4 of the research doc), `caching_hint` cannot mean the same thing everywhere:

- **Anthropic adapter**: `"auto"` inserts a `cache_control` breakpoint after the system prompt + tool definitions (the stable prefix); `"aggressive"` adds a second breakpoint after all-but-the-last-turn of conversation history too (bounded by the 4-breakpoint limit).
- **OpenAI adapter**: caching is automatic server-side; the hint is a no-op except that `"aggressive"` sets `prompt_cache_key` to a stable hash of the system+tools prefix to improve routing consistency.
- **Google adapter**: `"auto"` relies on implicit caching (no-op, just meets the 2K/4K token minimum by not fragmenting the prefix); `"aggressive"` creates an explicit named cache object with a TTL when the stable prefix is reused across a batch of requests (e.g., a shared system prompt across many concurrent user sessions) — this is the one case where the hint changes API surface, not just a parameter.

The router records realized `cached_input_tokens` from every response (§1.2) back into the CapabilityRegistry's rolling stats so routing/cost decisions can account for actual cache hit rate per (provider, model, prompt-shape) rather than assuming the hint always works.

### 1.5 System prompts and provider quirks the adapters must hide

- Gemini's `generateContent` takes system instructions in a dedicated `system_instruction` field, not as a message; the adapter converts `AgentRequest.system` into that field. The Interactions API and Chat Completions/Responses APIs both take a `system`/`developer`-role message instead — three different placements for what our schema treats as one field.
- The `"system_operator"` mid-conversation role (§1.1) is a real Anthropic feature (Opus 5/4.8/Fable 5 only, not Sonnet 5) with no equivalent on OpenAI or Google. Adapters that don't support it fold the block into the content of the next `user` message with a clear textual delimiter, so behavior degrades gracefully instead of erroring.
- Some reasoning-tuned model configurations reject `temperature` outright (a 400, not a silent ignore) when thinking/reasoning is active. The adapter layer must treat `temperature` as advisory and drop it per-model based on the CapabilityRegistry (`supports_temperature: bool`) rather than always forwarding it — this is described generically here because it is a recurring pattern across providers' reasoning-model lines, not a one-provider quirk, and it must be re-verified per model at adapter-build time since which specific models reject it shifts release to release.

---

## 2. CapabilityRegistry

A `ModelDescriptor` records what one concrete model can do, independent of routing policy:

```
ModelDescriptor {
  id: string                        // e.g. "anthropic:claude-opus-5"
  provider: "anthropic" | "openai" | "google"
  provider_model_id: string         // the literal string sent on the wire, e.g. "claude-opus-5"
  tier: "flagship" | "balanced" | "fast_cheap"
  context_window_tokens: int
  max_output_tokens: int
  supports_vision: bool
  supports_tool_calling: bool
  supports_parallel_tool_calls: bool
  supports_strict_tool_schema: bool
  supports_structured_output: bool
  supports_streaming: bool
  supports_prompt_caching: "none" | "explicit" | "automatic" | "both"
  supports_system_operator_message: bool
  supports_temperature: bool
  supports_reasoning_effort: bool
  cost_tier: 1..5                   // relative, sourced from the cost workstream — not owned here
  avg_latency_ms_p50: float         // rolling, updated from observed traffic
  avg_latency_ms_p95: float
  quality_score: { general: float, coding: float, reasoning: float, ... }  // seeded from public benchmarks, refined by eval workstream
  safety_tier: "standard" | "restricted" | "not_for_untrusted_input"
  last_verified: date               // when this descriptor was last checked against the provider's live /models endpoint
}
```

**Population strategy:** seed statically from `04_MODEL_PROVIDER_RESEARCH.md` at build time, but reconcile against each provider's live model-introspection endpoint on a schedule (Anthropic's `GET /v1/models/{id}` returns `max_input_tokens`/`max_tokens`/`capabilities` directly; OpenAI and Google both expose an equivalent `models.list()`/`models.get()`). A model whose live descriptor disagrees with the static seed (a context window bump, a deprecation notice) should flip a `needs_review` flag rather than silently auto-adopting the new value, since capability changes can also mean a request shape changed underneath it (e.g., Gemini's Interactions-vs-generateContent split in §3.2 of the research doc). Treat `last_verified` staleness past ~30 days as a reason to re-fetch before trusting the descriptor for a routing decision on an unfamiliar task type.

**Logical aliases** (`"quality:high"`, `"speed:fast"`, `"cost:cheap"`) resolve to a *ranked list* of concrete `ModelDescriptor.id`s, not a single one — this is what makes cross-provider fallback (§4) possible without the caller ever naming a specific model.

---

## 3. ModelRouter: decision logic

The router's job, given an `AgentRequest` plus routing context, is to pick an ordered candidate list of concrete models (first choice + fallback chain), not just one model — fallback is a first-class output of routing, not a bolt-on retry loop.

### 3.1 Inputs to the routing decision

| Signal | Source | Effect |
|---|---|---|
| `task_type` | caller-supplied metadata (`"chat"`, `"code_agent"`, `"classification"`, `"summarization"`, `"long_document_qa"`, `"vision"`) | Selects the quality-dimension to optimize in `quality_score` and sets a default quality/speed/cost preset |
| Explicit quality/speed/cost preference | caller-supplied, overrides task-type default | Directly weights the scoring function (§3.2) |
| Context length needed | computed from the actual request (system + history + expected tool schemas) | Hard filter: eliminates any `ModelDescriptor` with `context_window_tokens` < needed, with headroom (see below) |
| Vision present | derived from `AgentRequest.vision_inputs` | Hard filter: eliminates non-vision models |
| Structured output / strict tools requested | derived from `response_format`/`tools[].strict` | Hard filter or soft penalty — see §3.3 |
| Availability/latency | rolling health data per (provider, model, region) | Soft penalty proportional to recent error rate / p95 latency vs. baseline |
| Quota / rate-limit headroom | live token-bucket state per provider (from response headers, §7 of the research doc, or polled quota for Google) | Hard filter if a provider is currently exhausted; otherwise soft penalty proportional to remaining headroom |
| User/org preference | account-level config (e.g., "never route to Provider X", "prefer Provider Y for cost") | Hard filter (exclusion) or ranking bias, per policy |
| Safety policy | content classification of the request (see §3.4) | Hard filter — can both include-only and exclude specific models |

**Context-length headroom rule:** never route to a model whose window is within 10% of the computed need — context estimation from tokenizer approximation is inexact, provider tokenizers differ (Anthropic's Opus 4.7+ tokenizer alone uses 1×–1.35× the tokens of its predecessor per the migration notes in the research doc), and system-prompt/tool-schema overhead is easy to undercount. Treat the 10% margin as a floor, not a target.

### 3.2 Scoring function

For each candidate surviving the hard filters, compute:

```
score = w_quality * normalize(quality_score[task_dimension])
      + w_speed   * normalize(1 / avg_latency_ms_p50)
      + w_cost    * normalize(1 / cost_tier)
      - penalty_availability(error_rate_last_5m)
      - penalty_quota(fraction_of_rate_limit_consumed)
```

Weights (`w_quality`, `w_speed`, `w_cost`) come from the task-type preset, then are overridden by any explicit caller preference. Defaults by task type:

| task_type | w_quality | w_speed | w_cost | Rationale |
|---|---|---|---|---|
| `code_agent` / long-horizon agentic | 0.6 | 0.2 | 0.2 | Wrong tool calls compound across turns; a cheaper-but-flakier model costs more in wasted turns than it saves in tokens |
| `chat` (interactive, user-facing) | 0.3 | 0.5 | 0.2 | Perceived latency dominates UX; most chat turns don't need flagship reasoning |
| `classification` / extraction | 0.2 | 0.3 | 0.5 | High-volume, well-specified, tolerant of the fast/cheap tier |
| `long_document_qa` | 0.5 | 0.1 | 0.4 | Quality matters, but latency is already dominated by long-context processing time regardless of tier |
| `vision` | 0.5 | 0.3 | 0.2 | Vision quality varies more across tiers than text quality does; don't default to the cheapest vision-capable model |

This table is a starting default, not a fixed law — it should move to config once the eval workstream has real quality numbers per task type rather than the seeded benchmark scores.

### 3.3 Structured output / strict tools as routing signal

A request with `response_format.type == "json_schema"` and `strict: true` is a **hard filter** against `supports_structured_output`/`supports_strict_tool_schema` in the CapabilityRegistry — do not route there and hope the adapter can emulate it, because emulated strict-mode (validate-then-retry) changes both latency and cost characteristics enough that it should be a visible, logged fallback rather than a transparent substitution. A request with `strict: false` or unset is a **soft preference** — prefer a model with native support, but don't exclude others.

### 3.4 Safety policy as a routing input

Safety policy acts at two points, not one:

1. **Pre-routing, request-level:** a request classified as touching a restricted content category (per org policy) is filtered to `safety_tier: "standard"` models only, regardless of the quality/speed/cost scoring — this filter runs *before* scoring, the same as the context-length and vision filters.
2. **Post-response, provider-native refusal:** Anthropic's `refusal` stop reason and OpenAI's `refusal` field are both normalized into `AgentResponse.stop_reason = "content_filter"` (§1.2). The router's retry logic (§4) treats `content_filter` specially: **it does not blindly retry the same request against a different model**, since a refusal is a policy signal, not a transient failure. It surfaces the refusal category to the caller and only re-routes if the caller/orchestration layer explicitly opts into a "try a more permissive model in this policy tier" path — auto-escalating past a safety refusal by provider-hopping is exactly the failure mode a model-agnostic router must not have by default.

---

## 4. Fallback and retry design

Two distinct mechanisms, often conflated but kept separate here:

- **Retry**: same model, same provider, transient failure (429, 5xx, timeout, connection error).
- **Fallback**: different model, possibly different provider, because the first choice is unavailable, exhausted, or structurally incompatible with the request (post-hoc capability mismatch discovered at call time).

### 4.1 Retry (same candidate)

```
for attempt in 0..max_retries (default 3):
    try:
        response = adapter.call(request)
        return response
    except RetryableError as e:      // 429, 5xx, connection/timeout
        if attempt == max_retries: break
        delay = min(base_delay * (2 ** attempt) + jitter(), max_delay)
        if e.retry_after_header present: delay = max(delay, e.retry_after_header)
        sleep(delay)
    except NonRetryableError as e:   // 400, 401, 404, content_filter
        raise immediately            // never retry — a bad request doesn't become good by waiting
advance to fallback chain
```

- `base_delay` = 500ms, `max_delay` = 20s, full jitter (random between 0 and the computed delay) — standard exponential backoff with jitter, to avoid synchronized retry storms across concurrent requests hitting the same rate limit.
- **Honor the provider's own signal when present.** Anthropic and OpenAI both return an explicit wait time on 429 (`retry-after` seconds / `retry-after-ms`) — use it as a floor on the computed backoff rather than guessing. Google's Gemini API is less consistent about this (per §3.8 of the research doc), so its adapter falls back to the computed exponential schedule.
non-retryable classes: 400 (bad request — a schema/logic bug, retrying won't fix it), 401/403 (auth/permission — retrying without fixing credentials just burns quota), 404 (unknown model — likely a stale `ModelDescriptor`, should also raise a registry-staleness alert, not just fail the request), and `content_filter`/refusal (§3.4 — policy, not failure).
- Cap total retry attempts per candidate at 3 by default; this is a per-candidate budget, not a global one — the fallback chain (§4.2) gets its own attempts.

### 4.2 Fallback (across candidates)

```
candidates = router.route(request)   // ordered list from §3, e.g. [opus-5, gpt-5.6-sol, gemini-3.1-pro]
errors = []
for candidate in candidates:
    if not quota_available(candidate): errors.append(skip: quota_exhausted); continue
    try:
        return retry_loop(candidate, request)   // §4.1
    except NonRetryableError_structural as e:
        // e.g. candidate turns out not to support a tool shape the request actually needs,
        // discovered only from a 400 the static CapabilityRegistry didn't predict
        errors.append(candidate, e)
        continue
    except RetryableError_exhausted as e:
        // retry loop above ran out of attempts
        errors.append(candidate, e)
        continue
    except NonRetryableError_terminal as e:
        // content_filter, auth failure, malformed-but-not-provider's-fault request
        raise GracefulFailure(errors + [candidate: e])   // do not fall through to next candidate
raise GracefulFailure(all_candidates_exhausted: errors)
```

Key decisions embedded here:

1. **Fallback candidates must be pre-filtered for compatibility, not just quality-ranked.** The router (§3) already excludes models that fail hard filters (context length, vision, structured output support), so by construction every candidate in the chain *should* be able to serve the request. The `NonRetryableError_structural` branch exists for the residual case where the live provider disagrees with the static `ModelDescriptor` (a capability was mis-recorded, or changed since `last_verified`) — this should always also emit a registry-staleness signal, since silently falling back masks a data quality problem that will keep recurring.
2. **`content_filter` does not trigger fallback by default** (§3.4) — it's a terminal `GracefulFailure` unless the caller explicitly opted into cross-model escalation for that policy tier.
3. **Quota exhaustion is checked before spending a retry budget on it** — if the router already knows (from rolling rate-limit state) that a provider is out of headroom, skip straight to the next candidate rather than burning the 429 → backoff → 429 cycle.
4. **Graceful failure is structured, not a bare exception.** `GracefulFailure` carries the full per-candidate error list so the caller (or an observability pipeline) can distinguish "every provider was down" from "the request was structurally impossible to serve" from "we're out of budget everywhere" — these need different alerts and different remediation.
5. **Cache invalidation on fallback.** Switching provider/model mid-conversation invalidates any provider-side prompt cache (Anthropic `cache_control`, Google explicit cache) built up for that conversation — this is an expected cost of fallback, not a bug, but it should be visible in cost/usage telemetry so a flapping provider doesn't silently blow up spend through repeated cache rebuilds.

### 4.3 What "graceful failure" returns to the caller

Never a raw provider exception. Always a normalized:

```
GracefulFailure {
  request_id: string
  attempted: [{ model_id, provider, error_class, error_detail, attempt_count }]
  final_status: "all_providers_exhausted" | "no_compatible_model" | "quota_exhausted_all" | "policy_blocked"
  retry_after_hint: duration | null   // if every failure was transient/quota, suggest when the caller might retry the whole request
}
```

This lets calling code (an agent loop, a chat UI, a batch job) decide its own degradation behavior — show the user an error, queue for later, or drop to a cached/canned response — without needing to know which of the three providers' exception hierarchies it's looking at.

---

## 5. ProviderAdapter interface

Every concrete adapter (`AnthropicAdapter`, `OpenAIAdapter`, `GoogleAdapter`, and any future one) implements the same contract:

```
ProviderAdapter {
  provider_id: string
  call(AgentRequest, ModelDescriptor) -> AgentResponse            // non-streaming
  stream(AgentRequest, ModelDescriptor) -> Iterator<StreamEvent>  // streaming, per §1.3
  translate_error(raw_exception) -> RetryableError | NonRetryableError  // classification, per §4.1
  supports(ModelDescriptor, AgentRequest) -> bool                 // pre-flight capability check, cheaper than a failed call
}
```

`supports()` exists specifically to let the router do a final compatibility check *before* dispatch (catching the case in §4.2.1 where the registry might be stale) without needing to attempt and fail a real API call first — each adapter implements it as a fast, local check against `ModelDescriptor` fields plus any adapter-specific quirks (e.g., "Anthropic's `system_operator` message role requires this specific model *and* isn't the first message" from §1.5).

Each adapter owns:
- Request translation (§1.1 → provider wire format), including the system-prompt placement quirks (§1.5) and the caching-hint translation (§1.4).
- Response translation (provider wire format → §1.2/§1.3).
- Error classification (§4.1) — this is where each provider's actual exception/status-code taxonomy (documented per-provider in `28_API_PROVIDER_MATRIX.md`) gets mapped to the two internal classes.
- Auth resolution (API key vs. OAuth vs. GCP ADC — see the matrix for the concrete env vars).

Adapters must **not** leak provider-specific types past their own boundary — no `raw_provider_response` field is ever pattern-matched by generic router/registry code; it exists purely for debugging and logging.

---

## 6. Summary of concrete decisions made in this design

- Canonical internal schema is block-typed and superset-shaped (closest to Anthropic's), narrowed per adapter rather than widened.
- Streaming is normalized to typed micro-events; whole-chunk-diffing providers (Gemini `generateContent`, OpenAI Chat Completions) pay the adapter-side cost of synthesizing deltas.
- Caching is a hint with provider-specific meaning, and realized cache-hit telemetry feeds back into the registry rather than being trusted blindly.
- Routing runs hard filters (context, vision, structured-output, safety, quota) before a weighted quality/speed/cost score, with per-task-type default weights that are expected to be replaced by measured data later.
- Retry (same candidate, transient) and fallback (different candidate, structural/exhaustion) are separate mechanisms with separate budgets; safety refusals are excluded from both by default.
- Failure is always returned as a structured `GracefulFailure`, never a raw provider exception, so calling code can make its own degradation decision.
