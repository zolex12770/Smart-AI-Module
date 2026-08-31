# Project Vision

## What this is

A modular, model-agnostic AI agent platform: one system that provides general chat, an autonomous multi-step task agent, a dedicated coding agent, media generation (image and video, initially mocked), document/RAG understanding, and tool/MCP integration — all behind a consistent architecture where the underlying AI providers are swappable configuration, not hardcoded assumptions.

## What this is not

- Not a foundation-model training effort. We orchestrate existing model APIs (Anthropic, OpenAI, Google, and open-source/self-hosted where an OpenAI-compatible endpoint exists) — see [[04_MODEL_PROVIDER_RESEARCH]].
- Not a clone of any single existing agent product. [[03_EXISTING_AGENT_ARCHITECTURES]] studies public architectures for concepts, not for verbatim reproduction.
- Not a one-release product. This is a staged program (see [[25_IMPLEMENTATION_ROADMAP]]): a working core (chat + coding agent + tools) ships first; media generation, long-form video, and cloud production hardening are later phases, explicitly gated on real credentials/budget the user provides when ready (see [[26_DECISIONS]], ADR-009 and ADR-011).

## Why model-agnostic

Locking the architecture to one vendor's API shape creates two failure modes this project explicitly avoids: (1) a provider outage or pricing change becomes an outage or cost shock for the whole platform, and (2) every new capability (better tool calling, longer context, cheaper fast tier) requires an architecture change instead of a config change. The `ProviderAdapter` pattern (see [[12_MODEL_ROUTING]]) normalizes provider differences behind one internal interface so routing, fallback, and cost decisions are made once, centrally.

## Guiding principles (in priority order)

1. **Honesty over appearance of completeness.** A mocked provider is labeled as mocked. A pending integration is documented with exactly what credential unlocks it, never silently faked. See [[26_DECISIONS]] ADR-009.
2. **Reliability and security before feature breadth.** An agent that can run arbitrary shell commands and edit files is a real risk surface — sandboxing, permissioning, and prompt-injection defense (see [[13_SECURITY_ARCHITECTURE]]) are load-bearing, not polish.
3. **Small, real, working increments over large, speculative scaffolding.** Every phase in [[25_IMPLEMENTATION_ROADMAP]] ends with something that actually runs and is verified, not just files that exist.
4. **Provider-agnostic, not provider-naive.** Abstractions are informed by concretely researching real provider APIs ([[04_MODEL_PROVIDER_RESEARCH]], [[05_IMAGE_GENERATION_RESEARCH]], [[06_VIDEO_GENERATION_RESEARCH]]), not designed in the abstract and hoped to fit later.
5. **Cost and blast radius are first-class design inputs.** Long-running, potentially expensive generation (video especially) is asynchronous, resumable, and budget-aware by design (see [[07_LONG_RUNNING_JOB_ARCHITECTURE]], [[22_COST_AND_QUOTA_STRATEGY]]), never a blocking, unbounded-cost HTTP call.

## Primary user-facing capabilities (target end state)

See [[29_FEATURE_MATRIX]] for the authoritative, status-tracked list. In summary: chat, autonomous task execution, a coding agent operating on real repositories, tool calling and MCP integration, agent/user/project memory, RAG over uploaded documents, image generation (fast + standard), video generation including long-form (20+ minute) orchestrated output, async job management with progress/cancel/resume, and the supporting platform concerns (auth, usage/cost tracking, admin, observability, and cloud deployment).

## Who this is for (initial)

A single developer/operator running this locally and, later, deploying it for themselves or a small team — not initially a multi-tenant SaaS for the general public. Multi-tenant concerns (per-org billing, public sign-up, abuse prevention at scale) are documented in the requirements ([[01_REQUIREMENTS]]) as P2/P3, not blockers for the initial working system.
