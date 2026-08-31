# Image Generation API Research

> Research date: **2026-08-31**. This space moves fast — prices, model names, and even
> whether a company has a public API at all can change within weeks. Every claim below
> is sourced; re-verify against the vendor's own docs before wiring in a real key, and
> treat anything without an official-docs source as directional, not exact.
>
> Purpose: this document surveys the current text-to-image landscape so the platform's
> `ImageProvider` interface (defined at the end) can be designed against the real shape
> of these APIs, not a guess. We ship with a **mock provider only** at first; this
> research exists so that swapping in a real provider later requires an adapter, not a
> redesign.

## 1. Landscape summary

| Provider | Model(s) | API shape | Typical latency | Fast/low-latency tier? | Pricing shape |
|---|---|---|---|---|---|
| OpenAI | `gpt-image-1`, `gpt-image-1.5`, `gpt-image-1-mini`, `dall-e-2` (legacy, variations only) | Synchronous REST (`POST /v1/images/generations`, `/edits`, `/variations`) | ~5–20s depending on `quality` | Yes — `quality: "low"` | Token-metered: separate $/1M for text-in, image-in, image-out tokens |
| Google (Imagen 4 family) | `imagen-4.0-{fast,standard,ultra}-generate` | Synchronous REST `predict` call, via Gemini API or Vertex AI | ~2.7s (Fast) to 10s+ (Ultra) | Yes — **Imagen 4 Fast** is an explicit named tier | Flat price per image, tiered by variant |
| Google (Gemini native image, "Nano Banana" / "Nano Banana Pro") | `gemini-2.5-flash-image`, newer Gemini 3 image variants | Synchronous REST `generateContent` (conversational, multi-turn edit in the same call shape as text chat) | Few seconds | Yes — the non-Pro "Nano Banana" tier is the fast/cheap option | Per-output-token (image output billed as tokens, translated to $/image) |
| Stability AI | Stable Image Ultra / Core / Diffusion 3.5 (+ a 9-tool editing suite) | Mostly synchronous `multipart/form-data` POST returning image bytes directly (v2beta); a few heavier tools (e.g. Creative Upscale) are async with an id-and-poll pattern | Seconds (Core faster than Ultra) | Yes — **Stable Image Core** is the fast/cheap tier vs. Ultra | Credit-based (1 credit = $0.01), flat credits per call by tool/tier |
| Black Forest Labs (FLUX) | FLUX.2 Klein 4B/9B, Flex, Pro, Max; FLUX Kontext (editing) | **Asynchronous**: submit → request id → poll a result endpoint | Klein: sub-second to a few seconds; Pro/Max: several seconds to tens of seconds | Yes — the Klein/"schnell"-class models are explicitly the low-latency tier | Megapixel-based: a base price for the first MP plus an incremental per-extra-MP rate |
| Replicate | Aggregator — hosts FLUX, SDXL, Imagen-family ports, and hundreds of others behind one API shape | Asynchronous: `POST /v1/predictions` → prediction id (`starting`/`processing`/`succeeded`/`failed`) → poll `GET /v1/predictions/{id}` or webhook | Highly variable — cold start 10–60s if the model isn't warm, otherwise a few seconds | Depends on the underlying model chosen (many FLUX-schnell-class options available) | Either per-second hardware billing (GPU-tier rate card: CPU/T4/A100/H100) or a flat per-output price set by the model's author |
| Midjourney | v7/v8 | **No official public API** as of this research date. Discord bot and midjourney.com web app are the only sanctioned surfaces. An "Enterprise API" exists only behind a gated application process with no published general-availability docs. | n/a | n/a | Flat monthly subscription tiers, not usage-metered |

**Design implication:** three of six real providers surveyed (OpenAI, Google's two families,
Stability) return a **synchronous** HTTP response, while two (FLUX, Replicate) are **natively
async job-based**, and Midjourney has no real API at all. A model-agnostic interface cannot
assume synchronicity — it must always wrap every call (even the "sync" ones) in the platform's
internal async job envelope (see `07_LONG_RUNNING_JOB_ARCHITECTURE.md`), because a "few seconds"
synchronous HTTP call is still too slow to hold open inside a normal request/response cycle at
any real concurrency, and because the async providers require it structurally anyway. Treating
everything as async from day one avoids a redesign when a sync provider is swapped for an async
one, or vice versa.

