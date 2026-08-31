# Long-Running Job Architecture & the Long-Form Video Pipeline

> Research/design date: **2026-08-31**. This document builds directly on the findings in
> `05_IMAGE_GENERATION_RESEARCH.md` and `06_VIDEO_GENERATION_RESEARCH.md`. The load-bearing
> fact carried forward from file 06: **every real video provider caps a single generation
> call at somewhere between 5 and 25 seconds** — nobody generates a 20-minute clip in one
> call. Everything in Part 2 of this document exists because of that one constraint.

This document is in two parts:

- **Part 1** designs the general-purpose async job system that *every* provider call (image
  or video, real or mock) runs through — because file 05 and file 06 both concluded that
  every real provider is either natively async or too slow to hold open synchronously.
- **Part 2** builds on Part 1 to design the concrete long-form video pipeline: the
  scene-decomposition/orchestration system that turns a single prompt into a 20+ minute
  final video by generating and assembling dozens of short clips.

---

## Part 1: The async job system

### 1.1 Why this can't be "just call the API and await the result"

- Every video provider surveyed is job-based: submit → poll (or webhook) → fetch. There is
  no synchronous video-generation API anywhere in the market.
- Even the "synchronous" image providers (OpenAI, Google Imagen, Stability) take multiple
  seconds per call, cold starts on aggregators like Replicate can add tens of seconds, and a
  long-form video run will make *hundreds* of provider calls (one or more per scene, plus
  audio, plus subtitles) — holding an HTTP request open for that is a non-starter.
- Providers fail, rate-limit, and time out. A real system needs retries, backoff, dead-letter
  handling, and the ability to resume a 60-scene video from scene 37 without redoing scenes
  1–36 — none of which is possible if generation is just an inline function call.

Conclusion: **every provider call — image or video, mock or real — is modeled as a Job**,
uniformly, from day one. This is precisely why the mock providers in files 05/06 are built as
async interfaces returning job handles rather than plain values: swapping mock for real later
changes zero call sites.

### 1.2 Core primitives

| Primitive | What it means here | Why it matters for image/video generation specifically |
|---|---|---|
| **Job** | A durable record of one unit of work: type, payload, status, attempt count, timestamps | One scene's video generation, one TTS call, one subtitle pass, one ffmpeg render — each is a Job row, independently retryable and inspectable |
| **Queue** | An ordered (or priority-ordered) backlog of Jobs a Worker pulls from | Separate queues per job type (e.g. `video-gen`, `image-gen`, `tts`, `render`) so a stuck video provider doesn't starve cheap, fast subtitle jobs |
| **Worker** | A process that claims a Job, executes it (usually calling out to an external provider), and reports the outcome | Workers for provider calls must be **rate-limit aware** per provider (see 1.6) since providers throttle by account, not by job |
| **Retry / Backoff** | On failure, re-attempt the job after a delay that grows (exponential, optionally jittered) instead of immediately | Provider 429s and transient 5xxs are common and expected at this call volume; immediate retry just re-triggers the same rate limit |
| **Timeout** | A hard ceiling on how long a job may run before it's considered failed/stuck | Video jobs need *generous, provider-specific* timeouts — Sora 2 Pro alone was observed taking 30–90s for a 10s clip, i.e. several multiples of output duration, not a flat "30 seconds and done" assumption |
| **Cancellation** | A way to stop a job that's no longer needed (user canceled the whole run, or a duplicate was queued) | Must propagate to the provider's own cancel endpoint where one exists, and always at minimum stop billing/polling and free the worker slot |
| **Dead-Letter Queue (DLQ)** | Where a job goes after exhausting its retry budget, for human/manual inspection instead of silently vanishing | A scene that fails 5 times (bad prompt, persistent provider outage, content-policy rejection) must surface as an actionable failure, not disappear — this is what makes "only scene 37 fails" a debuggable statement instead of a mystery |
| **Progress** | Incremental status finer than "pending/done" — percentage, current step, ETA | Long-form runs need a UI that can say "42 of 60 scenes rendered" rather than a spinner; video providers that expose progress/ETA in their poll response (several do) should feed this directly |
| **Heartbeat** | A worker periodically confirming "I'm still alive and working on this" while a job is in flight | Long provider calls (video jobs polling for 30–90+ seconds, sometimes minutes) must not be mistaken for a crashed worker by a naive timeout; heartbeats distinguish "still legitimately working" from "worker died, requeue this" |
| **Idempotency** | Calling "submit this job" twice (e.g. due to a retry-after-timeout race) must not create two billed provider generations for the same scene | Critical given real providers charge per call — an idempotency key derived from `(sceneId, promptHash, attemptNumber)` ensures a network-level retry doesn't double-spend against a paid API |
| **Persistence** | Every job's state survives process restarts and is queryable | A 60-scene, multi-hour pipeline run must be resumable across deploys/crashes — job state lives in Postgres, not in worker memory |

