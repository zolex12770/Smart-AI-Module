# Video Generation API Research

> Research date: **2026-08-31**. Video-generation APIs are moving even faster than image
> APIs and providers are churning hard — one of the providers below (OpenAI Sora 2) is
> **scheduled to shut down its entire API in under four weeks from this research date**.
> Re-verify all of this against current vendor docs before wiring in a real key.
>
> Purpose: survey current text-to-video and image-to-video APIs so the platform's
> `VideoProvider` interface (end of this document) is designed against real per-call
> constraints — most importantly, **real duration limits**, which is the single fact this
> entire project's long-form video architecture (file 07) is built around.

## The headline finding

**As of this research date, no surveyed provider can generate a single video clip anywhere
near 20 minutes in one API call.** Every real per-call duration ceiling found sits between
**5 and 25 seconds**. The longest true single-call limit identified is OpenAI Sora 2 Pro at
25 seconds; most others cap at 8–10 seconds. Some providers offer a proprietary "extend" or
"scene extension" feature that chains additional short calls together (feeding the last
frame of clip N forward as the seed for clip N+1) to produce a longer continuous-feeling
sequence — Google markets this as reaching "60 seconds or more," Kling's "Extend" feature
is marketed up to "3 minutes" — but **these are still multiple underlying generation calls
under the hood, not one call**, and none of them approach a 20+ minute target on their own.

