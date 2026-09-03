# Final Audit

Point-in-time audit, produced at Phase 15 per [[25_IMPLEMENTATION_ROADMAP]]'s exit criteria and
[[30_FINAL_SYSTEM_SPEC]]'s own instruction ("each divergence found gets a line here, categorized
by severity, not silently reconciled by editing this spec to match whatever was actually built").
[[27_RISKS_AND_LIMITATIONS]] tracks standing, structural risks going forward; this file is a
snapshot of what was actually checked, on 2026-09-02, and what was found.

## Methodology

Two passes, run independently so the audit couldn't just confirm its own author's assumptions:

1. **An independent research agent**, given no access to this session's own record of what was
   built, was asked to re-verify [[29_FEATURE_MATRIX]] against real source/test files (not the
   feature matrix's own prose) and to directly answer [[30_FINAL_SYSTEM_SPEC]]'s three self-posed
   verification questions.
2. **Direct verification** of the fixes below (typecheck/build/test/audit all green; live curl
   sessions against a running server for the new cost/quota work — see ADR-038) after they were
   made, not just trusted from the finding.

## Findings

| # | Finding | Evidence | Severity | Outcome |
|---|---|---|---|---|
| 1 | [[30_FINAL_SYSTEM_SPEC]] listed **"auth"** under "Real, provider-swappable" components (prose and diagram) | Zero JWT/session/login/auth-plugin code anywhere in `apps/api/src` (confirmed by grep across the whole route/plugin tree); [[29_FEATURE_MATRIX]] row 25 correctly says "NOT STARTED," consistent with ADR-008's single-operator scope | **CRITICAL** — exactly the "claimed-working capability that's actually fake" pattern this audit exists to catch, in the one document whose own stated purpose is to be re-validated at this phase | **FIXED** — docs/30's prose and diagram corrected to show auth as not-started, not real (this same file, [[26_DECISIONS]] ADR-038) |
| 2 | docs/30's system diagram shows a separate `apps/worker` app | Only `apps/api` and `apps/web` exist under `apps/`; the worker runs in-process within `apps/api` (ADR-027) — already correctly explained in docs/29's Phase 7 narrative, just not reflected in docs/30's diagram | MEDIUM — real, but already well-documented elsewhere; a stale diagram box, not a hidden gap | **FIXED** — diagram box annotated in place to show target-vs-actual, not deleted (the target design stays visible) |
| 3 | docs/30's system diagram shows `media --> storage[(...GCS prod)]` as if a GCS adapter exists | Only `LocalAssetStore` exists (`packages/media/src/asset-store.ts`); no `@google-cloud/storage` import anywhere in the repo; ADR-037 already tracks this as an open gap for a real Cloud Run deploy | MEDIUM — consistent with docs/30's own "documented, not provisioned" prose caveat; diagram implied more than the caveat covered | **FIXED** — same annotation treatment as #2 |
| 4 | `packages/model-router`'s fallback-order/no-mid-stream-retry logic had never been locked in as an automated test — only manually verified once, live, in Phase 2 | No test file existed for this package before this phase; docs/29 row 18 said "verified against live... API calls," which is true but easy to misread as "and covered by a regression test" | LOW/MEDIUM — the code itself was confirmed correct (matches [[12_MODEL_ROUTING]] exactly); the gap was coverage, not correctness | **FIXED** — 5 new tests (`router.test.ts`) using real fake `LLMProvider`s: explicit-provider requests never silently substituted even on failure; fallback on a pre-first-event failure; fallback on a real `error` event; no fallback once a real token has streamed; the whole chain exhausting throws |
| 5 | Does `packages/model-router` actually implement docs/12's fallback design? (docs/30's own question) | `router.ts:18-76` read directly: explicit-provider requests get no substitution; unnamed-provider requests fall back through the registry, but only before the first real stream event, never mid-stream | N/A | **CONFIRMED ACCURATE** |
| 6 | Does the agent execution UI actually render the state machine live? (docs/30's own question) | `apps/web/app/agent/TaskDetail.tsx` uses a real `EventSource` (`use-task-events.ts`) against the real `/api/v1/agent/tasks/:id/events` SSE route | N/A | **CONFIRMED ACCURATE** |
| 7 | Does a deliberately-failed video scene actually only regenerate that scene? (docs/30's own question) | `packages/media/src/video-pipeline.integration.test.ts:86-143` — a real, passing test asserting the other three scenes' `assetId`/`updatedAt` are byte-for-byte unchanged after a targeted failure-and-retry | N/A | **CONFIRMED ACCURATE** |
| 8 | Terminal-tool RCE fix scope claim (docs/29 row 36/Phase 11) | `packages/tools/src/native/terminal.ts:85-99` rejects every argument starting with `-`, not just the first — matches the claimed broadened fix | N/A | **CONFIRMED ACCURATE** |
| 9 | Test-count claim (docs/29 row 35, prior to this phase's own additions) | A live `npm test` run at audit time showed 24 files / 102 tests, matching the claim exactly | N/A | **CONFIRMED ACCURATE** |
| 10 | Usage tracking / cost tracking / admin controls (docs/29 rows 26-28) said NOT STARTED | Confirmed via grep — no matching implementation existed anywhere at audit time | N/A | **CONFIRMED ACCURATE at the time** — rows 26/27 subsequently built this same phase (ADR-038); row 26/27 statuses updated to MVP DONE; row 28 (admin controls) remains NOT STARTED, correctly |
| 11 | Coding agent's literal-fix pipeline and storyboard's `ceil(duration/clipLength)` formula | Both confirmed present in source exactly as docs/29 describes (`planner.ts:249`, `video-storyboard.ts:22`) | N/A | **CONFIRMED ACCURATE** |

## Feature matrix spot-check coverage

Beyond the findings above, this pass directly re-verified (not just re-read): provider adapters'
real token-usage parsing, the model router's fallback state machine end to end, the agent
execution UI's live SSE rendering, long-form video's per-scene resumability, the terminal RCE
fix's exact scope, and the platform's real test count — a cross-section spanning agent-core,
model-router, media, tools, and the frontend, not a single subsystem. Rows not directly
re-verified in this pass (e.g. individual RAG/coding-agent claims) were left as-is because they
already carry their own dated, specific verification evidence in docs/29's narrative sections
from the phase that built them, and nothing in this audit contradicted them.

## Exit criteria (docs/25_IMPLEMENTATION_ROADMAP.md Phase 15)

- **"FINAL_AUDIT.md exists with zero open CRITICAL items"** — met. One CRITICAL finding (#1)
  was identified and fixed within this same phase, not left open.
- **"Every item in [[29_FEATURE_MATRIX]] has an accurate, current status"** — met for everything
  this audit touched; the feature matrix itself is updated every phase as a standing discipline,
  and this audit is the first pass verifying that discipline against reality with independent
  eyes rather than trusting the log of changes as its own proof.

## What this audit did not do

It did not re-verify every one of the ~37 rows in [[29_FEATURE_MATRIX]] line by line against
source — that would duplicate the verification work already documented, dated, and evidenced in
each phase's own narrative section. It spot-checked a representative cross-section plus every
specific question [[30_FINAL_SYSTEM_SPEC]] itself named, and found the codebase's own
self-documentation holds up well: the real divergences were concentrated in one document (docs/30)
that had simply never been re-read against reality since Phase 0, exactly the risk its own
closing section warned about.

## Post-audit follow-ups (dated addenda; the audit above is the 2026-09-02 snapshot)

- **2026-09-03 — finding #2's underlying gap closed ([[26_DECISIONS]] ADR-039).** The worker is now a
  real separate deployable: the same `apps/api` image run with `ROLE=worker` as a Cloud Run worker
  pool. Verified live in each role individually (including a real cross-process job hand-off
  through pg-boss); the two roles have not yet run concurrently against one shared database —
  this sandbox cannot (PGlite), which is now the row in [[27_RISKS_AND_LIMITATIONS]] that replaced
  the "worker runs in-process" one. docs/30's diagram box was updated accordingly.
- **2026-09-03 — finding #3's underlying gap closed for generated assets ([[26_DECISIONS]] ADR-040).**
  A real `CloudStorageAssetStore` now sits behind an `AssetStore` interface alongside the local
  one; verified byte-for-byte through the real client against a `fake-gcs-server` emulator
  (tests + a live API session), never yet against real GCS. The live session found and fixed a
  real read-path bug the passing tests had missed. The RAG/coding-agent `SANDBOX_ROOT` remains
  local disk — now the single remaining local-disk dependency ([[27_RISKS_AND_LIMITATIONS]]).
  docs/30's storage diagram box was updated accordingly.
- **2026-09-03 — RAG's local-disk dependency closed ([[26_DECISIONS]] ADR-041).** A real multipart
  upload ingress stores documents through the same asset store and feeds the same ingest job;
  verified live through to a retrieval answer, including the rejection paths. docs/13 §12's
  controls — which ADR-032 had recorded as "N/A, no upload endpoint" — are now implemented and
  tested, except malware scanning (a new [[27_RISKS_AND_LIMITATIONS]] row). What remains under
  `SANDBOX_ROOT` is the coding agent's per-run scratch directory, a legitimate use, not a gap.