### 1.3 Job lifecycle (state machine)

```
        ┌─────────┐   claim    ┌────────────┐  success   ┌───────────┐
 create │ pending │──────────▶ │ processing │──────────▶ │ succeeded │
        └─────────┘            └────────────┘            └───────────┘
             ▲                     │    │
             │ retry (backoff)     │    │ failure (attempts < max)
             └─────────────────────┘    ▼
                                   ┌────────────┐  attempts >= max  ┌──────────────┐
                                   │   failed    │─────────────────▶│ dead_letter  │
                                   └────────────┘                   └──────────────┘
                                         ▲
                                         │ cancel requested (any state before terminal)
                                   ┌────────────┐
                                   │ canceled   │
                                   └────────────┘
```

Every transition is written to Postgres before the corresponding side effect is trusted —
e.g., a job is marked `processing` (with a lock and a heartbeat timestamp) *before* the
provider call is made, so a crash mid-call is detectable (stale heartbeat) and recoverable
(safe re-claim), rather than leaving an orphaned "pending forever" or, worse, silently
duplicated work.

### 1.4 Generic `Job` envelope (conceptual schema)

```typescript
// Conceptual schema — illustrates the data model, not a working module.

interface Job {
  id: string;                       // UUID
  type: string;                     // 'image.generate' | 'video.generate' | 'tts.synthesize' | 'render.assemble' | ...
  payload: Record<string, unknown>; // provider request, scene id, etc.
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead_letter' | 'canceled';
  attempts: number;
  maxAttempts: number;
  backoff: { strategy: 'exponential'; baseMs: number; maxMs: number; jitter: boolean };
  priority: number;
  runAt: string;                    // earliest time this job may be claimed (supports backoff delay & scheduling)
  lockedAt?: string;                // set when a worker claims the job
  lockedBy?: string;                // worker id, for heartbeat/stale-lock detection
  heartbeatAt?: string;             // updated periodically while processing
  timeoutMs: number;                // provider-specific — see 1.2
  idempotencyKey: string;           // e.g. `${parentJobId}:${payloadHash}:${attempt}`
  parentJobId?: string;             // links a scene-generation job back to its pipeline run
  result?: Record<string, unknown>;
  lastError?: string;
  errorHistory?: { attempt: number; error: string; at: string }[];
  createdAt: string;
  updatedAt: string;
}
```

### 1.5 Queue technology comparison (Node.js/TypeScript + Postgres stack)