## 2. Provider detail

### 2.1 OpenAI — `gpt-image-1` / `gpt-image-1.5`

- **Endpoints**: `POST /v1/images/generations` (text-to-image), `POST /v1/images/edits`
  (inpainting/instruction-based editing, up to 16 reference/source images per request),
  `POST /v1/images/variations` (legacy, `dall-e-2` only — the newer `gpt-image-1` family does
  **not** support the variations endpoint).
- **Key parameters**: `prompt`, `model`, `n` (up to 10 images per call), `size`/aspect ratio
  (`gpt-image-1` supports 1:1, 3:2, 2:3), `quality` (`low`/`medium`/`high`/`auto` — this is
  the fast-vs-quality knob), `background` (`transparent`/`opaque`/`auto`), `moderation`
  (`auto`/`low`), `output_format` (`png`/`jpeg`/`webp`) and `output_compression`.
- **Mask-based editing**: the `edits` endpoint accepts a `mask` PNG (same dimensions as the
  source image, fully-transparent alpha = editable region) to constrain an edit to a region;
  in practice, some developers report `gpt-image-1` editing more of the frame than the mask
  strictly implies — treat masked editing as "mostly respected," not guaranteed pixel-exact.
- **No public seed parameter** for `gpt-image-1` — determinism/reproducibility is not exposed
  the way it is on Stability or FLUX.
- **Output delivery**: base64-encoded bytes or a short-lived URL in the JSON response body.
- **Pricing shape**: token-metered — ~$5/1M text-input tokens, ~$10/1M image-input tokens,
  ~$40/1M image-output tokens, which in practice works out to roughly $0.02 / $0.07 / $0.19
  per generated square image at low/medium/high quality.

### 2.2 Google — Imagen 4 family (Gemini API & Vertex AI)

- Google actually ships **two distinct image-generation surfaces** that a provider-agnostic
  design needs to treat as different capability profiles even though both come from Google:
  1. **Imagen 4** (`imagen-4.0-generate-001` and the `-fast`/`-ultra` variants) — a dedicated
     image model reached via a `predict`-style call on both the Gemini API and Vertex AI.
  2. **Gemini native image output** ("Nano Banana" / "Nano Banana Pro", built on
     `gemini-2.5-flash-image` and newer Gemini 3 variants) — multimodal `generateContent`
     calls where the model can *also* return image parts, enabling conversational, multi-turn
     editing ("now make the sky orange") in the same call shape used for text chat.
- **Imagen 4 parameters**: `prompt`, `numberOfImages`, `aspectRatio` (1:1, 3:4, 4:3, 9:16,
  16:9), `personGeneration`, `safetyFilterLevel`, `addWatermark` (Google's SynthID
  watermark — `seed` is only honored when the watermark is disabled, since a deterministic
  seed and an invisible randomized watermark are mutually exclusive), and (on some versions)
  `negativePrompt`. Max native resolution is 2K (2048×2048) on Imagen 4 Ultra.
- **Editing**: Imagen exposes a separate capability/edit endpoint supporting mask-based
  inpainting/outpainting; Gemini native image supports free-form conversational editing by
  just sending the prior image plus a new instruction in the same chat-style request.
- **Fast tier**: **Imagen 4 Fast** is an explicit, named low-latency/low-cost tier (~2.7s
  generation, ~$0.02/image) vs. Standard (~$0.04) and Ultra (~$0.06, highest fidelity,
  slowest). Nano Banana (non-Pro) plays a similar fast/cheap role in the Gemini-native family.
- **Pricing shape**: Imagen 4 is flat-per-image, tiered by variant. Gemini-native image output
  is billed as output tokens (~$60/1M output tokens), which resolves to a per-image cost that
  varies with resolution since different resolutions consume different token counts (~$0.067
  per image cited for one Nano Banana tier at the time of research).

### 2.3 Stability AI — Stable Image Ultra / Core / Diffusion 3.5

- **API version**: REST `v2beta`, described by Stability as where active feature development
  happens. Requests are `multipart/form-data` POSTs; the Core/Ultra/SD3.5 generation
  endpoints return image bytes **directly in the response** (synchronous), which is unusual
  among the providers surveyed — most heavier tools (e.g., Creative Upscale) instead return a
  generation id you poll.
