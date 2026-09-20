# Cost and Quota Strategy

AI generation cost is variable and provider-set; this document is about controlling exposure, not predicting exact prices (which change — see the dated citations in [[04_MODEL_PROVIDER_RESEARCH]], [[05_IMAGE_GENERATION_RESEARCH]], [[06_VIDEO_GENERATION_RESEARCH]] rather than hardcoding numbers anywhere in code).

## CostEstimator

A `CostEstimator` in `packages/model-router` computes an estimated cost **before** an expensive operation executes, using each provider's documented cost *structure* (per-token tiers for LLMs, per-image/per-megapixel for images, per-second for video) stored in the `models.cost_profile` column ([[14_DATABASE_ARCHITECTURE]]) — updated via config, not hardcoded, since providers change pricing independently of code releases.

- **LLM calls:** estimate from prompt token count (computed via the provider's tokenizer or a close approximation) × the model's rate. Cheap and fast — runs synchronously before every call.
- **Image calls:** estimate from resolution/count × the model's rate. Also cheap/synchronous.
- **Video calls, especially long-form:** estimate from the full scene manifest ([[07_LONG_RUNNING_JOB_ARCHITECTURE]]) — total scene count × per-scene duration × the model's per-second rate, summed **before** the first scene is generated. This is the one case where a bad estimate has real consequence (a 20-minute video is dozens of scene calls), so the UI must show this estimate and require confirmation before the job is enqueued (FR-043 in [[01_REQUIREMENTS]]).

## QuotaManager

Per-ORGANIZATION quotas (`daily_token_limit`, `monthly_token_limit`, `daily_image_limit`, `monthly_video_seconds_limit`, configurable in `settings`, FR-063) are checked **before** enqueueing a job or making a model call, not after — a request that would exceed quota is rejected synchronously with a clear error, never allowed to start and fail/bill partway through. Usage is decremented from the same `usage_records` table that powers the usage dashboard ([[15_API_ARCHITECTURE]] `/api/v1/usage`), so quota state and displayed usage can never disagree.

**The scope is the organization, not the project** — ADR-126, and ADR-150 for the dashboard. Every
limit was per project and any user can create projects, so `DAILY_TOKEN_LIMIT=100000` meant a
hundred thousand tokens *per project* and the ceiling was a button away from being raised. The
checks draw against the tenant now. `/api/v1/usage` reports the organization total as `usage` and
this project's share as `projectUsage`: for one release it reported only the project figure under
organization limits, so the meter a user watched could not predict the refusal they were about to
get.

## Usage recording

Every provider call — success or failure — writes a `usage_records` row ([[14_DATABASE_ARCHITECTURE]]) with actual token counts / actual billed units returned by the provider (not the pre-flight estimate) as soon as the call completes, tagged with `user_id`, `project_id`, `task_id`, `provider`, `model`. This is the single source of truth for both the cost dashboard (FR-061) and quota enforcement — estimates are shown to the user for confirmation, but only actuals count against quota, since providers occasionally bill differently than their advertised structure suggests (e.g. cached-token discounts).

## Budget alerts (P1, not P0)

A per-project configurable spend threshold that triggers a notification (not an automatic hard stop beyond the quota mechanism above) when crossed — implemented once the usage dashboard (Phase 10/11) exists to display it against, not before.

## Interaction with provider fallback ([[12_MODEL_ROUTING]])

Cost is one of the explicit routing inputs in [[12_MODEL_ROUTING]]'s router design — a fallback triggered by a primary provider's failure must re-estimate cost against the fallback model before proceeding, since fallback models can have different (sometimes higher) rates; the router does not fall back to a more expensive model silently past a request's estimated-cost ceiling without the same confirmation gate long-form video uses.

## What this deliberately does not do yet

No real billing/invoicing integration (Stripe et al.) — quotas are a usage-limiting control for a single-operator/small-team deployment ([[00_PROJECT_VISION]]'s stated initial audience), not a monetization system. That is explicitly out of scope per [[01_REQUIREMENTS]]'s non-goals until multi-tenant SaaS is revisited.