| Option | Storage | Strengths for this workload | Weaknesses for this workload |
|---|---|---|---|
| **BullMQ + Redis** | Redis | Most feature-complete Node.js queue library (priorities, millisecond-precision delayed jobs, parent/child job flows, repeatable jobs); large community; built-in pub/sub makes live progress dashboards easy | Requires operating a **second stateful system** (Redis) alongside Postgres purely for the queue; Redis is in-memory-first, so job durability depends on its persistence config (AOF/RDB) being tuned correctly — an easy thing to get wrong; adds an extra network hop and failure domain for a workload that is not actually high-throughput |
| **pg-boss** (Postgres-native) | Postgres | No new infrastructure — reuses the same Postgres instance the rest of the platform already needs; `SKIP LOCKED`-based claiming gives real concurrency safety with full ACID guarantees; a job and the business-data row it relates to (e.g. a `SceneManifest` update) can be committed in the **same transaction**, which is hard to get atomically right across a Redis+Postgres split; includes archiving and a reasonably rich scheduling model | Lower raw throughput ceiling than Redis — irrelevant here, since throughput is bottlenecked by slow, rate-limited external provider calls (seconds-to-minutes each), not by queue mechanics; less mature ecosystem/tooling than BullMQ |
| **graphile-worker** (Postgres-native) | Postgres | Uses `LISTEN/NOTIFY` for low-latency dispatch; jobs can be enqueued directly from a SQL function/trigger inside a transaction you're already writing (e.g., "when a SceneManifest row is created, enqueue its generation job" as a DB-level guarantee, not an application-level one) | Smaller community/less complete feature set than pg-boss for things like archiving and richer scheduling; philosophically "the queue is an extension of SQL," which is powerful but a less conventional shape for a typical Node.js service team |
| **Cloud-native (Google Cloud Tasks / Pub/Sub)** | Managed (GCP) | Zero queue infrastructure to operate at all; Cloud Tasks specifically has built-in exponential backoff/retry and rate-limiting per queue, which maps well to "don't hammer a rate-limited provider"; good fit if the whole platform already deploys on Cloud Run/GCP | Ties core architecture to one cloud vendor — in tension with the project's own model-agnostic, portable design philosophy; Pub/Sub is fan-out/event-shaped rather than task-shaped (better for "notify N subscribers" than "run this exact job with retries"); harder to get the same tight transactional coupling with Postgres application state that pg-boss/graphile-worker give for free |

**Recommendation: pg-boss on the existing Postgres instance, as the primary queue.**

Reasoning:

1. **This workload is not high-throughput.** A job here means "call an external image/video
   API," which takes seconds to minutes and is itself rate-limited by the provider — the
   queue will never be the bottleneck. Redis's raw throughput advantage over
   `SKIP LOCKED` Postgres is not a real requirement.
2. **Transactional consistency matters more than raw speed here.** The pipeline in Part 2
   needs to atomically update a `SceneManifest` row's status *and* enqueue its next job (or
   record its failure and enqueue nothing) — doing that across Postgres and Redis means
   either a distributed transaction problem or an accepted window of inconsistency. Doing it
   in pg-boss means one `BEGIN ... COMMIT`.
3. **One fewer stateful system to operate**, monitor, back up, and reason about during
   incident response — meaningful for a platform that's starting with mock providers and a
   small team, not a large existing Redis-based real-time infrastructure.
4. **Portability**: staying on Postgres keeps the platform deployable anywhere Postgres runs,
   consistent with the model-agnostic, provider-agnostic ethos already applied to the
   generation providers themselves — no reason to make the job system a GCP-only or
   Redis-only decision when neither is required by the actual load.

**When to revisit this recommendation**: if the platform later adds a genuinely
high-frequency, low-latency queue need unrelated to media generation (e.g., real-time
per-keystroke collaboration events, or job volumes reaching thousands/second), BullMQ+Redis
becomes worth the second stateful system at that point — introduce it then, for that
workload specifically, rather than defaulting to it now for a workload that doesn't need it.
If the platform standardizes on GCP serverless (Cloud Run) for *all* infrastructure, Cloud
Tasks is a reasonable managed alternative to self-hosting pg-boss, at the cost of the
portability noted above.

### 1.6 Provider-call-specific concerns layered on top of the generic job system

