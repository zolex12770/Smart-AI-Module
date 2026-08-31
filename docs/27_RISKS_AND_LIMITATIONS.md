# Risks & Limitations

Honest accounting, kept current. See [[FINAL_AUDIT|FINAL_AUDIT]] (created at the end of the program) for the point-in-time audit; this file tracks standing, structural risks.

## Structural limitations (true regardless of how well we build)

- **No provider can generate a single 20+ minute video clip as of this research (2026).** Long-form video is necessarily a scene-decomposition-and-assembly pipeline, not a native capability of any vendor API. See [[06_VIDEO_GENERATION_RESEARCH]] and [[07_LONG_RUNNING_JOB_ARCHITECTURE]]. We will not claim otherwise in product copy.
- **Cross-scene visual/character consistency in generated video is best-effort, not guaranteed**, even with reference images/seeds/character sheets. This is a known limitation of current generative video models, not a bug in our orchestration.
- **RAG retrieval quality is bounded by chunking/embedding choices and can miss or misattribute information**, especially on documents with complex layout (tables, scanned images). Citations reduce but do not eliminate the risk of a wrong answer being presented as document-grounded.
- **Prompt injection cannot be fully eliminated**, only mitigated (trust-level separation, approval gates on high-risk actions per [[13_SECURITY_ARCHITECTURE]]). Any agent that reads untrusted content and can take actions has residual risk.
- **Mock providers validate interface/orchestration correctness, not real output quality.** Passing all tests against `llm-mock`/`image-mock`/`video-mock` does not prove the real provider integration behaves identically — real-provider validation is a separate, explicit step once credentials exist (ADR-009).

## Project/environment-specific risks (current as of 2026-08-31)

| Risk | Impact | Mitigation | Status |
|---|---|---|---|
| No LLM provider API keys configured | Cannot validate real-provider adapters end-to-end until user supplies at least one key | MVP runs fully on mock provider (ADR-006, ADR-010); real adapters built and unit-tested against recorded fixtures, integration-tested once a key is available | OPEN — tracked in PROJECT_STATUS.md |
| No Docker/gcloud CLI on dev machine | Cannot locally exercise Postgres/Redis via Compose, cannot provision or test real cloud deployment | Phase 1–5 avoid the dependency entirely (SQLite, in-process jobs); Docker Desktop documented as a prerequisite before Phase 6; cloud deployment stays documentation/IaC-only until explicitly authorized (ADR-011) | OPEN, non-blocking for current phase |
| Solo engineering effort (one user, one agent) building a very large surface area | High risk of scope creep or shipping breadth without depth | Roadmap ([[25_IMPLEMENTATION_ROADMAP]]) enforces phase gating — each phase must be verified working before the next starts; feature matrix tracks honest status, not aspirational status | Ongoing discipline, not a one-time fix |
| Video/image generation costs can be large and unpredictable once real providers are wired in | Runaway spend if quotas aren't enforced before real keys are added | [[22_COST_AND_QUOTA_STRATEGY]] and FR-063 must ship before real media provider integration (FR-041/FR-042 real mode) goes live, not after | Planned gate — do not skip |
| Single relational database (Postgres+pgvector) may not scale to very large embedding volumes | Degraded RAG latency at high document/user counts | Documented migration path to a dedicated vector DB in [[09_RAG_ARCHITECTURE]]; not a current blocker | Accepted for current scale |

## Explicitly out of scope for the initial working system (see [[01_REQUIREMENTS]] non-goals)

- Foundation model training/fine-tuning.
- Public multi-tenant self-serve billing.
- Any real image/video/cloud spend without explicit, separate user authorization at that specific step.
