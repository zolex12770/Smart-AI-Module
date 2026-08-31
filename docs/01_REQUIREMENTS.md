# Requirements

Priorities: **P0** = required for the platform to be considered minimally viable · **P1** = important, near-term after P0 · **P2** = future enhancement · **P3** = optional/nice-to-have.

Each requirement: ID, Description, Priority, Dependencies, Acceptance Criteria. See [[29_FEATURE_MATRIX]] for current implementation status per requirement, and [[25_IMPLEMENTATION_ROADMAP]] for which phase delivers it.

## Functional Requirements

### Chat & Core Agent

| ID | Description | Priority | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| FR-001 | User can send a text message and receive a streamed response from a configured LLM provider. | P0 | Model provider adapter ([[04_MODEL_PROVIDER_RESEARCH]]) | Tokens appear incrementally in the UI within 2s of request; final message persisted to conversation history. |
| FR-002 | System supports at least one real LLM provider (Anthropic, OpenAI, or Google) plus a mock provider usable with zero credentials. | P0 | [[26_DECISIONS]] ADR-010 | Setting `ANTHROPIC_API_KEY` (or equivalent) switches the default provider from mock to real with no code change. |
| FR-003 | Conversation history persists across sessions for a given user. | P0 | Database ([[14_DATABASE_ARCHITECTURE]]) | Reloading the app shows prior messages in the same conversation. |
| FR-004 | Agent can execute multi-step tasks: plan → execute → observe → verify → correct → finalize, not single-shot Q&A only. | P0 | [[11_AGENT_LOOP]] | Given a task requiring 2+ tool calls, the agent's plan and intermediate steps are visible and the final answer reflects tool output, not a hallucinated guess. |
| FR-005 | Agent state (plan, current step, tool results) is persisted and recoverable after a server restart mid-task. | P1 | [[11_AGENT_LOOP]], job persistence | Killing and restarting the API process resumes an in-flight task from its last completed step, not from scratch. |
| FR-006 | User can cancel an in-flight agent task. | P1 | [[11_AGENT_LOOP]] | Cancel request transitions task to `CANCELLED` within one step boundary; no further model/tool calls are made for that task. |
| FR-007 | High-risk agent actions (e.g. destructive file/shell operations) require explicit human approval before executing. | P0 | [[13_SECURITY_ARCHITECTURE]] | Agent proposing a destructive tool call pauses in `WAITING_FOR_APPROVAL` until the user approves or rejects. |

### Coding Agent

| ID | Description | Priority | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| FR-010 | Coding agent can read and search an existing repository's files. | P0 | Filesystem tool ([[10_TOOL_AND_MCP_ARCHITECTURE]]) | Given a repo path, agent can answer "where is X defined" correctly for a known symbol. |
| FR-011 | Coding agent can propose and apply scoped multi-file edits, not whole-repo rewrites. | P0 | FR-010 | Edit operations are diff-based and limited to files the plan explicitly names. |
| FR-012 | Coding agent can run tests/build/lint via a sandboxed terminal tool and read the output. | P0 | Terminal tool, sandboxing ([[13_SECURITY_ARCHITECTURE]]) | Agent detects a failing test from real command output and attempts a targeted fix, not a guess. |
| FR-013 | Coding agent maintains a record of files changed, commands run, and decisions made for a task, viewable by the user. | P1 | [[25_AGENT_EXECUTION_UI|16_FRONTEND_ARCHITECTURE]] | Task detail view lists every file touched and every command executed for that task. |
| FR-014 | Coding agent never executes destructive commands (`rm -rf`, force-push, etc.) without explicit approval. | P0 | FR-007 | Command allow/deny-list blocks or gates destructive patterns before execution. |

### Tools & MCP

| ID | Description | Priority | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| FR-020 | Platform exposes a tool registry with schema-validated inputs/outputs per tool. | P0 | [[10_TOOL_AND_MCP_ARCHITECTURE]] | Calling a tool with invalid input is rejected before execution with a clear validation error. |
| FR-021 | Platform can register and invoke external MCP servers as tools. | P1 | [[10_TOOL_AND_MCP_ARCHITECTURE]] | An MCP server added via config appears in the tool list and its tools are callable by the agent. |
| FR-022 | Each tool declares a risk level and permission requirement; high-risk tools require approval or explicit user opt-in. | P0 | FR-007 | Attempting to call a high-risk tool without prior opt-in is blocked, not silently allowed. |
| FR-023 | Untrusted content from tools/web/documents/MCP output is never treated as instructions with system/developer authority. | P0 | [[13_SECURITY_ARCHITECTURE]] | A crafted prompt-injection payload embedded in fetched web content does not cause the agent to execute an unapproved high-risk action. |

### Memory & RAG

| ID | Description | Priority | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| FR-030 | Long conversations are summarized rather than truncated silently once they exceed the model's practical context budget. | P1 | [[08_MEMORY_ARCHITECTURE]] | A conversation exceeding the summarization threshold still produces coherent answers referencing early context. |
| FR-031 | User can upload a document (PDF/DOCX/Markdown/TXT/CSV) and ask questions answered from its content with citations. | P1 | [[09_RAG_ARCHITECTURE]] | Answer includes a reference back to the source chunk/page used. |
| FR-032 | User can view and delete stored memory (facts, summaries) associated with their account. | P1 | [[08_MEMORY_ARCHITECTURE]] | Deleting a memory item removes it from future retrieval immediately. |

### Media Generation