- **Per-provider rate limiting**: each `ImageProvider`/`VideoProvider` adapter declares its
  own concurrency/rate limits (requests/minute, concurrent jobs); the worker pool enforces
  this *per provider account*, independent of overall queue concurrency, since a provider
  will 429 regardless of how much local worker capacity exists.
- **Provider-aware timeouts**: file 06 found processing time can be several multiples of
  requested clip duration (e.g., a 10s Sora clip taking up to 90s). Job `timeoutMs` is set
  per provider/operation type from `getCapabilities()`-style metadata, not one global
  constant.
- **Cost tracking hook**: since providers bill per call (and Stability explicitly does *not*
  bill failed generations, per file 05), the job's terminal state should drive
  cost-accounting, and a canceled/failed job should not be charged against a user's budget
  unless the provider itself charged for it.
- **Mock-provider parity**: the mock `ImageProvider`/`VideoProvider` implementations
  deliberately go through this same job system (with configurable fake latency and a
  configurable failure rate) rather than resolving instantly in-process — this is what makes
  it possible to build, test, and demo the entire pipeline in Part 2 today, with the exact
  failure/retry/resume behavior a real provider will require later, without spending a
  dollar on a real API key.

---

## Part 2: The long-form video pipeline

### 2.1 The problem restated

Product requirement: a user gives a single prompt, and the platform must produce a
**20+ minute finished video** with narration/dialogue, music, and subtitles. File 06
established that no provider can generate more than ~25 seconds in a single call. A
20-minute video at, say, 8-second scenes (Veo's native length) is **150 separate clip
generations**, each of which can independently fail, need a retry, or need to be
regenerated later because a reviewer didn't like it — and the whole run must be resumable,
not "start over from clip 1" on any single failure.

### 2.2 Pipeline stages

```
 prompt
   │
   ▼
[1] Script generation ───────────────► full narrative script + dialogue/narration text
   │
   ▼
[2] Storyboard / scene planning ─────► ordered list of scenes, each ≤ a provider's max
   │                                    clip duration, with shot description, characters,
   │                                    setting, style tags, dialogue lines
   ▼
[3] Per-scene clip generation ───────► one VideoProvider job per scene (parallel, bounded
   │                                    concurrency, each independently retryable)
   ▼
[4] Consistency mechanisms ──────────► applied *into* stage 3's requests, not a separate
   │                                    pass — character sheets, reference images, seeds
   ▼
[5] Voice / music / audio generation ─► TTS per line, background music per scene/section
   │
   ▼
[6] Subtitle generation ─────────────► SRT/VTT cues, script-derived or ASR-aligned
   │
   ▼
[7] Timeline assembly ───────────────► maps scenes + audio + subtitles to absolute
   │                                    timestamps in the final output
   ▼
[8] Rendering (ffmpeg) ──────────────► normalize each scene, concatenate, mux audio,
   │                                    mux/burn subtitles
   ▼
[9] Quality check ───────────────────► automated + optional human-in-the-loop gate
   │
   ▼
[10] Final asset ─────────────────────► packaged MP4 + manifest + thumbnail
```

Each numbered stage below is itself one or more Jobs from Part 1 — the whole pipeline run is
a durable, resumable state machine in Postgres, not an in-memory script.

#### [1] Script generation

An LLM call (through the platform's own model-agnostic LLM abstraction — out of scope for
this document) turns the user's prompt into a full script: narrative beats, scene
boundaries, dialogue/narration lines, and named characters/settings. Output is stored as
structured data (not just prose) so stage 2 can consume it programmatically.

#### [2] Storyboard / scene planning

The script is decomposed into scenes such that **`scene.durationSeconds` never exceeds the
target `VideoProvider`'s `maxDurationSeconds`** (file 06: typically 5–10s, up to 25s for
Sora 2 Pro). Target scene count is approximately `ceil(totalDurationSeconds /
targetClipDurationSeconds)` — e.g., a 20-minute (1200s) video at 8-second Veo clips is
**150 scenes**; the same video at Sora 2 Pro's 25-second ceiling is **48 scenes**. This
stage's output is the set of `SceneManifest` rows (schema in 2.4) — the single source of
truth the rest of the pipeline reads and writes.

