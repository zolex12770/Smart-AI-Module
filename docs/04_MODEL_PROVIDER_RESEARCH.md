# Model Provider Research: Anthropic, OpenAI, Google

**Scope:** Text/reasoning/vision LLM APIs for Anthropic (Claude), OpenAI, and Google (Gemini API + Vertex AI). Embeddings are covered briefly at the end. Image/video generation and cost modeling are out of scope (owned by other workstreams).

**Access date for all facts in this document: 2026-08-31.** Model lineups, context windows, and API surfaces in this space change every few weeks — treat every figure below as "current as of the access date," re-verify before relying on it in an implementation, and prefer each provider's live `/models` endpoint over any hardcoded table (all three providers expose one — see §7).

---

## 1. Anthropic (Claude)

Primary docs: [platform.claude.com/docs](https://platform.claude.com/docs/en/home) · [Models overview](https://platform.claude.com/docs/en/models/overview) · [Rate limits](https://platform.claude.com/docs/en/api/rate-limits) · [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)

### 1.1 Model tiers (as of 2026-08-31)

| Tier | Model ID | Context window | Max output | Notes |
|---|---|---|---|---|
| Most capable (long-horizon agentic) | `claude-fable-5` | 1M tokens | 128K tokens | Thinking is always on (adaptive, cannot be disabled). $10/$50 per MTok. Requires 30-day data retention. |
| Flagship (agentic coding / enterprise) | `claude-opus-5` | 1M tokens | 128K tokens | Adaptive thinking on by default. $5/$25 per MTok. |
| Balanced (speed + intelligence) | `claude-sonnet-5` | 1M tokens | 128K tokens | $2/$10 per MTok. No mid-conversation system-message feature (Opus 5/4.8/Fable 5 only). |
| Fast/cheap | `claude-haiku-4-5` (dated: `claude-haiku-4-5-20251001`) | 200K tokens | 64K tokens | $1/$5 per MTok. Extended (manual budget) thinking only, no adaptive/effort control. |

Legacy models still served: Opus 4.8, 4.7, 4.6, 4.5; Sonnet 4.6, 4.5. Opus 4.6/Sonnet 4.6 also reach a 1M-token context window in beta. There is also an invite-only `claude-mythos-5` (Project Glasswing) with identical specs to Fable 5.

All current models accept text + image input and produce text output; all support tool use and vision natively — there is no separate "vision model."

### 1.2 Tool-calling / function-calling shape

Single endpoint: `POST /v1/messages`. Tools are declared as a top-level `tools` array:

```json
{
  "name": "get_weather",
  "description": "Get current weather for a location",
  "input_schema": { "type": "object", "properties": { "location": {"type": "string"} }, "required": ["location"] },
  "strict": true
}
```

`strict: true` is a **top-level field on the tool definition** (not on `tool_choice`) and guarantees the emitted `input` validates against the schema exactly (requires `additionalProperties: false` + `required`). When the model wants to call a tool, the response's `content` array contains a `tool_use` block (`{type: "tool_use", id, name, input}`) and `stop_reason` is `"tool_use"`. You continue the conversation by appending a `user` message containing one `tool_result` block per tool call (`{type: "tool_result", tool_use_id, content, is_error}`) — **all** results for one turn go in a single message; splitting them across messages degrades parallel tool use. Parallel tool calls (multiple `tool_use` blocks in one assistant turn) are on by default.

Anthropic also ships **server-side tools** that run on Anthropic's infrastructure with no client execution loop: web search, web fetch, code execution, computer use, memory. These are declared the same way in `tools` but return results inline without a round trip.

### 1.3 Streaming (SSE)

`"stream": true` on the same `/v1/messages` endpoint. Event sequence: `message_start` → repeating (`content_block_start` → one or more `content_block_delta` → `content_block_stop`) per content block → `message_delta` (carries incremental `stop_reason`/`usage`) → `message_stop`, with `ping` events interleaved as keepalives. Delta payload `type` varies by block: `text_delta`, `input_json_delta` (chunked partial JSON for tool-call arguments — only one key/value emitted at a time), `thinking_delta`, and a final `signature_delta` for thinking blocks. Example:

```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}
```

SDKs expose a higher-level `stream.text_stream` / `.on("text", ...)` and a `get_final_message()` / `.finalMessage()` helper that accumulates the full `Message` without hand-rolling event parsing. Streaming is required (not optional) once `max_tokens` gets large (~128K) to avoid client HTTP timeouts.

### 1.4 Vision / multimodal input

All current models (Fable 5, Opus 5, Sonnet 5, Haiku 4.5, and the whole 4.x line) accept image input (base64 or the Files API) as a `type: "image"` content block, and PDF documents up to 32MB / 600 pages (100 pages on 200K-context models) as `type: "document"`. Citations can be enabled per-document to get grounded excerpts back. No audio or video input on the Messages API.

### 1.5 Prompt caching

`cache_control: {type: "ephemeral"}` on a content block marks everything before it (in render order: `tools` → `system` → `messages`) as a cache breakpoint (max 4 per request). It is **prefix-based** — any byte change anywhere in the prefix invalidates everything after it. Minimum cacheable prefix is model-dependent (roughly 512–4096 tokens). Cache writes are billed at a premium; cache **reads** cost 10% of base input price, and — for most models — cached tokens do **not** count against your ITPM rate limit, making caching the single highest-leverage cost/throughput lever. Verify actual hit rate via `usage.cache_read_input_tokens` in the response, since a silent invalidator (timestamps in the system prompt, unsorted JSON, a changing tool list) will zero it out without erroring.

### 1.6 Structured output / JSON mode

`output_config: {format: {...}}` on `messages.create()` constrains the response to a JSON schema (the older top-level `output_format` parameter is deprecated). The recommended path is the SDK's `client.messages.parse()` helper, which validates the response against your schema automatically. This is separate from `strict: true` on tool definitions, which validates tool-call arguments rather than the final text response.

### 1.7 Rate limits

Anthropic uses a **token-bucket** algorithm (continuously replenished, not fixed-window) across three dimensions per model: **RPM** (requests/minute), **ITPM** (input tokens/minute), **OTPM** (output tokens/minute). Organizations sit in a usage tier (Evaluation → Start → Build → Scale → Custom) that is assigned automatically from spend/usage history and that also caps monthly spend ($500 / $1,000 / $200,000 / negotiated). Limits are returned as response headers — `anthropic-ratelimit-requests-limit/-remaining/-reset`, `anthropic-ratelimit-input-tokens-limit/-remaining/-reset`, `anthropic-ratelimit-output-tokens-limit/-remaining/-reset` — plus a `retry-after` header (seconds) on 429s. The Message Batches API has its own separate RPM + in-flight-queue-depth limits.

### 1.8 Official SDKs

Python (`anthropic`, PyPI), TypeScript/Node (`@anthropic-ai/sdk`, npm), plus first-party Go, Java, Ruby, PHP, and C# SDKs — all built around the same `messages.create()`/`messages.stream()` surface. A CLI (`ant`) also exists for scripting and OAuth-based auth. Auth is `x-api-key: <key>` + `anthropic-version: <date>` headers (or `Authorization: Bearer` for OAuth tokens, which additionally require an `anthropic-beta: oauth-2025-04-20` header).

---

## 2. OpenAI

Primary docs: [developers.openai.com/api/docs](https://developers.openai.com/api/docs) (the platform.openai.com docs domain now redirects here).

### 2.1 Model tiers (as of 2026-08-31)

OpenAI's current flagship generation is **GPT-5.6**, split into three named tiers rather than a single model with size suffixes:

| Tier | Model ID | Context window | Max output | Role |
|---|---|---|---|---|
| Flagship | `gpt-5.6-sol` | ~1.05M tokens | 128K tokens | Complex professional/agentic work |
| Balanced | `gpt-5.6-terra` | ~1.05M tokens | 128K tokens | Cost/intelligence balance |
| Cheap/fast | `gpt-5.6-luna` | ~1.05M tokens | 128K tokens | Cost-sensitive, high-volume workloads |

Prior generations remain callable and are still common in production: GPT-5.5 (1M context, $5/$30 per MTok), GPT-5.4 (400K context, $2.50/$15), GPT-5.2 (400K context, ~$0.875/$7, released Dec 2025). All flagship-family models take text + image input and multilingual text output. OpenAI publishes the authoritative live list at `/v1/models` and on the models doc page — pin exact IDs there rather than in this document, since tier names have already rotated at least once (5.2 → 5.4 → 5.5 → 5.6 across 2026).

### 2.2 Two request APIs — Responses vs. Chat Completions

OpenAI now maintains **two** parallel request shapes:

- **Responses API** (`POST /v1/responses`) — the current recommended surface for new integrations. Stateful-capable (`previous_response_id`), supports background/async execution with a cancel endpoint, and models tool calls as typed **items** in an output array rather than a single `tool_calls` field.
- **Chat Completions API** (`POST /v1/chat/completions`) — the older, still fully supported surface; most third-party tooling and OpenAI-compatible shims (used by other vendors) still target this shape.

**Tool-calling shape differs between the two:**

*Chat Completions:* request `tools: [{type: "function", function: {name, description, parameters}}]`; on a call, `choices[0].finish_reason === "tool_calls"` and `choices[0].message.tool_calls` is an array of `{id, type: "function", function: {name, arguments: "<JSON string>"}}`. You reply with a `role: "tool"` message per call, keyed by `tool_call_id`.

*Responses API:* request `tools: [{type: "function", name, description, parameters}]` (flatter — no nested `function` wrapper); the model emits `function_call` items (`{type: "function_call", call_id, name, arguments}`) directly in the output array alongside other item types (file search, web search, code interpreter, MCP, computer use, image generation, shell). You respond with `function_call_output` items keyed by `call_id`. The Responses API's tool surface is a superset — it natively models multi-step tool orchestration (nested tool calls, per-item `status`) that Chat Completions leaves to the caller.

`strict: true` on either surface enforces exact JSON-Schema compliance on tool call arguments (no hallucinated/missing keys).

### 2.3 Streaming (SSE)

Chat Completions streams token-level `choices[0].delta` chunks. The Responses API instead streams **typed semantic events** — `response.created`, `response.output_text.delta` (repeated), `response.function_call_arguments.delta` (repeated, for in-progress tool-call argument streaming), `response.completed`, and `error` — each with its own well-defined schema rather than a generic delta blob, so a consumer can `switch` on `event.type` and ignore what it doesn't need. Stream end is the `response.completed` event, not a `[DONE]` sentinel (Chat Completions still uses the `data: [DONE]` sentinel).

### 2.4 Vision / multimodal input

All GPT-5.x flagship-family models accept image input (`{type: "input_image", image_url}` on Responses / `{type: "image_url"}` on Chat Completions). Audio input/output is handled by a separate Realtime family (`gpt-realtime-*`), not the text Responses/Chat Completions path — out of scope here since it overlaps with the audio/video workstream.

### 2.5 Prompt caching

OpenAI's caching is **automatic and requires no request changes** — it activates for any prompt ≥1,024 tokens, with cache hits credited in 128-token increments, and can cut time-to-first-token by up to ~80% and cached-token input cost by up to ~90% with no extra fee. Cached prefixes persist roughly 5–10 minutes of inactivity (up to ~1 hour off-peak) and are evicted after 1 hour regardless. Caching only helps if repeated requests share an identical prefix and land on the same backend machine, so — as with Anthropic — stable content (system prompt, tool definitions) belongs first and volatile content (timestamps, per-request IDs) last. An optional `prompt_cache_key` lets you hint routing to improve cache-hit consistency. `usage.prompt_tokens_details.cached_tokens` (Responses: similar field) reports actual hits.

### 2.6 Structured output / JSON mode

Set `text: {format: {type: "json_schema", name, schema, strict: true}}` (Responses API). With `strict: true`, the response is guaranteed to validate against the supplied JSON Schema — no omitted required keys, no hallucinated enum values. SDK helpers surface this as `response.output_parsed` (vs. raw `output_text`). A safety refusal surfaces as a `refusal` field instead of schema-compliant content, so it's programmatically distinguishable from a normal response. Not all JSON Schema features are supported (e.g., some recursive-schema forms need specific syntax), and first use of a new schema incurs extra latency while it's compiled.

### 2.7 Rate limits

Five usage tiers gated by **cumulative spend** (not calendar time alone) — Tier 1 starts at $5 spent, Tier 5 requires $1,000 cumulative spend and 30 days since first payment. Limits are enforced on up to four dimensions depending on the model: RPM, TPM, RPD (requests/day), and TPD (tokens/day, some models). Communicated via `x-ratelimit-limit-*` / `x-ratelimit-remaining-*` response headers (per-dimension); a 429 carries `retry-after-ms`. The Batch API draws from a separate, much larger rate-limit pool.

### 2.8 Batch API

`POST /v1/batches` against a JSONL file (uploaded via the Files API) targeting one endpoint (`/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, or `/v1/completions`) per batch. Fixed 24-hour completion window, 50% discount on both input and output tokens, results keyed by your own `custom_id` (not returned in submission order).

### 2.9 Official SDKs

Python (`openai`, PyPI) and Node/TypeScript (`openai`, npm) are both first-party and cover both Responses and Chat Completions surfaces from the same client. Auth: `Authorization: Bearer <API_KEY>`, optionally with `OpenAI-Organization` and `OpenAI-Project` headers when a key spans multiple orgs/projects (most accounts now scope purely by project-level key instead).

---

## 3. Google — Gemini API and Vertex AI

Primary docs: [ai.google.dev/gemini-api/docs](https://ai.google.dev/gemini-api/docs) (Gemini Developer API) · [Vertex AI generative AI docs](https://docs.cloud.google.com/vertex-ai/generative-ai) (enterprise/GCP surface).

**Two Google surfaces, one model family.** The **Gemini Developer API** (`generativelanguage.googleapis.com`) is the low-friction path — API-key auth, meant for prototyping through medium production load. **Vertex AI** (`aiplatform.googleapis.com`) is the enterprise GCP surface — IAM/service-account auth, regional data residency, VPC controls, and SLAs, meant for regulated/enterprise workloads and for volume that outgrows the Developer API's quotas. Since Gemini 2.0, Google ships a single **unified SDK** (`google-genai`) that talks to either backend via one constructor flag — see §3.7 — so an adapter for our platform should target this one SDK rather than the two legacy SDKs it replaced (`google-generativeai` for the Developer API, `google-cloud-aiplatform` for Vertex).

### 3.1 Model tiers (as of 2026-08-31)

| Tier | Model ID | Context window | Max output | Notes |
|---|---|---|---|---|
| Flagship reasoning | `gemini-3.1-pro-preview` | 1M tokens | 64K tokens | "Most advanced reasoning" tier; still in preview naming despite broad use |
| Fast/capable | `gemini-3.7-flash` | 1M tokens | 64K tokens | Latest GA Flash; built for coding/agentic workflows |
| Fast/capable (prior) | `gemini-3.6-flash`, `gemini-3.5-flash` | 1M tokens | ~64–65K tokens | Still GA, still served |
| Cheap/fast | `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` | 1M tokens | — | Lowest cost/latency tier in the 3.x line |
| Legacy (still served) | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` | up to 1M tokens | varies | Kept for compatibility; 2.x is the previous generation |

All Gemini 3.x models are multimodal by default (text, image, audio, video, PDF, and — per Google's own framing — "entire code repositories" within the 1M-token window) and use **dynamic ("thinking") reasoning by default**, tunable via `thinking_level` (`minimal`/`low`/`medium`/`high`).

### 3.2 A second API surface within Gemini itself: Interactions API vs. `generateContent`

This is a 2026-specific wrinkle worth flagging explicitly for adapter design: Google shipped a **new Interactions API** (GA since roughly June 2026) that is now the *recommended* interface for all new Gemini projects, sitting alongside the older `generateContent`/`streamGenerateContent` endpoints, which continue to be fully supported but are now framed as "legacy."

- **`generateContent` / `streamGenerateContent`** (legacy, still fully supported): single call/response pattern; `Content`/`Part` message shape; `functionCall`/`functionResponse` parts for tool use; server-side tools (Search grounding, code execution) are largely opaque — you get a final answer plus a separate `groundingMetadata` block.
- **Interactions API** (GA, recommended for new work): designed for agentic/multi-turn workflows as the *default* case rather than the exception. Supports optional server-side conversation state via `previous_interaction_id` (so you don't have to resend full history), observable typed execution **steps** (useful for debugging and streaming intermediate UI state), and background execution for long-running tasks. Its tool-call shape is closer to OpenAI's Responses API than to classic Gemini: `function_call` / `function_result` step types keyed by `call_id`, rather than `functionCall`/`functionResponse` parts.

Google's own guidance is that frontier agentic capabilities will increasingly land on the Interactions API only going forward. **Recommendation for our adapter design (elaborated in `12_MODEL_ROUTING.md`):** build the Google adapter against `generateContent`/`streamGenerateContent` first for stability and broadest documentation coverage today, but track the Interactions API as the near-term migration target — its `previous_interaction_id` state and typed steps map unusually well onto a model-agnostic conversation abstraction.

### 3.3 Tool-calling / function-calling shape (`generateContent`)

Tools are declared as `tools: [{function_declarations: [{name, description, parameters}]}]`, where `parameters` is a constrained JSON-Schema subset. When the model wants to call a function, the response content includes a `Part` of the form `{"functionCall": {"name": "...", "args": {...}}}`. You reply with a new turn containing a `Part` of the form `{"functionResponse": {"name": "...", "response": {...}}}`. **Parallel function calling is natively supported** — a single response can include multiple `functionCall` parts to be executed concurrently. (The newer Interactions API instead uses `function_call`/`function_result` step objects with explicit `call_id` — see §3.2.)

### 3.4 Streaming (SSE)

`streamGenerateContent?alt=sse` streams a sequence of `GenerateContentResponse` JSON chunks over SSE; each chunk carries incremental `candidates[].content.parts`. SDKs expose this as an async iterator yielding chunk objects with a convenience `.text` accessor. There is no separate typed-event taxonomy the way Anthropic and OpenAI's Responses API have — you inspect the same `GenerateContentResponse` shape on every chunk as it fills in incrementally.

### 3.5 Vision / multimodal input

Native and default across the Gemini 3.x line: text, inline-base64 images (`inline_data`), file-referenced images/video/audio/PDF (`file_data`, typically via the Files API for anything large), all within the same 1M-token context budget. This is the strongest built-in multimodal input story of the three providers — video and long-document input are first-class, not bolted on.

### 3.6 Prompt / context caching

Two mechanisms:

- **Implicit caching** — on by default for Gemini 2.5+ and all 3.x models, no configuration required, savings passed through automatically. Minimum prompt size to activate: 2,048 tokens (Gemini 2.5 models) or 4,096 tokens (Gemini 3.x models). Check `usage.total_cached_tokens` in the response to confirm hits.
- **Explicit caching** — manually created, named cache objects with a configurable TTL, useful for content you know will be reused deliberately (e.g., a large document loaded once, queried many times) rather than relying on incidental prefix reuse. **Not available on the new Interactions API**, which supports implicit caching only — another point in favor of building against `generateContent` where deliberate cache control matters.

Cache and batch discounts do not stack — the ~90% implicit-cache discount takes precedence over the batch discount when both would otherwise apply.

### 3.7 Structured output / JSON mode

`generationConfig: {responseMimeType: "application/json", responseSchema: {...}}` on `generateContent` constrains output to a JSON Schema–like structure (`type`/`properties`/`required`). Gemini 3 models additionally allow combining Structured Outputs *with* built-in tools (Search grounding, URL context, code execution) in the same call and with custom function calling — a combination Anthropic and OpenAI handle less directly.

### 3.8 Rate limits

Both surfaces enforce RPM/TPM-style quotas, but the mechanics and communication differ from Anthropic/OpenAI:

- **Gemini Developer API**: per-project, per-model quotas (free tier vs. pay-as-you-go tier), visible in Google AI Studio / Cloud Console rather than through a single standardized set of response headers; a quota breach returns HTTP 429.
- **Vertex AI**: standard GCP quota system — per-project, per-region, per-model quotas managed and requestable through Cloud Console/`gcloud`, alongside GCP's org-wide IAM and billing controls.

Net effect for our platform: Google is the *least* uniform of the three on rate-limit introspection — plan to poll/parse 429s and Cloud Monitoring quota metrics rather than relying on rich per-request headers the way Anthropic's `anthropic-ratelimit-*` or OpenAI's `x-ratelimit-*` headers allow.

### 3.9 Batch API

Both surfaces offer batch/async inference at a 50% discount vs. synchronous pricing: **Gemini API Batch Mode** (submit, offload scheduling, results within 24 hours) and **Vertex AI batch prediction** (job-based, same discount, GCP-native tooling). Higher rate-limit headroom applies to batch traffic on both.

### 3.10 Official SDKs

Unified **Google Gen AI SDK**: Python (`google-genai`, PyPI) and Node/TypeScript (`@google/genai`, npm), both GA and the officially recommended path for new code on *either* backend. Construct with `vertexai=True, project=..., location=...` to target Vertex AI, or with an API key (`GEMINI_API_KEY`/`GOOGLE_API_KEY`) to target the Developer API — same client surface either way. Older packages (`google-generativeai` for Python, `@google/generative-ai` for Node, `google-cloud-aiplatform` for Vertex-only Python) are legacy/being phased out; do not target them for new adapter code.

---

## 4. Embeddings (brief)

Only Anthropic lacks a first-party embeddings model:

| Provider | Embeddings story |
|---|---|
| Anthropic | **No native embeddings API.** Official recommendation is a third-party provider — Voyage AI is Anthropic's named partner (e.g., `voyage-3-large`). |
| OpenAI | `text-embedding-3-small` and `text-embedding-3-large` (up to 3,072 dimensions), same `/v1/embeddings` endpoint family used by the Batch API. |
| Google | `gemini-embedding-2` (released ~March 2026) — multimodal (text/image/video/audio into one vector space); legacy `text-embedding-005` still served and is the cheapest per-token option of the three providers. |

Since our platform targets Anthropic as one of three adapters, any RAG/embedding pipeline needs an embeddings source independent of the "current" chat model provider for that request — this has architectural implications (see `12_MODEL_ROUTING.md` §2, CapabilityRegistry) but is not itself an LLM adapter.

---

## 5. Comparison table

| | **Anthropic (Claude)** | **OpenAI** | **Google (Gemini API / Vertex AI)** |
|---|---|---|---|
| Flagship model (2026-08-31) | `claude-opus-5` (or `claude-fable-5` for max capability) | `gpt-5.6-sol` | `gemini-3.1-pro-preview` |
| Fast/cheap tier | `claude-haiku-4-5` | `gpt-5.6-luna` | `gemini-3.5-flash-lite` |
| Largest context window | 1M tokens | ~1.05M tokens | 1M tokens |
| Max output tokens | 128K (300K on Batch API w/ beta header) | 128K | 64K |
| Tool-call response shape | `tool_use` content block in `content[]` | `tool_calls` on message (Chat Completions) or `function_call` item (Responses) | `functionCall` part (`generateContent`) or `function_call` step (Interactions API) |
| Streaming protocol | SSE, typed `content_block_delta` events | SSE, typed `response.*` events (Responses) or raw delta chunks (Chat Completions) | SSE (`alt=sse`), repeated full-shape `GenerateContentResponse` chunks |
| Vision input | Yes, all current models | Yes, all current models | Yes, all current models (+ native video/audio, strongest multimodal input) |
| Prompt caching | Explicit breakpoints (`cache_control`), prefix-based, reads at 10% price | Fully automatic, ≥1024 tokens, no code change | Implicit (automatic) + explicit (named, TTL) caching |
| Structured output | `output_config.format` JSON schema | `text.format` JSON schema + `strict: true` | `responseSchema` + `responseMimeType: application/json` |
| Rate-limit signaling | Rich per-dimension response headers (`anthropic-ratelimit-*`) | Rich per-dimension response headers (`x-ratelimit-*`) | Cloud Console / quota metrics; least header-driven of the three |
| Batch API | Message Batches API, 50% off, async | Batch API, 50% off, 24h window | Batch Mode (Gemini API) / batch prediction (Vertex), 50% off |
| Node/TS SDK | `@anthropic-ai/sdk` | `openai` | `@google/genai` |
| Python SDK | `anthropic` | `openai` | `google-genai` |
| Embeddings | None (use Voyage AI) | `text-embedding-3-*` | `gemini-embedding-2`, `text-embedding-005` |

---

## 6. Key architectural implications for adapter design

1. **Tool-call shape is the biggest normalization burden.** All three represent "the model wants to call a function" differently in the response body (a typed content block vs. a `tool_calls` array vs. a `functionCall` part), and Google alone has *two* incompatible shapes across its own two API surfaces. See `12_MODEL_ROUTING.md` §1 for the normalized internal schema.
2. **Prompt caching semantics are not interchangeable.** Anthropic requires explicit `cache_control` breakpoints and rewards you with rate-limit relief; OpenAI is fully automatic with no rate-limit interaction; Google splits into implicit (automatic) and explicit (manual, TTL-based) modes, and the newer Interactions API drops explicit caching entirely. A "use caching" platform feature cannot be a single boolean — see the CapabilityRegistry design.
3. **Rate-limit observability is uneven.** Anthropic and OpenAI both return rich per-dimension headers usable for adaptive client-side throttling; Google's Gemini Developer API and Vertex AI expose quota primarily through Cloud Console/monitoring rather than response headers, so our router needs a fallback strategy (conservative static budgets + reactive 429 backoff) for Google specifically.
4. **Google is mid-migration.** The Interactions API is GA and recommended, but `generateContent` is better documented today and is what most third-party tooling and the current Vertex AI docs target. Building the first adapter version against `generateContent` and planning a follow-up migration is lower-risk than chasing the newest surface immediately.
5. **Context windows have converged** (~1M tokens across all three flagship/mid tiers), so context-length-based routing decisions will increasingly hinge on *output* token limits (128K for Anthropic/OpenAI vs. 64K for Gemini) and cost, not input window size.

---

*All figures above were verified against the official docs cited in each section on 2026-08-31. Re-check before hardcoding model IDs into configuration — every provider has already renamed or added tiers multiple times within 2026.*
