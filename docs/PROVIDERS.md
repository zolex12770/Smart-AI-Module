# Providers

Every AI capability sits behind an interface, and every interface has at least one
implementation that runs on your own machine. Nothing here requires a hosted AI account.

**Mocks are opt-in.** A deterministic mock exists for chat, images and video so tests and the
browser E2E suite can drive the UI without a model. It is registered only when
`ALLOW_MOCK_PROVIDERS=true`, which production refuses at boot (ADR-013). With it off (the default
everywhere), an unconfigured capability reports itself unavailable, and the UI and API say so.
Nothing falls back to fake output.

## Language models

| Provider | How it is selected | Verified here |
|---|---|---|
| **Self-hosted OpenAI-compatible** (Ollama, vLLM, llama.cpp server, LM Studio, any `/v1` gateway) | `LLM_BASE_URL` + `LLM_MODEL`; in development, a running Ollama is also **auto-detected** (never in production) | **Yes**: qwen2.5:7b on Ollama 0.34, CPU only, chat, streaming, tool calls, RAG, memory, the coding agent |
| Anthropic | `ANTHROPIC_API_KEY` | Fixture tests against recorded wire shapes; no key in this environment |
| OpenAI | `OPENAI_API_KEY` | Same |
| Google Gemini (Developer API) | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | Same |
| Mock | `ALLOW_MOCK_PROVIDERS=true` (tests only) | n/a: never serves users |

### The context window matters for a local model

Ollama serves **4096 tokens** unless `OLLAMA_CONTEXT_LENGTH` says otherwise. A longer prompt is not
refused; llama.cpp's context shift silently discards its oldest tokens (the system prompt and the
task). This was observed in a real agent run. The platform now:

- reads the window the runtime actually serves: `/api/ps`'s `context_length` for a loaded model,
  else `OLLAMA_CONTEXT_LENGTH`, else 4096, never the model's trained maximum;
- keeps every agent prompt inside it (`fitToContextWindow`). Old tool output is elided first, then
  the newest is cut to head and tail. If it still cannot fit, the run fails with a message naming
  the window, rather than running on a truncated prompt.

Run Ollama with a larger window when you can (`docker-compose.yml` uses 16384; qwen2.5 supports
32768), and set `LLM_CONTEXT_WINDOW` to match when `LLM_BASE_URL` is set explicitly.

### Resilience (all providers, `backend/packages/model-router`)

- **Retry with backoff** on 408/429/5xx and network errors, honouring `Retry-After`.
- **Circuit breaker**: a provider that keeps failing is skipped for a cool-down.
- **Fallback** to another *real* provider only. A mock is never a fallback target (ADR-163).
- **Cancellation**: an aborted request aborts the provider call (verified live: the model stops
  generating when the browser disconnects).
- **Truthful endings**: a stream that ends without a completion event, or ends on `length`, is
  reported as such, never as a finished answer.

### Tool calling

Tools reach the model as the provider's native tool schema. Arguments are validated against each
tool's JSON Schema before anything runs; a hallucinated tool name goes through the registry so it
is audited (ADR-159). Verified with qwen2.5:7b issuing real `tool_calls` through Ollama's
OpenAI-compatible endpoint.

A local model sometimes writes a call as **text** (a malformed `<tool_call>` block the runtime
passes through as content). When a turn has no structured call, a well-formed
`{"name": ..., "arguments": {...}}` naming a tool offered in that turn is recovered and runs through
the same validation, approval and audit path. Anything else stays an answer (`text-tool-call.ts`).

### JSON output

`ChatRequest.responseFormat: "json_object"` asks for syntactically valid JSON where the provider can
guarantee it: `response_format` on Ollama, vLLM and llama.cpp (grammar-constrained), `text.format`
on the OpenAI Responses API, `responseMimeType` on Gemini. Anthropic has no equivalent, so it is
ignored there. The video storyboard and memory extraction use it, and still validate the shape of
what comes back.

## Embeddings

| Provider | Selection | Verified here |
|---|---|---|
| OpenAI-compatible `/v1/embeddings` | `EMBEDDING_BASE_URL` + `EMBEDDING_MODEL`, or detected with the chat runtime | **Yes**: nomic-embed-text (768 dimensions) on Ollama |
| Lexical hash embedder | when no semantic model is configured | Deterministic word-overlap vectors, logged at boot as **not semantic** |

## Speech

| Provider | Selection | Verified here |
|---|---|---|
| **Piper** (offline neural TTS, Linux/macOS/Windows) | `SPEECH_PROVIDER=piper`, `PIPER_PATH`, `PIPER_VOICE` | **Yes**: 16 kHz PCM WAV through `POST /api/v1/audio` |
| OpenAI-compatible `/v1/audio/speech` (OpenAI, Kokoro-FastAPI, LocalAI…) | `SPEECH_PROVIDER=openai`, `SPEECH_BASE_URL`, `SPEECH_MODEL` | Fixture tests |
| Windows SAPI | `SPEECH_PROVIDER=sapi` | Windows only |

The API image ships Piper and one voice (see `docker/README.md` for where the voice comes from).

## Images and video

See [MEDIA.md](MEDIA.md).