Each scene records: shot/visual description, camera direction, dialogue or narration text
for that scene, which characters/settings appear, mood/style tags, and which reference
assets (from stage 4) apply.

#### [3] Per-scene clip generation

For each `SceneManifest` row, build a `VideoGenerationRequest` (interface from file 06) and
submit it as a Job. Scenes generate with **bounded concurrency** (respecting the chosen
provider's rate limits from Part 1, §1.6) — not all 150 scenes fire at once. Each scene's
job outcome (succeeded asset, or failure + error) is written back onto its own
`SceneManifest` row.

#### [4] Consistency mechanisms — and an honest limitation

The single hardest, least-solved problem in this entire pipeline is **keeping a character,
outfit, or setting visually consistent across scenes that are each generated by an
independent API call.** Being direct about this: **as of this research date, no video
provider surveyed in file 06 guarantees identity persistence across separate generation
calls.** These are diffusion-based models — even with an identical prompt and reference
image, the sampling noise differs call to call, and there is no "memory" of a prior scene's
exact rendering. Industry sources describe this openly as "character drift," and note it
gets *worse*, not better, as clip count grows or when a shot has multiple interacting
characters. This pipeline mitigates drift; it does not eliminate it, and the product's UX
and QA process (stage 9) must be built assuming some residual drift is normal, not a bug to
chase to zero.

Concrete mitigations, layered (each reduces risk; none is a guarantee):

1. **Character/setting reference sheets, generated once per project via `ImageProvider`**,
   then passed as `referenceImages` into every `VideoGenerationRequest` for scenes that
   include that character. Providers with richer multi-reference support (Kling v3 Omni: up
   to 7; Veo 3.1: up to 3) give the model more to anchor to than a single reference image.
2. **Seed reuse** where a chosen provider supports deterministic seeds (Stability, FLUX for
   image assets used as references; check `VideoProviderCapabilities.supportsSeed` for the
   video provider itself) — reusing a seed across related scenes measurably reduces (but
   does not eliminate) unwanted variation.
3. **A fixed style/prompt prefix** (consistent wording describing the character's
   appearance, wardrobe, and the overall visual style) injected into every scene's prompt,
   rather than trusting the model to infer consistency from context alone.
4. **Provider-native "extend"/continuation features used *within* a scene**, when a
   provider supports it and the target clip duration allows it — e.g. Veo's scene-extension
   (continuing from the prior clip's last frame) or Kling's Extend — since a single
   continuous take from one provider call chain is inherently more consistent than two fully
   independent generations. This is used as a *local* technique for adjacent sub-shots, not
   as the answer to the whole 20-minute problem (file 06 already established why it can't
   be — it's still bounded, chained short calls, and provider-proprietary rather than
   portable).
5. **Automated post-hoc similarity checks** in stage 9 (perceptual hash or face-embedding
   similarity between a scene's output and its character reference) to flag scenes whose
   drift exceeds a threshold for regeneration or human review, rather than only discovering
   drift when a viewer notices it in the final cut.
6. **Honest product framing**: the platform should describe long-form output to end users
   as "the same character, prompted and referenced consistently throughout" — not as
   "guaranteed frame-perfect identity," because no current provider can back that claim.

#### [5] Voice / music / audio generation hooks

Mirrors the same provider-agnostic pattern as images/video: an `AudioProvider` abstraction
(TTS) and a `MusicProvider` abstraction (background score), each with a mock implementation
today and real adapters (e.g., ElevenLabs- or OpenAI-TTS-shaped for voice; Suno/ElevenMusic/
MiniMax-Music-shaped for score) pluggable later without redesign, exactly like
`ImageProvider`/`VideoProvider`. TTS runs per dialogue/narration line (from the stage-1
script, scoped per scene); music generation runs per section or per overall mood cue, with
mixing metadata (ducking dialogue under music, per-track volume) captured for stage 7/8.

#### [6] Subtitle generation

Two viable modes, and the platform should support both:

- **Script-derived**: since the script (stage 1) already contains ground-truth dialogue/
  narration text per scene, subtitle cues can be generated directly from that text with
  timing derived from each scene's position in the timeline — no ASR needed, and inherently
  accurate to what was *intended* to be said.
- **ASR-derived (forced alignment)**: run speech recognition (e.g., a Whisper-class model)
  over the final mixed audio to get **word-level timing**, which is more accurate to what a
  TTS engine *actually* produced (pacing varies) and is the fallback whenever audio is
  something other than platform-generated TTS (e.g., a user-uploaded voice track).

Output is standard **SRT/VTT** cues, each tagged with the source scene for traceability.

#### [7] Timeline assembly

A `Timeline` (schema in 2.4) maps the ordered scenes to absolute start/end timestamps in the
final output, including transition metadata (hard cut vs. crossfade) between scenes, and the
corresponding offsets for each `AudioTrack` and `SubtitleTrack` entry. This is a pure data
transformation over already-generated assets — no provider calls happen in this stage, which
is exactly why it's cheap to re-run in isolation after a single scene is regenerated (see
2.5).

#### [8] Rendering (ffmpeg)

- **Normalize before concatenating**: different scenes may come back from different provider
  calls (or even different providers, if a fallback was used) with different resolutions,
  frame rates, or codecs. Each scene clip is passed through an ffmpeg `scale`+`pad`+`fps`
  normalization filter to a single target spec *before* concatenation — skipping this is a
  common, avoidable source of concat failures or visual jarring at cut points.
- **Concatenation**: ffmpeg's concat demuxer for simple hard cuts, or the concat *filter*
  (not the demuxer) when crossfades/transitions between scenes are required, since
  transitions need frame-level filter graph access the demuxer doesn't provide.
- **Audio muxing**: dialogue and music tracks are mixed and muxed onto the video timeline at
  the offsets computed in stage 7, with volume/ducking applied.
- **Subtitles**: either muxed as a soft (selectable) subtitle stream, or burned into the
  video frames, depending on product requirements — soft-muxed is generally preferable for
  flexibility (localization, accessibility toggles) unless burned-in is specifically needed.

#### [9] Quality check

- **Automated checks**: output duration matches the planned timeline length; no corrupt/black
  frames at scene boundaries; every scene has a synced, non-silent audio segment where one
  was expected; consistent resolution/codec/frame rate throughout (i.e., normalization in
  stage 8 actually worked); the character-similarity check from §2.4's mitigations flags any
  scene whose drift exceeds threshold.
- **Optional human-in-the-loop gate**: for products where quality bar is high, surface a
  review step before final packaging — cheap to add given the pipeline is already stage-based
  and resumable; a rejected scene simply re-enters stage 3.

#### [10] Final asset

Packaged output: the rendered MP4, a manifest JSON describing every scene's source
provider/model/prompt/seed/asset ids (for auditability and for enabling "regenerate just this
scene" later even after the run is nominally "done"), and an extracted thumbnail.

### 2.3 Resumability — "only scene 37 regenerates"

This is the concrete mechanism, not just an aspiration:

1. Every scene's generation is its own **Job**, linked to its own **`SceneManifest`** row via
   `parentJobId`/`sceneId`, with its own idempotency key, retry count, and terminal status.
2. A pipeline run is itself a durable state machine (its own row, `PipelineRun`, referenced
   implicitly through `SceneManifest.projectId`) with coarse-grained stage status:
   `planning → scene_generation → audio_generation → assembly → qc → done | failed`.
3. **Before generating any scene, the orchestrator checks that scene's current status.**
   Scenes already `succeeded` (with a valid `assetId` in the `AssetRegistry`) are skipped
   entirely — never regenerated as a side effect of retrying the run. Only scenes in
   `pending`/`failed`/`dead_letter` are (re-)submitted.
4. If scene 37 of 60 fails (provider error, content-policy rejection, timeout) and exhausts
   its retry budget, it lands in the DLQ (Part 1, §1.2) and the pipeline's overall stage
   status reflects "39/60 scenes complete, 1 failed" rather than failing the entire run.
   Fixing it (adjusting the prompt, or simply re-queuing) regenerates **only scene 37** —
   scenes 1–36 and 38–60 are untouched, since their assets already exist in the
   `AssetRegistry` and are never re-requested.
5. **Stage 7 (timeline assembly) and stage 8 (rendering) are cheap, local, deterministic
   recomputations** over whatever's currently in the `AssetRegistry` — they are simply re-run
   after scene 37 completes, rather than needing their own fine-grained resumability. This is
   why keeping them provider-call-free (pure data/ffmpeg operations) matters: re-running the
   cheap stages to pick up one fixed expensive stage is the whole trick.
6. Idempotency keys (Part 1, §1.4) prevent a network-level retry of scene 37's *own* job from
   ever producing two billed generations for the same scene — a legitimate regeneration
   (after a deliberate fix) uses a new `attempt` number and therefore a new idempotency key,
   which is a distinct, intentional case from an accidental duplicate submission.

### 2.4 Concrete data model

```typescript
// Conceptual schema — illustrates the data model, not a working module/migration.

interface SceneManifest {
  id: string;
  projectId: string;
  sceneIndex: number;                 // ordering within the video
  shotDescription: string;            // visual/camera direction
  dialogue?: string;                  // narration/dialogue text for this scene
  characters: string[];               // character ids present in this scene
  setting?: string;
  styleTags: string[];
  durationSeconds: number;            // must be <= chosen VideoProvider's max
  providerRequestSnapshot: Record<string, unknown>;  // the VideoGenerationRequest actually sent
  consistencyRefs: { characterId: string; referenceAssetIds: string[]; seed?: number }[];
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead_letter';
  jobId?: string;                     // current/last Job id for this scene
  assetId?: string;                   // → AssetRegistry, once succeeded
  retryCount: number;
  lastError?: string;
  qcSimilarityScore?: number;         // consistency-check result, see 2.2 §4
  createdAt: string;
  updatedAt: string;
}

interface Timeline {
  id: string;
  projectId: string;
  version: number;                    // bumped whenever recomputed (e.g. after a scene fix)
  totalDurationMs: number;
  entries: {
    sceneId: string;
    startMs: number;
    endMs: number;
    transitionIn?: 'cut' | 'crossfade';
  }[];
  createdAt: string;
}

interface AssetRegistry {
  id: string;
  projectId: string;
  kind: 'image' | 'video' | 'audio' | 'subtitle' | 'render';
  providerName: string;               // e.g. 'mock', 'veo-3.1', 'kling-v2.5-turbo'
  providerAssetId?: string;
  storageUrl: string;
  checksum: string;
  metadata: {
    resolution?: string;
    durationSeconds?: number;
    codec?: string;
    seed?: number;
  };
  createdAt: string;
}

interface AudioTrack {
  id: string;
  projectId: string;
  kind: 'dialogue' | 'music' | 'sfx';
  sourceSceneId?: string;             // set for dialogue tied to a specific scene
  providerRequestSnapshot?: Record<string, unknown>;
  assetId: string;                    // → AssetRegistry
  startMs: number;
  volumeDb: number;
  duckingRules?: { duckUnder: 'dialogue'; reduceByDb: number }[];
}

interface SubtitleTrack {
  id: string;
  projectId: string;
  format: 'srt' | 'vtt';
  sourceMode: 'script-derived' | 'asr-derived';
  cues: { startMs: number; endMs: number; text: string; sceneId?: string }[];
}

interface RenderJob {
  id: string;
  projectId: string;
  timelineVersion: number;            // which Timeline version this render used
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  ffmpegCommandSnapshot?: string;      // for auditability/debugging
  outputAssetId?: string;             // → AssetRegistry ('render' kind)
  qcResults?: {
    durationMatches: boolean;
    noCorruptFrames: boolean;
    audioSynced: boolean;
    flaggedScenes: string[];          // sceneIds below the consistency-similarity threshold
  };
  startedAt?: string;
  completedAt?: string;
}
```

### 2.5 Why the cheap/expensive split matters

The design deliberately concentrates all real cost and risk (provider calls: script LLM
call, per-scene video generation, TTS, music) into stages that write their results into
durable, addressable rows (`SceneManifest`, `AssetRegistry`, `AudioTrack`) — and keeps stages
7–8 (timeline assembly, rendering) as pure, cheap, local, re-runnable transformations over
those rows. That split is what makes "regenerate scene 37, keep everything else" a five-word
description of something the architecture actually does by construction, rather than a
promise that requires special-casing.

## Sources

Queue technology comparison:

- [bull vs bullmq vs graphile-worker vs pg-boss — npm trends](https://npmtrends.com/bull-vs-bullmq-vs-faktory-worker-vs-graphile-worker-vs-in-memory-queue-vs-node-schedule-vs-pg-boss-vs-queue)
- [BullMQ alternatives for Node.js: an honest 2026 guide](https://imqueue.org/blog/bullmq-alternatives/)
- [BullMQ vs Bee-Queue vs pg-boss 2026 — PkgPulse Guides](https://www.pkgpulse.com/guides/bullmq-vs-bee-queue-vs-pg-boss-job-queues-nodejs-2026)
- [I Removed Redis From My Stack and Used PostgreSQL for Job Queues Instead — DEV Community](https://dev.to/aws-builders/i-removed-redis-from-my-stack-and-used-postgresql-for-job-queues-instead-2lp5)
- [How to Choose Between Pub/Sub and Cloud Tasks for Asynchronous Processing on GCP](https://oneuptime.com/blog/post/2026-02-17-how-to-choose-between-pub-sub-and-cloud-tasks-for-asynchronous-processing-on-gcp/view)
- [Cloud Tasks or Pub/Sub? — Medium](https://medium.com/google-cloud/cloud-tasks-or-pub-sub-8dcca67e2f7a)

Character-consistency limitations:

- [How to Keep Characters Consistent in AI Video (2026) — Magic Hour](https://magichour.ai/blog/how-to-keep-characters-consistent-in-ai-video)
- [How Seedance 2.0 Is Solving AI Video's Character Consistency Problem in 2026 — DevX](https://www.devx.com/artificial-intelligence-ai/seedance-2-0-character-consistency/)
- [AI Character Consistency: 5 Methods Compared (2026) — Flick](https://flick.art/blog/img2img-consistent-character)

Audio/music/subtitle provider landscape (for the AudioProvider/MusicProvider hooks):

- [ElevenLabs API Pricing: TTS, Sound Effects, and STT (2026) — Unifically](https://unifically.com/blogs/elevenlabs)
- [Text-to-Speech API Comparison 2026: ElevenLabs, OpenAI & More — Crazyrouter](https://crazyrouter.com/en/blog/text-to-speech-api-comparison-2026)
- [Suno vs Udio vs ElevenLabs Music: The 2026 Showdown — AI Magicx](https://www.aimagicx.com/blog/suno-vs-udio-vs-elevenlabs-music-comparison-2026)

See also `05_IMAGE_GENERATION_RESEARCH.md` and `06_VIDEO_GENERATION_RESEARCH.md` in this
directory for the underlying provider research this design builds on.