- **Key parameters**: `prompt`, `negative_prompt`, `aspect_ratio`, `seed` (deterministic,
  fully supported), `output_format`, `style_preset`, `cfg_scale` (SD3.5-class models),
  `strength` (image-to-image denoise strength).
- **Editing/variation suite is unusually broad** for a single vendor — nine distinct
  edit/control tools are exposed as API services: **Inpaint**, **Erase Object**, **Remove
  Background**, **Search and Replace**, **Search and Recolor** (recolor without needing a
  manual mask — the model segments the target object itself), **Outpaint**,
  **Replace-Background-and-Relight**, and two ControlNet-style **Control** tools
  (**Control Structure** for style transfer that preserves geometry, **Control Sketch** for
  sketch-to-image).
- **Pricing shape**: credit-based, 1 credit = $0.01. Stable Image Core is priced around 3
  credits/call (~$0.03); Ultra is materially more expensive per call. **Failed generations
  are not billed** — a useful trait to mirror in the platform's own cost-tracking (don't debit
  a user's quota for a job the provider itself failed).
- **Fast tier**: Core is explicitly the faster/cheaper option relative to Ultra.

### 2.4 Black Forest Labs — FLUX (FLUX.2 family + FLUX Kontext)

- **API shape is asynchronous**: `POST` a generation request to a model endpoint (e.g.
  `flux-2-pro`, `flux-2-pro-preview` for BFL's latest unpinned improvements vs. a fixed
  snapshot for reproducible workflows), receive a request id / polling URL back, then `GET`
  the result endpoint until the image is ready.
- **Key parameters**: `prompt`, `width`/`height` (or `aspect_ratio`), `seed` (fully
  supported, deterministic), `steps`, `guidance`/`cfg`, `safety_tolerance`,
  `output_format`, `prompt_upsampling`.
- **FLUX Kontext** is the editing/image-to-image line — takes a source image plus a text
  instruction and supports iterative, multi-turn editing while trying to preserve
  non-edited regions and character identity, similar in spirit to Gemini's conversational
  editing.
- **Fast tier**: the **Klein** line (4B/9B parameters) is explicitly BFL's fast, cheap,
  low-latency tier — sub-second to a few seconds on optimized inference backends — with
  Flex/Pro/Max trading latency for quality.
- **Pricing shape**: megapixel-based — a base rate for the first megapixel plus an
  incremental rate per additional megapixel, e.g. (as observed at research time) Klein 4B
  ≈$0.014, Klein 9B ≈$0.015, Pro ≈$0.03, Flex ≈$0.05, Max ≈$0.07 for a roughly 1MP image.

### 2.5 Replicate — aggregator, not a single model

- Replicate is architecturally interesting for this project specifically because it is
  **itself already a provider-agnostic layer**: one API shape (`predictions`) fronts
  hundreds of different image (and video) models, including FLUX, SDXL, and various
  research/open-weight ports of techniques resembling Imagen.
- **API shape**: `POST /v1/predictions` with a model version id and an `input` object;
  returns a prediction id with status `starting` → `processing` → `succeeded`/`failed`.
  Poll `GET /v1/predictions/{id}` or register a webhook.
- **Latency**: highly variable — a "cold" model (no recent traffic) can take 10–60+ seconds
  just to load onto a GPU before generation even starts; a "warm" model responds in a few
  seconds. This cold-start variance is itself an argument for generous timeouts and
  progress/heartbeat tracking (see file 07) rather than fixed short timeouts.
- **Pricing shape**: dual — some models (mostly official, packaged ones like FLUX) charge a
  flat price per output image (~$0.003–$0.04 observed); others (custom/community models)
  bill per second of raw GPU time on a published rate card (CPU/T4/A100/H100 tiers).
- **Design note**: Replicate could plausibly be implemented as a *single* `ImageProvider`
  adapter that internally lets the platform pick from many underlying models — useful as a
  pragmatic first "real" integration later, since one adapter buys access to many models.

### 2.6 Midjourney — no real API

- Midjourney has **no official public API** as of this research date (confirmed current as
  of August 18, 2026 per third-party tracking, and unchanged since launch in 2022). The only
  sanctioned access paths are the Discord bot and the midjourney.com web app.
