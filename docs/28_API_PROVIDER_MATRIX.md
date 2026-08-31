# API Provider Matrix: Anthropic vs OpenAI vs Google

Quick-reference table for adapter implementation. Facts verified against official docs as of **2026-08-31** — re-check before hardcoding, this space moves fast. Sources: `04_MODEL_PROVIDER_RESEARCH.md` (full detail + citations), [platform.claude.com/docs](https://platform.claude.com/docs), [developers.openai.com/api/docs](https://developers.openai.com/api/docs), [ai.google.dev/gemini-api/docs](https://ai.google.dev/gemini-api/docs).

---

## Core comparison

| | **Anthropic (Claude)** | **OpenAI** | **Google — Gemini API** | **Google — Vertex AI** |
|---|---|---|---|---|
| **Auth method** | API key header, or OAuth Bearer token | API key Bearer token, optional org/project headers | API key (header or query param) | GCP IAM / service-account ADC (no API key) |
| **Auth header(s)** | `x-api-key: <key>` + `anthropic-version: <date>` | `Authorization: Bearer <key>` (+ optional `OpenAI-Organization`, `OpenAI-Project`) | `x-goog-api-key: <key>` (or `?key=` query param) | `Authorization: Bearer <ADC access token>` (auto-managed by SDK/gcloud) |
| **Base URL pattern** | `https://api.anthropic.com/v1/` | `https://api.openai.com/v1/` | `https://generativelanguage.googleapis.com/v1beta/` | `https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/google/models/{model}` |
| **Primary endpoint** | `POST /v1/messages` | `POST /v1/responses` (current) or `POST /v1/chat/completions` (legacy, still supported) | `POST /v1beta/models/{model}:generateContent` (legacy path, still supported) or the newer Interactions API | `...models/{model}:generateContent` / `:streamGenerateContent` (via publisher-model path) |
| **Tool-calling schema shape** | `tools[].input_schema`; response `content[]` has `{type:"tool_use", id, name, input}`; you send back `{type:"tool_result", tool_use_id, content}` | Chat Completions: `tools[].function.{name,parameters}` → `message.tool_calls[].function.{name, arguments: string}`. Responses: `tools[].{name,parameters}` (flatter) → `function_call` output item with `call_id` | `tools[].function_declarations[].{name,parameters}` → response `Part.functionCall.{name,args}`; you send `Part.functionResponse` | Same shape as Gemini API `generateContent` |
| **Streaming protocol** | SSE, typed micro-events (`message_start`, `content_block_delta` w/ `text_delta`/`input_json_delta`, `message_stop`, ...) | Responses: SSE typed events (`response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`). Chat Completions: SSE raw delta chunks, ends with `data: [DONE]` | SSE via `?alt=sse`; each event is a full growing `GenerateContentResponse` chunk (no typed micro-events) | Same as Gemini API |
| **Max context (flagship, 2026-08-31)** | 1M tokens (Opus 5 / Sonnet 5 / Fable 5); 200K (Haiku 4.5) | ~1.05M tokens (GPT-5.6 family); 1M (GPT-5.5); 400K (GPT-5.4/5.2) | 1M tokens (Gemini 3.x line) | 1M tokens (same models as Gemini API) |
| **Max output tokens** | 128K (300K on Batch API w/ `output-300k-2026-03-24` beta header) | 128K | 64K | 64K |
| **Vision support** | Yes, all current models (image + PDF document input) | Yes, all current flagship-family models (image input) | Yes, all current models — plus native video and audio input (strongest multimodal input of the three) | Same as Gemini API |
| **Prompt caching** | Explicit, prefix-based `cache_control: {type:"ephemeral"}` breakpoints (max 4/request); cache reads billed at 10% of input price; cached tokens excluded from ITPM rate limit (most models) | Fully automatic for prompts ≥1,024 tokens, no code change, no extra fee; ~5–10 min idle TTL (up to ~1hr off-peak) | Implicit (automatic, on by default, min 2K/4K tokens) **and** explicit (named cache object, configurable TTL) — explicit caching not available on the newer Interactions API | Same as Gemini API |
| **Structured output / JSON mode** | `output_config.format` (JSON schema); `client.messages.parse()` SDK helper | `text.format: {type:"json_schema", schema, strict:true}` (Responses); `strict:true` guarantees schema compliance | `generationConfig.responseSchema` + `responseMimeType: "application/json"`; combinable with built-in tools on Gemini 3 | Same as Gemini API |
| **Batch API availability** | Yes — Message Batches API, 50% discount, async, results any order (keyed by `custom_id`) | Yes — `/v1/batches`, JSONL via Files API, 24h window, 50% discount | Yes — Batch Mode, 50% discount, ~24h turnaround | Yes — Vertex AI batch prediction, 50% discount, job-based |
| **Official Node.js/TS SDK package** | `@anthropic-ai/sdk` | `openai` | `@google/genai` (unified — same package for both backends) | `@google/genai` (pass Vertex config) |
| **Official Python SDK package** | `anthropic` | `openai` | `google-genai` (unified — same package for both backends) | `google-genai` (`Client(vertexai=True, project=..., location=...)`) |
| **Rate-limit signaling** | Rich response headers: `anthropic-ratelimit-{requests,input-tokens,output-tokens}-{limit,remaining,reset}` + `retry-after` on 429 | Response headers: `x-ratelimit-{limit,remaining}-{requests,tokens}` + `retry-after-ms` on 429 | Per-project/per-model quota, primarily visible via Cloud Console / AI Studio, not a rich header set; 429 on breach | GCP quota system (Cloud Console/`gcloud`), same low header visibility as Gemini API |
| **Recommended env var(s) for our platform config** | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` (optionally `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`) | `GOOGLE_API_KEY` (alias `GEMINI_API_KEY` accepted by SDK) | `GOOGLE_APPLICATION_CREDENTIALS` (path to service-account JSON) + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` |

---

## Recommended environment variable set for platform config

Use provider-prefixed names consistently so the adapter layer can resolve credentials without special-casing:

```
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_ORG_ID=org-...           # optional, only needed for multi-org accounts
OPENAI_PROJECT_ID=proj_...      # optional, only needed for multi-project keys

# Google — Gemini Developer API path (API-key auth)
GOOGLE_API_KEY=...              # SDK also accepts GEMINI_API_KEY as an alias

# Google — Vertex AI path (GCP ADC auth; use instead of / in addition to GOOGLE_API_KEY)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GOOGLE_CLOUD_PROJECT=my-gcp-project
GOOGLE_CLOUD_LOCATION=us-central1   # or "global" per Google's current recommendation

# Platform-level (not provider-specific)
MODEL_ROUTER_DEFAULT_PROVIDER=anthropic   # tie-break / preference when routing is otherwise neutral
```

Notes:
- The Google SDK (`google-genai`) picks Vertex vs. Gemini Developer API based on which credentials/flags are passed at client construction (`vertexai=True` + project/location vs. an API key) — our config loader should treat `GOOGLE_APPLICATION_CREDENTIALS` present as the signal to construct a Vertex-mode client, falling back to `GOOGLE_API_KEY`/`GEMINI_API_KEY` for Developer-API mode. Don't require both; support either.
- No API keys are configured yet in this project (research/architecture phase only) — this table defines the *names* the config loader should expect, not live credentials.

---

## Notable asymmetries to design around

- **Google runs two incompatible tool-call shapes internally** (`generateContent`'s `functionCall`/`functionResponse` parts vs. the newer Interactions API's `function_call`/`function_result` steps with `call_id`) — pick one per `12_MODEL_ROUTING.md` §3.2 (recommendation: build against `generateContent` first).
- **OpenAI runs two incompatible request APIs** (Responses vs. Chat Completions) with different tool-call and streaming shapes; target Responses for new adapter work, since it's the forward-looking surface and its typed streaming events are cheaper to normalize than Chat Completions' raw delta chunks.
- **Only Anthropic's caching interacts with rate limits** (cached tokens excluded from ITPM) — this makes Anthropic's effective throughput ceiling higher than its published limits suggest for well-cached workloads, unlike OpenAI or Google.
- **Only Google lacks first-class rate-limit response headers** — plan on quota polling / 429-driven backoff as the primary signal for that adapter, not proactive header-based throttling.
- **Anthropic has no first-party embeddings model** — any embeddings need routes to a different provider entirely (OpenAI `text-embedding-3-*`, Google `gemini-embedding-2`, or the Anthropic-recommended third party, Voyage AI), independent of which provider serves the chat/completion request.