| ID | Description | Priority | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| FR-040 | Platform exposes a provider-agnostic image generation interface with a working mock implementation. | P1 | [[05_IMAGE_GENERATION_RESEARCH]], [[26_DECISIONS]] ADR-009 | Requesting an image with no real provider key returns a clearly-labeled mock result via the same API shape a real provider would use. |
| FR-041 | Real image provider integration activates automatically when the corresponding API key is configured. | P2 | FR-040 | Setting the provider's API key switches `ImageProvider` from mock to real with no code change. |
| FR-042 | Platform exposes a provider-agnostic video generation interface with a working mock implementation, job-based (async, with progress). | P2 | [[06_VIDEO_GENERATION_RESEARCH]], [[07_LONG_RUNNING_JOB_ARCHITECTURE]] | Requesting a video returns a job id immediately; polling shows progress; completion returns a (mock) asset. |
| FR-043 | Long-form video requests (target duration exceeding any single provider call's limit) are decomposed into a scene manifest and generated/assembled incrementally, resumable per-scene on failure. | P2 | FR-042, [[07_LONG_RUNNING_JOB_ARCHITECTURE]] | A failed scene N out of M regenerates only scene N, and the final assembled timeline includes all M scenes in order. |

### Jobs, Streaming, API

| ID | Description | Priority | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| FR-050 | Long-running work (media generation, large agent tasks) runs as a persisted, resumable job, never a single blocking HTTP request. | P0 (for jobs that exist) | [[07_LONG_RUNNING_JOB_ARCHITECTURE]] | A job survives an API process restart and resumes/reports correctly. |
| FR-051 | Platform exposes a versioned HTTP API (`/api/v1/...`) usable independently of the web UI. | P1 | [[15_API_ARCHITECTURE]] | A `curl`/API-client call to `/api/v1/chat` works without a browser session, using an API key. |
| FR-052 | Chat and agent execution events stream to the client (tokens, plan steps, tool calls, progress). | P0 | [[15_API_ARCHITECTURE]] | UI updates incrementally during a multi-step task rather than only at completion. |

### Platform: Auth, Usage, Admin

| ID | Description | Priority | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| FR-060 | User authentication (sign up / log in / session) works without any third-party paid dependency. | P0 | [[26_DECISIONS]] ADR-008 | A new user can register and log in using only the local database, no external service call. |
| FR-061 | Every model/tool/job invocation records token/time/cost-estimate usage attributable to a user and task. | P1 | [[22_COST_AND_QUOTA_STRATEGY]] | Usage dashboard shows per-user token and estimated-cost totals matching recorded invocations. |
| FR-062 | Admin can view system-wide usage, configured providers, and job queue health. | P2 | FR-061 | Admin view shows queue depth and per-provider error rate. |
| FR-063 | Per-user/project quotas can be configured and enforced (daily/monthly token or generation limits). | P2 | FR-061 | Exceeding a configured quota blocks further generation with a clear error, not a silent overage. |

## Non-Functional Requirements

| ID | Category | Description | Priority | Acceptance Criteria |
|---|---|---|---|---|
| NFR-001 | Security | No secret/API key ever appears in source control, client-side code, or logs. | P0 | Repo secret scan and log review find zero occurrences. |
| NFR-002 | Security | All external-facing input (API bodies, file uploads, tool arguments) is schema-validated before use. | P0 | Fuzzed/malformed input returns a 4xx validation error, never a 5xx crash. |
| NFR-003 | Reliability | External provider failures degrade gracefully (retry with backoff, then fallback provider or clear user-facing error) rather than crashing the request. | P0 | Simulated provider 500/timeout results in a retried call, then a handled error — not an unhandled exception. |
| NFR-004 | Reliability | Long-running jobs are idempotent under retry (no duplicate charges/assets from a retried step). | P1 | Re-running a job step with the same idempotency key does not create a duplicate asset. |
| NFR-005 | Performance | Chat first-token latency is dominated by provider latency, not platform overhead (platform adds <200ms before the provider call starts). | P1 | Measured platform-side overhead stays under 200ms in local benchmarking. |
| NFR-006 | Performance | Image generation UX reports progress/results fast enough to feel responsive even though actual generation is provider-bound (see [[05_IMAGE_GENERATION_RESEARCH]] for real fast-tier latencies). | P2 | UI shows a status update within 500ms of job submission, never a blank wait state. |
| NFR-007 | Scalability | Stateless API/worker processes (session/job state in the database, not process memory) so horizontal scaling is a deployment change, not a code change. | P1 | Killing one of N running API instances does not lose in-flight state for requests routed to other instances. |
| NFR-008 | Privacy | User can delete their account and associated data (conversations, memory, assets). | P1 | Deletion request removes rows/objects across all owning tables/buckets within a documented window. |
| NFR-009 | Cost | No code path can trigger unbounded-cost provider usage (e.g. an infinite agent retry loop calling a paid model). | P0 | Retry/step counts are bounded and enforced in code, verified by a test that a runaway loop terminates. |
| NFR-010 | Developer Experience | A fresh clone runs locally with `npm install` + one documented setup command, no required Docker/cloud account for the Phase-1 milestone. | P0 | Followed literally on a clean machine matching [[26_DECISIONS]] ADR-006, the app starts and chat works against the mock provider. |
| NFR-011 | Maintainability | Provider-specific code is isolated to adapter packages; core agent/business logic contains no provider-specific branching. | P1 | Grep for provider SDK imports outside `packages/providers` returns nothing. |
| NFR-012 | Observability | Every request/task/job carries a correlation id traceable end-to-end through logs. | P1 | A single request id can be grepped across API, worker, and provider-call logs for one operation. |

## Explicit Non-Goals (for now)

- Training or fine-tuning foundation models.
- Public multi-tenant self-serve sign-up with billing (P3 — architecture should not preclude it, but it is not built now).
- Real image/video provider integration without user-supplied credentials ([[26_DECISIONS]] ADR-009).
- Actual cloud provisioning ([[26_DECISIONS]] ADR-011) — architecture and IaC only until authorized.
