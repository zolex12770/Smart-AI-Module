# Database Architecture

Builds on [[26_DECISIONS]] ADR-005/ADR-006: PostgreSQL + Drizzle ORM + pgvector as the target, SQLite (same Drizzle schema, a subset of features) for the Phase 1 milestone only.

**Update (Phase 6, 2026-08-31):** the Postgres migration happened as planned, but via PGlite — a real WASM-compiled Postgres engine running embedded in the Node process — rather than Docker or a hosted service, since neither was available without an action only the user could take and the user asked to proceed with Phase 6 immediately. See [[26_DECISIONS]] ADR-025 for the full reasoning; the repository-interface pattern below made this a new implementation, not a rewrite, exactly as designed.

## Repository pattern — why the schema isn't just "the Postgres schema"

Every table below is accessed through a repository interface defined in `packages/database/src/repositories/*.ts` (e.g. `ConversationRepository`, `JobRepository`). Phase 1 registers a SQLite implementation; Phase 6 onward registers the Postgres implementation. Application code (agent-core, API routes) depends only on the interface, never on `drizzle-orm/pg-core` or `drizzle-orm/sqlite-core` directly — this is what makes ADR-006's "SQLite now, Postgres later" swap a config change instead of a rewrite, and is enforced by the same import-boundary convention as ADR's provider isolation (NFR-011 in [[01_REQUIREMENTS]]).

Features that only make sense on Postgres (pgvector similarity search, `pg-boss` job tables per [[26_DECISIONS]] ADR-012) are simply absent from the SQLite implementation — callers that need them (RAG, jobs) aren't reachable until Phase 6+, when Postgres is already required.

## Core schema

```
users              id, email, password_hash, created_at, deleted_at
sessions            id, user_id, expires_at, created_at
api_keys             id, user_id, key_hash, label, scopes[], last_used_at, created_at, revoked_at
projects              id, owner_id, name, created_at, deleted_at
project_members        project_id, user_id, role  (RBAC — see docs/13_SECURITY_ARCHITECTURE.md)

conversations           id, project_id, user_id, title, created_at, archived_at
messages                 id, conversation_id, role, content, model_used, provider_used,
                          token_usage jsonb, created_at

tasks                     id, conversation_id, parent_task_id, type, status, plan jsonb,
                          created_at, completed_at
task_steps                 id, task_id, step_index, type, status, input jsonb, output jsonb,
                            model, tool_name, retry_count, started_at, completed_at
                            -- maps directly onto the task-graph node schema in docs/11_AGENT_LOOP.md

jobs                        id, type, status, payload jsonb, result jsonb, progress numeric,
                             idempotency_key unique, retry_count, run_at, started_at, completed_at
                             -- managed by pg-boss's own tables from Phase 7 onward; this row is
                             -- the domain-level mirror job workers update for UI-facing progress,
                             -- per the "cheap re-runnable stage vs. expensive stage" split in
                             -- docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md
job_events                   id, job_id, event_type, data jsonb, created_at

models                       id, provider, model_key, capabilities jsonb, cost_profile jsonb
                             -- populated from the CapabilityRegistry in docs/12_MODEL_ROUTING.md,
                             -- not hand-maintained per-row
providers                     id, name, kind (llm|image|video), config jsonb, enabled boolean

tools                          id, name, schema jsonb, permission_level, risk_level, timeout_ms
mcp_servers                     id, name, transport, config jsonb, trust_level, enabled boolean

memory_items                     id, scope (conversation|task|user|project|semantic), owner_id,
                                  content, embedding vector(N), provenance jsonb, created_at,
                                  superseded_by uuid null
                                  -- see docs/08_MEMORY_ARCHITECTURE.md for scope/promotion rules

documents                         id, project_id, filename, mime_type, storage_uri, checksum,
                                   status, created_at
document_chunks                    id, document_id, chunk_index, content, embedding vector(N),
                                    metadata jsonb
                                    -- docs/09_RAG_ARCHITECTURE.md's chunking/embedding pipeline output

assets                              id, type (image|video|audio|document|other), storage_uri,
                                     mime_type, size_bytes, checksum, user_id, project_id, task_id,
                                     created_at, metadata jsonb

scene_manifests                      id, video_job_id, scenes jsonb, timeline jsonb, status
                                      -- docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md's SceneManifest,
                                      -- persisted (not just in-memory) so a crashed worker resumes
                                      -- per-scene, not from scratch

usage_records                        id, user_id, project_id, task_id, provider, model,
                                      input_tokens, output_tokens, cost_estimate, created_at
                                      -- feeds docs/22_COST_AND_QUOTA_STRATEGY.md

audit_logs                          id, actor_id, action, resource_type, resource_id, metadata jsonb,
                                     created_at

settings                            key (pk), value jsonb, scope (global|user|project), owner_id
```

## Migrations

Drizzle Kit generates and applies migrations (`npm run db:migrate`). Every schema change ships as a migration file committed to `packages/database/migrations/` — no manual production schema edits, per the original brief's own rule 28. SQLite and Postgres each get their own migration directory since column types diverge (`vector`, `jsonb` are Postgres-only); the repository interface hides this from callers.

## Why embeddings live beside their owning rows, not in a separate vector DB

Per [[09_RAG_ARCHITECTURE]] and [[08_MEMORY_ARCHITECTURE]]'s independent recommendations: pgvector columns on `document_chunks` and `memory_items` keep a chunk/memory item and its vector in the same transactional unit as the row it describes, avoiding a dual-write consistency problem between a relational store and a separate vector store. Both docs document the same migration trigger (~5–10M chunks per tenant, or a missed latency SLA) for moving to a dedicated vector DB later — tracked as a standing item in [[27_RISKS_AND_LIMITATIONS]], not a current gap.

## Multi-tenancy note

`project_id` (not a separate `tenant_id`) is the isolation boundary for the initial single-operator/small-team scope in [[01_REQUIREMENTS]]. Every table that holds user content carries `project_id` or is reachable through a row that does, so row-level security policies (Postgres RLS) can be added in [[13_SECURITY_ARCHITECTURE]]'s hardening phase without a schema change if/when true multi-tenant SaaS (a P3 non-goal today) is revisited.
