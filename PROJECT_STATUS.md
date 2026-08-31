# Project Status

Read this file first at the start of any session, along with `README.md`, `docs/25_IMPLEMENTATION_ROADMAP.md`, and `docs/26_DECISIONS.md`, before inspecting the repository state.

## Current Phase

**Phases 0, 1, 3, 4, and 5 are complete and verified.** Phase 2 (real LLM provider adapters) is the natural next step — both the agent-core planner and the coding agent are currently deterministic/rule-based specifically because no real model key exists yet; Phase 2 is what lets them graduate to genuine reasoning. See [docs/25_IMPLEMENTATION_ROADMAP.md](docs/25_IMPLEMENTATION_ROADMAP.md).

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

**Phase 5 (coding agent) — built on Phase 3/4's agent-core and tools, verified for real:**

- New native tools: `terminal.run_command` (sandboxed, `node`-only allow-list, `child_process.spawn` with `shell: false` and an argument array — no shell-injection surface regardless of allow-list size), `code.parse_fix_directive`, `code.apply_literal_fix`.
- New task type `fix_failing_test`: run test → parse failure → apply fix → re-run test, four real tool-call nodes chained via the existing template-resolution mechanism.
- **Honest scope decision (ADR-022), same reasoning as ADR-018's planner:** the mock provider can't actually reason about arbitrary test failures and write a correct fix — that needs a real LLM (Phase 2). Rather than fake that with canned mock-provider text, the "fix" is a deterministic literal-value correction driven by a structured signal the test itself prints (`FIX_NEEDED path=... find=... replace=...`). This is a real, narrow, honestly-scoped automated-fix capability, not a simulation of a smarter one.
- **Verified against a running server:** set up a real two-file Node project (`math.js` with a wrong constant, `math.test.js` asserting the right one) in the sandbox; confirmed the test genuinely fails standalone; ran the `fix_failing_test` task and confirmed all four steps completed for real — the actual file on disk changed from `ANSWER = 41` to `ANSWER = 42`, and the final re-run genuinely reported `exitCode: 0` / `"PASS"`. Re-ran the same task afterward (test now passing) and confirmed it correctly fails with "nothing to fix" rather than fabricating a result. Directly verified the terminal tool's command allow-list rejects a non-`node` command (`bash -c "echo pwned"` → rejected).

## Known Issues / Blockers

- None blocking Phase 2 or Phase 5. Phase 2 (real LLM providers) needs at least one real API key from the user to verify end-to-end beyond adapter unit tests. Phase 6 needs Postgres (Docker Desktop or a hosted free-tier Postgres). Phase 14 needs a real GCP project/billing.
- Remaining Phase 4 scope not yet done: terminal/git/web native tools, a dedicated automated prompt-injection fixture test (FR-023) — the manual path-traversal test covers a related but distinct attack class.
- The hydration-mismatch console warning noted after Phase 1 was not seen again during Phase 3/4 testing (all of which was via `curl`, not the browser) — still unconfirmed either way; low priority.

## Last Successful Test

2026-08-31 — full manual, curl-driven verification of Phase 5 (coding agent): a real failing test was genuinely fixed on disk and re-verified passing, plus the honest "nothing to fix" and command-allow-list-rejection paths. `npm run build` and `npm run typecheck` both green across all 9 workspaces.

## Next Action

**Phase 2 — real LLM provider adapters** (`llm-anthropic`, `llm-openai`, `llm-google` per docs/04, docs/28) is the clear next step: it's what lets both the agent-core planner (ADR-018) and the coding agent (ADR-022) stop being deterministic/rule-based and start doing genuine reasoning — the single biggest capability unlock available right now. Needs a real API key from the user for end-to-end verification; adapter code + fixture-based unit tests can start without one.

Also still open, lower priority: terminal/git/web native tools beyond the `node`-only allow-list, multi-file coding-agent edits, a dedicated automated prompt-injection fixture test (FR-023).
