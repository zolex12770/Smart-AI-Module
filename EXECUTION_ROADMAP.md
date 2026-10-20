# Execution Roadmap: Universal AI Agent Platform

**Plan Version:** 1.0.0  
**Status:** ACTIVE EXECUTION  
**Prioritization Standard:** P0 (Security/Corrupted State) → P1 (Core Workflows/Failures) → P2 (Architectural Foundations) → P3 (Advanced Capabilities & Tools) → P4 (UI/UX) → P5 (Benchmarks & Polish)

---

## 1. Roadmap Milestones & Phases

### Milestone 0: Baseline Establishment & Source-of-Truth Sync (COMPLETED)
- [x] Establish Git repository tracking from canonical origin (`Smart-AI-Module`).
- [x] Verify commit baseline (`b6e5f17`) and create working development branch `antigravity/universal-agent`.
- [x] Resolve Windows developer environment test compatibility issues (`vitest.config.ts`, symlink probe, `.sh` probe).
- [x] Execute clean install (`npm install`), compile all packages, and verify typecheck and boundaries (100% PASS).
- [x] Deliver initial baseline and forensic documentation suite.

---

### Milestone 1: Multi-Agent Team Collaboration & Autonomous Engine (P1/P2 - CURRENT)
- [ ] Design and implement `AgentTeam` and `SpecialistAgent` abstractions in `@ai-platform/agent-core`.
- [ ] Create specialized roles:
  - **Architect:** System design, decomposition, dependency graph creation.
  - **Coder:** Contextual codebase search, patch generation, test repair.
  - **Critic / Reviewer:** Static verification, security audit, regression check.
  - **Researcher:** Web retrieval, fact grounding, synthesis.
- [ ] Implement inter-agent structured message passing and consensus loop.
- [ ] Add unit and integration tests verifying multi-agent delegation and convergence.

---

### Milestone 2: Native Web Search Provider (`web.search`) (P3)
- [ ] Add `web.search` tool in `@ai-platform/tools`.
- [ ] Define input/output schemas (`query`, `limit`, `domain_filter` → `results: { title, url, snippet }[]`).
- [ ] Implement search provider adapters:
  - `MockSearchProvider` for deterministic, zero-credential unit/integration testing.
  - `BraveSearchProvider` / `GoogleSearchProvider` for live API retrieval.
- [ ] Enforce SSRF and domain safety policies on search query formatting.
- [ ] Add automated tests in `backend/packages/tools/src/native/web-search.test.ts`.

---

### Milestone 3: Authorized Travel Orchestration (IRCTC Tatkal Stress Test) (P3)
- [ ] Implement `IrctcWorkflowEngine` in `@ai-platform/agent-core` or dedicated workflow package.
- [ ] Implement journey parser & validator (origin, destination, date, class, quota, train number).
- [ ] Implement Tatkal booking window rules (AC at 10:00 AM IST, Non-AC at 11:00 AM IST).
- [ ] Implement availability checking with realistic latency simulation.
- [ ] Implement passenger form automation with strict input validation.
- [ ] Implement secure payment authorization gate:
  - Requires explicit user confirmation.
  - Surfaces exact transaction amount and railway booking reference.
  - Zero storage of payment credentials or account passwords.
- [ ] Implement contract and simulated tests for successful booking (PNR issuance), seat unavailability, session expiry, and payment refusal.

---

### Milestone 4: Production Benchmarks Suite (P4/P5)
- [ ] Create end-to-end benchmark scenarios covering conversational Q&A, research, code repair, long-form video, and travel orchestration.
- [ ] Record latency, token usage, cost accounting, and error recovery metrics.
- [ ] Produce structured benchmark report (`BENCHMARK_REPORT.md`).

---

### Milestone 5: GitHub Delivery & Release Verification (P5)
- [ ] Verify full regression suite (`npm run typecheck`, `npm run lint`, `npm test`, `npm run verify`).
- [ ] Commit reviewable, disciplined increments to `antigravity/universal-agent`.
- [ ] Push verified commits to canonical GitHub remote repository.
- [ ] Prepare PR / release documentation.