- An "Enterprise" tier reportedly gates API-like access behind a manual application process
  with no public general-availability documentation.
- Every "Midjourney API" product on the market today is an unofficial third-party wrapper
  that automates the Discord bot or web UI. This violates Midjourney's terms of service and
  carries real account-ban risk.
- **Recommendation**: exclude Midjourney from the real-provider roadmap entirely unless and
  until an official, documented API ships. Do not build the `ImageProvider` interface around
  any Midjourney-specific assumption, and do not integrate an unofficial wrapper.

## 3. Cross-provider parameter comparison

| Capability | OpenAI | Google Imagen 4 | Google Gemini-native | Stability AI | FLUX (BFL) | Replicate |
|---|---|---|---|---|---|---|
| `prompt` | Yes | Yes | Yes | Yes | Yes | Yes (model-dependent) |
| `negative_prompt` | No (prompt-engineering only) | Partial/version-dependent | No (conversational instead) | Yes | Model-dependent | Model-dependent |
| Aspect ratio / size | 1:1, 3:2, 2:3 | 1:1, 3:4, 4:3, 9:16, 16:9 | Prompted / response-shaped | Free aspect ratio param | Free width/height | Model-dependent |
| Style control | Prompt only | Prompt only | Prompt only | `style_preset` param | Prompt only | Model-dependent |
| Deterministic `seed` | No | Only if watermark disabled | No | Yes | Yes | Model-dependent |
| Reference / image-to-image | Edits endpoint, up to 16 images | Edit endpoint | Multi-turn conversational edit | `strength` param + Control tools | FLUX Kontext | Model-dependent |
| Inpainting / masked edit | Yes (mask PNG) | Yes (edit endpoint) | Conversational (no mask needed) | Yes (dedicated Inpaint tool + 4 more edit tools) | Yes (Kontext) | Model-dependent |
| Variations | `dall-e-2` only (legacy) | No dedicated endpoint | Re-prompt in conversation | Re-seed / img2img | Re-seed | Model-dependent |
| Explicit "fast" tier | `quality: low` | Imagen 4 Fast | Nano Banana (non-Pro) | Stable Image Core | Klein family | Depends on chosen model |

## 4. Provider-agnostic `ImageProvider` interface (conceptual design)

This is a **design sketch**, not implementation code — it exists to prove the interface can
represent every provider above without leaking provider-specific shapes into calling code.
Anything a specific provider needs that doesn't generalize goes in `providerOptions`, an
explicit escape hatch, rather than polluting the common surface.

```typescript
// Conceptual interface — illustrates the contract, not a working module.

interface ImageRef {
  url?: string;
  base64?: string;
  width?: number;
  height?: number;
}

interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: '1:1' | '3:2' | '2:3' | '4:3' | '3:4' | '16:9' | '9:16';
  width?: number;
  height?: number;
  count?: number;                 // n images per call
  seed?: number;                  // honored only if provider supports it (see capabilities)
  stylePreset?: string;
  quality?: 'fast' | 'standard' | 'high';   // maps to gpt-image quality / Imagen tier / FLUX Klein-vs-Pro / Stability Core-vs-Ultra
  outputFormat?: 'png' | 'jpeg' | 'webp';
  referenceImages?: ImageRef[];   // subject/style guidance where supported
  safety?: { level?: 'strict' | 'default' | 'relaxed' };
  providerOptions?: Record<string, unknown>;  // provider-specific escape hatch
}

interface ImageEditRequest extends ImageGenerationRequest {
  sourceImage: ImageRef;
  mask?: ImageRef;                // transparent region = editable, per OpenAI/Stability convention
  strength?: number;               // image-to-image denoise strength (0-1)
  editMode?: 'inpaint' | 'outpaint' | 'erase' | 'search-and-replace' | 'search-and-recolor' | 'instruction';
}

interface ImageVariationRequest {
  sourceImage: ImageRef;
  count?: number;
  seed?: number;
}

interface GeneratedImage {
  url?: string;
  base64?: string;
  width: number;
  height: number;
  seed?: number;
}

interface ImageResult {
  id: string;
  status: 'succeeded' | 'failed' | 'processing';
  images?: GeneratedImage[];
  error?: string;
  providerName: string;
  providerMeta?: Record<string, unknown>;
}

interface ImageProviderCapabilities {
  supportsNegativePrompt: boolean;
  supportsSeed: boolean;
  supportsMaskEdit: boolean;
  supportsVariations: boolean;
  supportsReferenceImages: boolean;
  maxReferenceImages?: number;
  maxImagesPerCall: number;
  supportedAspectRatios: string[];
  hasFastTier: boolean;
}

interface ImageProvider {
  readonly name: string;
  getCapabilities(): ImageProviderCapabilities;
  generateImage(req: ImageGenerationRequest): Promise<ImageResult>;
  editImage(req: ImageEditRequest): Promise<ImageResult>;
  createVariation(req: ImageVariationRequest): Promise<ImageResult>;
}
```