This confirms the product requirement stated up front: a 20+ minute final video is only
achievable through an orchestration/scene-decomposition pipeline built at the platform
level — generating dozens of short clips (each within a real provider's duration limit) and
assembling them — not by finding a provider with a bigger duration limit. See
`07_LONG_RUNNING_JOB_ARCHITECTURE.md` for that pipeline design.

## 1. Landscape summary

| Provider | Model | Max duration **per call** | Resolution | Image-to-video / reference | API shape | Pricing shape |
|---|---|---|---|---|---|---|
| Google Veo 3.1 (Gemini API / Vertex AI) | `veo-3.1-generate(-preview)` | **8 seconds** per `generateVideos` call (the documented default/max) | 720p, 1080p, 4K | Yes — first-frame image-to-video, first+last frame interpolation, up to 3 subject reference images; native synchronized audio generated alongside video | **Asynchronous long-running operation (LRO)**: submit → operation object with a name → poll `operations.get` (Google's own sample code polls every 20s) until `done` → extract video URI from the response | Per-second, tiered: Fast ≈$0.15/s, Standard ≈$0.40/s (Vertex AI, observed) |
| OpenAI Sora 2 / Sora 2 Pro | `sora-2`, `sora-2-pro` | Sora 2: **4, 8, or 12 seconds**; Sora 2 Pro: **10, 15, or 25 seconds** (25s is the highest true single-call ceiling found in this survey) | Sora 2: up to 720p; Sora 2 Pro: up to full 1080p | Image-to-video via `start_image`; "remix"/extend of a prior generation | Asynchronous job: `POST /v1/videos` → job/video id → poll `GET /v1/videos/{id}` or webhook until `completed` | Per-second: Sora 2 ≈$0.10/s; Sora 2 Pro ≈$0.30–0.70/s depending on resolution |
| Runway Gen-4 / Gen-4 Turbo / Gen-4.5 | `gen4`, `gen4_turbo`, `gen4.5` | **5 or 10 seconds** per call | 720p (Gen-4/Turbo), higher for Gen-4.5 | "References" for cross-generation subject consistency; Act-Two (performance capture / multi-character dialogue); Aleph 2.0 video-to-video editing (2–30s source clip + up to 5 timestamped keyframes) | Asynchronous: Runway's developer API (`dev.runwayml.com`) — submit task → task id → poll | Per-second credits: Gen-4 Turbo ≈$0.05/s, Gen-4.5 ≈$0.12/s; $10 minimum credit top-up |
| Luma Dream Machine (Ray2) / Luma Agents API (Ray3.2) | `ray-2`, `ray-3.2` | **5 or 9 seconds** per call (Dream Machine API) | Defaults to 720p, up to 1080p; Ray3 line adds native HDR | Image-to-video, keyframe conditioning | Asynchronous job submission + polling (standard for the category) | Roughly per-clip, resolution/HDR-multiplied: ~$0.30 (720p/5s) to ~$3.60 (1080p/10s); HDR ~2x, HDR+EXR ~3x; provisioned-throughput plans for scale workloads |
| Kling AI (Kuaishou) | `kling-v1`/`v2`/`v2.5-turbo`/`v3.0-omni` | **5s default, 10s max** per single generation call. Separate "Extend" feature chains additional calls, marketed up to ~3 minutes total | Free tier: 360–540p; paid: 1080p; Kling 3.0 adds native 4K | `image2video` endpoint (`image_url` or `image_base64`); Kling v3 Omni accepts **up to 7 reference images** for multi-angle subject consistency | Asynchronous: `POST /v1/videos/{text2video\|image2video}` → `task_id` → poll `GET .../{task_id}`; JWT (HS256) bearer auth, tokens short-lived (~30 min) | Tiered per 5-second clip by quality: ~$0.18 (budget v1) to ~$1.70 (v2 Master); popular v2.5 Turbo ≈$0.31/5s (~$0.06–0.07/s equivalent) |
| Pika Labs | Pika 2.x | Free tier: 5s. Paid plans market "up to 30s" / "60s" outputs — **duration semantics (single call vs. stitched) are not clearly documented in public sources** and should be verified directly against Pika's API docs before relying on it | 480p (free) up to 1080p/4K (higher paid tiers) | Image-to-video; an "Ingredients"/characters feature is marketed for consistency but independent verification of guarantees was not found | API access is gated behind a higher-tier plan (~$96/mo "Studio" tier at research time); async job pattern typical of the category | Credit-based subscription; per-clip credit cost scales with resolution and duration |

**Data-quality note**: Google and OpenAI figures above come from first-party documentation
and are high-confidence. Runway, Luma, Kling, and especially Pika figures are drawn from a
mix of official docs and third-party pricing/aggregator sites, which are noisier and change
often — treat their exact numbers as indicative, and confirm against the vendor's own docs
at integration time.

## 2. Provider detail

### 2.1 Google Veo 3.1 (Gemini API & Vertex AI)

- **Per-call duration**: 8 seconds is the model's native, documented clip length
  (`duration_seconds` in the request config). Google's "Scene extension" feature builds
  longer sequences by generating a new 8-second clip conditioned on the final second of the
  previous one, and Google's own marketing describes reaching a minute or more this way —
  but this is explicitly multiple chained calls, not a single longer generation. (One
  secondary source claimed a newer "120 seconds at 4K" capability; this could not be
  corroborated against Google's own current docs and should be treated as unverified until
  checked directly against `ai.google.dev` at integration time.)
- **Image-to-video and reference support**: strong — Veo accepts a still image as the video's
  first frame, supports first+last-frame interpolation (specify both endpoints and Veo fills
  the motion between them), and accepts **up to 3 reference images** of a single
  person/character/product to help preserve subject appearance across a generation.
- **Native audio**: Veo 3.1 generates synchronized audio (dialogue, sound effects, ambient
  music) as part of the same call — a real differentiator vs. providers that produce silent
  video only.
- **API shape**: a genuine asynchronous long-running operation. `client.models.generate_videos()`
  returns an `operation` object; the caller polls `operations.get(operation)` (Google's own
  sample code sleeps 20 seconds between polls) until `operation.done`, then reads the video
  URI out of `operation.response.generated_videos[0].video` and downloads it (with the API
  key attached as a header, following redirects).
- **Pricing**: per-second, with a **Fast** tier (~$0.15/s, ~60% cheaper, lower latency, for
  prototyping/iteration) and a **Standard** tier (~$0.40/s, higher fidelity/temporal
  consistency) observed on Vertex AI. An 8-second clip runs roughly $1.20 (Fast) to $3.20
  (Standard), audio included at no extra charge.

### 2.2 OpenAI Sora 2 / Sora 2 Pro

- **Per-call duration**: Sora 2 supports 4, 8, or 12 seconds; **Sora 2 Pro supports 10, 15,
  or 25 seconds** — the highest genuine single-call ceiling found across every provider in
  this survey.
- **Resolution**: Sora 2 tops out at 720p; Sora 2 Pro supports true 1080p (and other
  widescreen options around 1024p).
- **API shape**: asynchronous. `POST /v1/videos` (optionally with a `start_image` for
  image-to-video) returns an id; poll `GET /v1/videos/{id}` until status is `completed`, or
  register a webhook instead of polling. A 10-second Sora 2 Pro render was reported to take
  roughly 30–90 seconds of processing time — i.e., generation wall-clock time is several
  multiples of the output duration, which matters for timeout/heartbeat design (file 07).
- **Pricing**: per-second — Sora 2 ≈$0.10/s (~$1 for a 10s clip); Sora 2 Pro ≈$0.30–0.70/s
  depending on resolution.
- **CRITICAL, time-sensitive finding**: OpenAI announced on **March 24, 2026** that the
  entire Videos API and all `sora-2` model aliases/snapshots will be **removed from the API
  on September 24, 2026**. The consumer Sora web/app product was already discontinued
  April 26, 2026; only the API kept running afterward, and even that stops shortly. **Given
  this research date of August 31, 2026, that shutdown is roughly 3.5 weeks away.** This is
  a concrete, real-world illustration of exactly why this platform must stay
  provider-agnostic: a provider can vanish from under an integration on a timeline measured
  in weeks, not years. Do not build any near-term integration plan around Sora as a
  dependency; if it's added at all, it should be added as one interchangeable adapter behind
  the common interface, never a hard dependency.

### 2.3 Runway (Gen-4, Gen-4 Turbo, Gen-4.5, Aleph 2.0)

- **Per-call duration**: 5 or 10 seconds for Gen-4 / Gen-4 Turbo. Gen-4.5 is the flagship,
  higher-fidelity tier at a higher per-second price.
- **Consistency features**: "References" lets a generation stay anchored to a consistent
  character/subject across separate calls; **Act-Two** supports performance-capture-driven,
  multi-character dialogue scenes; **Aleph 2.0** (added to the API June 2, 2026) is a
  video-to-video *editing* model — it takes an existing 2–30 second source clip plus a text
  prompt (and optionally up to 5 timestamped keyframe images) and propagates a described edit
  consistently across the whole clip, which is a distinct capability from pure
  text/image-to-video generation and useful for post-hoc consistency correction.
- **API shape**: asynchronous, via Runway's own developer API (`dev.runwayml.com`) with its
  own credit pool (minimum $10 top-up); submit a task, receive a task id, poll for status.
- **Pricing**: credit-based, per-second — Gen-4 Turbo ≈$0.05/s ($0.25 for 5s, $0.50 for 10s);
  Gen-4.5 ≈$0.12/s ($0.60 for 5s, $1.20 for 10s).

### 2.4 Luma Dream Machine (Ray2) / Luma Agents API (Ray3.2)

- **Per-call duration**: 5 or 9 seconds on the original Dream Machine API (Ray2). A newer,
  separate product called the **Luma Agents API** (Ray3.2, reached general availability via
  API in June 2026) exists alongside the original Dream Machine API — these are documented
  as two distinct API surfaces, not one, which matters for integration planning.
- **Resolution**: defaults to 720p unless 1080p is explicitly requested; the Ray3 line adds
  native HDR output (and an HDR+EXR variant for VFX-grade delivery).
- **Pricing**: roughly per-clip, scaling with resolution/duration and an HDR multiplier
  (SDR baseline, ~2x for HDR, ~3x for HDR+EXR). Luma also offers provisioned-throughput
  "Scale" plans (observed ~$2,100–$3,800/month, 8-unit minimum) for production workloads
  that need guaranteed capacity rather than pay-as-you-go.

### 2.5 Kling AI (Kuaishou)

- **Per-call duration**: **5 seconds is the default, 10 seconds is the maximum** for a single
  generation. A separate **"Extend"** feature (available on paid plans) can chain additional
  generations to reach a marketed maximum total video length of about 3 minutes — again, this
  is multiple stitched calls, not one longer call.
- **Resolution**: free tier is capped around 360–540p; paid plans unlock 1080p; the newer
  Kling 3.0 line adds one-click native 4K.
- **Reference support**: the `image2video` endpoint takes an image URL or base64 payload;
  notably, **Kling v3 Omni accepts up to 7 reference images in a single generation**, the
  richest multi-reference support found in this survey, aimed specifically at keeping a
  subject consistent across different angles.
- **API shape**: asynchronous — `POST /v1/videos/{text2video|image2video}` returns a
  `task_id`; poll `GET /v1/videos/{text2video|image2video}/{task_id}` for status and, on
  completion, the output video URL. Authentication uses a JWT (HS256) signed from an
  Access Key/Secret Key pair, passed as a bearer token; tokens are short-lived (~30 minutes),
  which the platform's provider adapter needs to refresh proactively rather than reactively.
- **Pricing**: tiered per 5-second clip by model/quality — from roughly $0.18 (budget v1
  tier) up to ~$1.70 (v2/v2.1 "Master" tier); the popular v2.5 Turbo tier sits around $0.31
  per 5 seconds (~$0.06–0.07/s equivalent).

### 2.6 Pika Labs

- Public information on Pika's actual **API** (as opposed to its consumer app) is thinner and
  more inconsistent than the other providers surveyed. Consumer-facing marketing describes
  free-tier clips capped at 5 seconds and paid tiers unlocking "up to 30s" or "60s" videos,
  but it is not clearly documented in first-party sources whether those longer marketed
  durations are single-call outputs or app-level stitching — **this needs direct verification
  against Pika's own API reference before any integration work**, not assumption from
  secondary sources.
- API access itself appears gated behind a higher-tier subscription (a "Studio" tier around
  $96/month was cited, which is also where 4K output and watermark removal live).
- **Recommendation**: treat Pika as lower-priority / lower-confidence for a first real
  integration relative to Google, OpenAI-successor models, Runway, or Kling, purely because
  the public documentation trail is weaker.

## 3. Cross-provider comparison: what a `VideoProvider` interface must accommodate

| Capability | Veo 3.1 | Sora 2 / Pro | Runway Gen-4 | Luma Ray2/3 | Kling | Pika |
|---|---|---|---|---|---|---|
| Max single-call duration | 8s | 12s / 25s | 5s or 10s | 5s or 9s | 5s (10s max) | 5s (unclear beyond) |
| Discrete allowed durations vs. free-form | Fixed (8s) | Discrete set (4/8/12 or 10/15/25) | Discrete (5 or 10) | Discrete (5 or 9) | Discrete (5 or 10) | Unclear |
| Resolution ceiling | 4K | 1080p (Pro) | 720p+ | 1080p (+HDR) | 4K (v3) | 4K (top tier) |
| Image-to-video (first frame) | Yes | Yes | Yes | Yes | Yes | Yes |
| First+last frame interpolation | Yes | Not confirmed | Not confirmed | Keyframes | Not confirmed | Not confirmed |
| Multi-reference subject conditioning | Up to 3 images | Not confirmed | "References" feature | Not confirmed | Up to 7 images (v3 Omni) | "Ingredients" (unverified) |
| Video-to-video editing | No | No | Yes (Aleph 2.0) | No | No | No |
| Native synchronized audio | Yes | Not confirmed as native | No (separate) | No | No | No |
| Job model | Async LRO (poll) | Async (poll/webhook) | Async (poll) | Async (poll) | Async (poll, JWT) | Async (assumed) |

Every provider surveyed is **async/job-based by construction** — there is no synchronous
video-generation API in this space, unlike images where several providers respond inline.
This makes the async job system in file 07 non-optional infrastructure, not an optimization.

## 4. Provider-agnostic `VideoProvider` interface (conceptual design)

Again, this is a **design sketch** to prove the contract can represent every provider above,
not implementation code.

```typescript
// Conceptual interface — illustrates the contract, not a working module.

interface VideoGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  durationSeconds: number;         // must be validated against getCapabilities().allowedDurations
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3';
  resolution?: '480p' | '720p' | '1080p' | '4k';
  seed?: number;
  firstFrameImage?: ImageRef;      // image-to-video
  lastFrameImage?: ImageRef;       // first/last-frame interpolation, where supported
  referenceImages?: ImageRef[];    // subject/character consistency conditioning
  sourceVideo?: VideoRef;          // for video-to-video edit models (e.g. Runway Aleph)
  generateAudio?: boolean;         // only meaningful where supportsNativeAudio is true
  providerOptions?: Record<string, unknown>;  // provider-specific escape hatch
}

interface VideoJobHandle {
  providerJobId: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  progressPct?: number;
  estimatedSecondsRemaining?: number;
}

interface VideoAsset {
  url: string;
  durationSeconds: number;
  resolution: string;
  hasAudio: boolean;
  seed?: number;
}

interface VideoResult {
  id: string;
  status: 'succeeded' | 'failed';
  video?: VideoAsset;
  error?: string;
  providerName: string;
  providerMeta?: Record<string, unknown>;
}

interface VideoProviderCapabilities {
  allowedDurationsSeconds: number[];     // e.g. [8] for Veo, [4,8,12] or [10,15,25] for Sora
  maxDurationSeconds: number;
  resolutions: string[];
  supportsImageToVideo: boolean;
  supportsFirstLastFrame: boolean;
  supportsReferenceImages: boolean;
  maxReferenceImages?: number;
  supportsVideoToVideo: boolean;
  supportsNativeAudio: boolean;
  supportsSeed: boolean;
  typicalProcessingMultiplier?: number;  // e.g. ~3-9x output duration, for timeout tuning
}

interface VideoProvider {
  readonly name: string;
  getCapabilities(): VideoProviderCapabilities;
  submitGeneration(req: VideoGenerationRequest): Promise<VideoJobHandle>;
  pollJob(jobId: string): Promise<VideoJobHandle>;
  getResult(jobId: string): Promise<VideoResult>;
  cancelJob?(jobId: string): Promise<void>;
}
```

Design notes:

- **`durationSeconds` is validated against `getCapabilities().allowedDurationsSeconds`
  before a request is ever sent** — this is the single most important guardrail this
  interface exists to enforce, since every provider has a *different discrete set* of legal
  durations rather than a free-form range, and this is exactly the constraint the long-form
  pipeline in file 07 must plan scenes around.
- **The interface has no "just give me a long video" mode.** There is deliberately no
  parameter for durations beyond a provider's real maximum — the interface refuses to imply
  a capability that doesn't exist. Long-form output is a pipeline-level concern (file 07),
  never something the `VideoProvider` interface itself pretends to solve.
- **`submitGeneration`/`pollJob`/`getResult` are separate methods** (rather than one
  synchronous-looking `generateVideo` call) specifically because every real video provider
  is async and multi-step (submit → poll → fetch) — mirroring that shape at the interface
  level avoids forcing a fake synchronous facade on top of what is structurally a job.
- **The mock provider** implements this interface with configurable fake latency and a
  fixture asset, so the orchestration pipeline (file 07) can be built, tested, and demoed
  end-to-end today with zero real video-provider keys or spend.

## Sources

- [Introducing Veo 3.1 and new creative capabilities in the Gemini API — Google Developers Blog](https://developers.googleblog.com/introducing-veo-3-1-and-new-creative-capabilities-in-the-gemini-api/)
- [Generate videos with Veo 3.1 in Gemini API — Google AI for Developers](https://ai.google.dev/gemini-api/docs/veo)
- [Veo — Google Gen AI Python SDK guide](https://googleapis-python-genai-70.mintlify.app/guides/veo)
- [Veo 3.1 Video API: Examples and Pricing — Wireflow](https://www.wireflow.ai/blog/veo-3-1-video-api-examples-and-pricing)
- [Deprecations — OpenAI API (official)](https://developers.openai.com/api/docs/deprecations)
- [What to know about the Sora discontinuation — OpenAI Help Center](https://help.openai.com/en/articles/20001152-what-to-know-about-the-sora-discontinuation)
- [Video generation with Sora — OpenAI API guide](https://developers.openai.com/api/docs/guides/video-generation)
- [Sora 2 pricing: A complete guide — eesel AI](https://www.eesel.ai/blog/sora-2-pricing)
- [Sora API: Pricing, Specs, and the September 24 Shutdown — Unifically](https://unifically.com/blogs/sora-api)
- [Runway API Guide: Pricing & Code — Apiframe](https://apiframe.ai/guides/runway-api-guide)
- [Runway API Adds Seedance 2.0 Fast and Aleph 2.0 — AI Video Advisor](https://aivideoadvisor.com/runway-api-adds-seedance-2-0-fast-and-aleph-2-0-2026-guide/)
- [Creating Multi-Character Dialogues with Act-Two — Runway (official help)](https://help.runwayml.com/hc/en-us/articles/41748090660499-Creating-Multi-Character-Dialogues-with-Act-Two)
- [Luma API Guide: Features, Pricing & Code — Apiframe](https://apiframe.ai/guides/luma-api-guide)
- [Luma AI pricing (2026) — eesel AI](https://www.eesel.ai/blog/luma-ai-pricing)
- [Kling AI Video Length Limit: Max Duration by Plan 2026 — Atlas Cloud](https://www.atlascloud.ai/blog/guides/kling-ai-video-length-limit)
- [Kling AI API Pricing 2026 — Renderful](https://renderful.ai/blog/kling-api-pricing)
- [Image to Video — Kling AI API Documentation (official)](https://kling.ai/document-api/api/video/3-0-omni/image-to-video)
- [Kling AI Image to Video API Documentation — Segmind](https://www.segmind.com/models/kling-image2video/api)
- [Pika Labs Pricing (2026) — Magic Hour](https://magichour.ai/blog/pika-labs-pricing)
- [How to Keep Characters Consistent in AI Video (2026) — Magic Hour](https://magichour.ai/blog/how-to-keep-characters-consistent-in-ai-video)
