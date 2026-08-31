# Project Status

Read this file first at the start of any session, along with `README.md`, `docs/25_IMPLEMENTATION_ROADMAP.md`, and `docs/26_DECISIONS.md`, before inspecting the repository state.

## Current Phase

**Phases 0, 1, 3, and 4 are complete and verified.** Phase 2 (real LLM provider adapters) is next, or Phase 5 (coding agent, which builds directly on Phase 3/4's agent-core and tools). See [docs/25_IMPLEMENTATION_ROADMAP.md](docs/25_IMPLEMENTATION_ROADMAP.md).

## Completed

**Phase 0 (research + 31 docs)** and **Phase 1 (minimal chat loop)** — see git history; both verified for real (browser-driven testing caught and fixed two bugs in Phase 1: a CORS bug from `reply.hijack()`, and an error handler misreporting client errors as server crashes).

**Phase 3 (agent core) + Phase 4 (tools & MCP) — built together, both verified for real, not just written:**

- New packages: `packages/agent-core` (state machine + task graph engine, deterministic planner, template resolution, verification), `packages/tools` (registry + sandboxed native filesystem tools), `packages/mcp` (real MCP client).
- New DB tables: `tasks`, `task_nodes`, `task_transitions` (the last is a genuine append-only log, never updated/deleted — docs/11_AGENT_LOOP.md §4.1).
- New API routes: `POST/GET /api/v1/agent/tasks`, `GET .../events` (SSE), `POST .../approve`, `.../reject`, `.../cancel`, `GET /api/v1/tools`, `POST /api/v1/tools/:id/enable`.
- Four task types exercise the pipeline for real: `echo_chat` (single model-call node), `read_and_summarize` (native tool → model, two-step dependency graph with template resolution), `mcp_read_and_summarize` (same shape, but the read goes through a **real external MCP server subprocess**), `delete_sandbox_file` (destructive tool, exists specifically to exercise the approval gate).
- **Everything below was verified against a running server, not just read through in code review:**
  - Full state machine + task graph + persistence: multi-step task completes correctly, node/task rows and the transition log all correct.
  - Approval gate: a destructive tool call pauses at `WAITING_FOR_APPROVAL` and does **not** execute; approving it executes and the file is actually deleted; rejecting it cancels the task and the file survives.
  - Path-traversal protection: a `../../../etc`-style request is rejected by `resolveSandboxedPath`, retried per the tool's real retry policy, and the task correctly fails — see "Bug found and fixed" below for what this test actually caught.
  - Crash recovery, both branches of docs/11_AGENT_LOOP.md §4.3, tested by directly manipulating persisted state to simulate a crash and restarting the real process: a node crashed mid-model-call auto-resumes and completes; a node crashed mid-mutating-tool-call (`fs.delete_file`) surfaces as `needs_reconciliation` with the task `PAUSED`, and — critically — the file was **not** touched, proving no unsafe auto-retry of a destructive action.
  - Live SSE task/node event streaming — confirmed via a real `curl -N` session showing every state/node transition arrive in order.
  - Task cancellation.
  - Real MCP integration: spawned the actual `@modelcontextprotocol/server-filesystem` reference server as a subprocess over stdio, discovered its 14 real tools, confirmed they registered **disabled by default** (docs/10 §3.2's tool-poisoning mitigation), confirmed a call against a disabled MCP tool is rejected, explicitly enabled one (`mcp.reference-filesystem.read_text_file`), then ran a task that read a real file through the real external server and fed it into a model-call node — full round trip through a genuinely separate process, not a simulation.
- **One real, serious bug found and fixed by this testing:** the dispatcher's cascade-skip loop (marking dependents of a failed node as `skipped`) checked staleness against the original `nodes` array snapshot instead of the live `byId` map it was updating, so a node could never be seen as "already handled" — it looped forever, re-writing the same skip transition. Triggered for real by the path-traversal test above: **45,023 duplicate rows** were written to `task_transitions` in about 15 seconds before the process had to be killed, and the whole server (including unrelated requests like `/api/health`) became unresponsive, because the tight async loop was starving Node's event loop of any chance to service other I/O. Fixed in `packages/agent-core/src/engine.ts`'s `tick()` (now consistently reads from `byId`, never the stale array) plus a defense-in-depth hard iteration cap. Retested the exact failing scenario after the fix: correct 3-retry-then-fail behavior, server stayed fully responsive throughout.
- Deliberate, documented scope decisions (ADR-018, ADR-019, ADR-021 in [docs/26_DECISIONS.md](docs/26_DECISIONS.md)): planner is rule-based/deterministic, not LLM-driven (mock provider can't reason — building a "real" planner against it would be theater); only `atomic` task-graph nodes are executed (`sequential_group`/`parallel_group`/`conditional`/`loop`/`sub_agent` are reserved in the schema, not yet wired into the dispatcher); the plan-invalidating replan loop isn't wired up (deterministic replanning would just reproduce the same failing graph); MCP tool trust is a name-based heuristic (disabled-by-default is the real safety net, not the heuristic); the spawned MCP subprocess has no OS-level sandboxing yet (tracked as an open risk in docs/27, acceptable for now since it's our own reference server against our own sandbox directory).
- Full `npm run typecheck` and `npm run build` green across all 9 workspaces (added `agent-core`, `tools`, `mcp` to the original 6) after this work.

## Known Issues / Blockers

- None blocking Phase 2 or Phase 5. Phase 2 (real LLM providers) needs at least one real API key from the user to verify end-to-end beyond adapter unit tests. Phase 6 needs Postgres (Docker Desktop or a hosted free-tier Postgres). Phase 14 needs a real GCP project/billing.
- Remaining Phase 4 scope not yet done: terminal/git/web native tools, a dedicated automated prompt-injection fixture test (FR-023) — the manual path-traversal test covers a related but distinct attack class.
- The hydration-mismatch console warning noted after Phase 1 was not seen again during Phase 3/4 testing (all of which was via `curl`, not the browser) — still unconfirmed either way; low priority.

## Last Successful Test

2026-08-31 — full manual, curl-driven, and two real-crash-simulation verification of Phase 3/4 (agent core, tools, MCP), described above. `npm run build` and `npm run typecheck` both green across all 9 workspaces.

## Next Action

Two independent, unblocked options — pick based on what's most valuable next, they don't depend on each other:

1. **Phase 2 — real LLM provider adapters** (`llm-anthropic`, `llm-openai`, `llm-google` per docs/04, docs/28). Needs a real API key from the user for end-to-end verification; adapter code + fixture-based unit tests can start without one.
2. **Phase 5 — coding agent**, building directly on the now-complete agent-core + tools: add terminal/git tools (sandboxed, with the same permission-gating pattern already proven for filesystem tools), a `test_suite` verification method (currently throws — this is where it gets implemented), and a coding-specific planner or task type.

Either way: commit the completed Phase 3/4 work as its own checkpoint first (not yet committed as of this writing).