Notes on the design:

- **Every method returns the same `ImageResult` shape** regardless of whether the underlying
  provider was synchronous (OpenAI, Imagen) or asynchronous (FLUX, Replicate) — the internal
  job system (file 07) is what actually absorbs that difference; the interface itself only
  ever needs to represent "submitted / still working / done / failed."
- **`getCapabilities()` is load-bearing**: since no two providers support the same parameter
  set (seed, negative prompt, masked edit, variations all vary), calling code must check
  capabilities before building a request rather than assuming a parameter will be honored.
- **`createVariation` is deliberately kept as its own method** even though only one real
  provider (legacy DALL·E 2) implements it as a first-class endpoint — everyone else can
  satisfy it by composing `editImage`/`generateImage` with a reused seed or `strength`
  parameter inside the adapter, keeping the *caller's* contract stable.
- The **mock provider** implements this exact interface against fixtures/fake data, so
  callers, tests, and the orchestration pipeline in file 07 can be built and fully exercised
  today with zero real API keys, and a real adapter is a drop-in later.

## Sources

- [Introducing our latest image generation model in the API — OpenAI](https://openai.com/index/image-generation-api/)
- [Pricing — OpenAI API](https://developers.openai.com/api/docs/pricing)
- [Create image edit — OpenAI API Reference](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [Image generation — OpenAI API guide](https://developers.openai.com/api/docs/guides/image-generation)
- [A complete guide to the OpenAI Image Edit API — eesel AI](https://www.eesel.ai/blog/openai-image-edit-api)
- [Gemini API — Image generation — Google AI for Developers](https://ai.google.dev/gemini-api/docs/image-generation)
- [Imagen 4 Pricing and API Access (2026) — Magic Hour](https://magichour.ai/blog/imagen-4-pricing-and-api)
- [What Is Imagen 4 Fast? — MindStudio](https://www.mindstudio.ai/blog/what-is-imagen-4-fast-google)
- [$0.02/Image — Google's 3 Imagen 4 Tiers — ThePlanetTools](https://theplanettools.ai/blog/google-imagen-4-models-fast-standard-ultra-guide-2026)
- [Gemini API Pricing breakdown — developer.puter.com](https://developer.puter.com/tutorials/gemini-api-pricing/)
- [Stability AI — Developer Platform pricing](https://platform.stability.ai/pricing)
- [Stability AI Image Services — Amazon Bedrock docs](https://docs.aws.amazon.com/bedrock/latest/userguide/stable-image-services.html)
- [Stability AI (Stable Diffusion) API Pricing breakdown — developer.puter.com](https://developer.puter.com/tutorials/stability-ai-api-pricing/)
- [FLUX API Pricing — Black Forest Labs (official)](https://bfl.ai/pricing)
- [Overview / Pricing — Black Forest Labs docs](https://docs.bfl.ml/quick_start/pricing)
- [FLUX API Pricing 2026 — Price Per Token](https://pricepertoken.com/flux-pricing)
- [FLUX Pro vs. Dev vs. Schnell — Magic Hour](https://magichour.ai/blog/flux-pro-vs-dev-vs-schnell-which-image-model-is-right-for-you)
- [Replicate API Guide — Apiframe](https://apiframe.ai/guides/replicate-api-guide)
- [AI Image Model Pricing — Replicate & Fal.ai — Price Per Token](https://pricepertoken.com/image)
- [Midjourney API: Why There's No Official One (2026) — Unifically](https://unifically.com/blogs/midjourney-api)
- [Best Midjourney API Alternatives in 2026 — Apiframe](https://apiframe.ai/blog/best-midjourney-apis)
