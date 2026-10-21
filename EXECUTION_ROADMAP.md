# Execution Roadmap: Universal AI Agent Platform

**Plan Version:** 1.1.0  
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

### Milestone 1: Multi-Agent Team Collaboration & Autonomous Engine (COMPLETED)
- [x] Design and implement `AgentTeam` and `SpecialistAgentConfig` abstractions in `@ai-platform/agent-core`.
- [x] Create specialized roles:
  - **Architect:** System design, decomposition, dependency graph creation, final synthesis.
  - **Coder:** Contextual codebase search, patch generation, implementation turns.
  - **Reviewer:** Adversarial critique, code quality inspection.
  - **Security Auditor:** Automated credential leakage scanning, shell escape checks, SSRF prevention.
  - **QA Engineer:** Pluggable automated test suite execution and failure attribution.
  - **Researcher:** Web retrieval, fact grounding, synthesis.
- [x] Implement inter-agent structured message passing and iterative consensus loop.
- [x] Implement objective evidence override: model approvals are rejected if security audit or QA runner detects faults.
- [x] Add automated test suite in `backend/packages/agent-core/src/team.test.ts` (7/7 tests passed).

---

### Milestone 2: Native Web Search Provider (`web.search`) (COMPLETED)
- [x] Add `web.search` tool in `@ai-platform/tools`.
- [x] Define input/output schemas (`query`, `limit`, `domain_filter` → `results: { title, url, snippet }[]`).
- [x] Implement search provider adapters:
  - `MockSearchProvider` for deterministic, zero-credential unit/integration testing.
  - `BraveSearchProvider` for live API retrieval via Brave Search.
- [x] Enforce SSRF and domain safety policies on search query formatting.
- [x] Wire `createWebSearchTools()` into backend tool registry alongside `web.fetch`.
- [x] Add automated tests in `backend/packages/tools/src/native/web-search.test.ts` (5/5 tests passed).

---

### Milestone 3: Authorized Travel Orchestration (IRCTC Tatkal Stress Test) (COMPLETED)
- [x] Implement `TravelOrchestrator` in `@ai-platform/agent-core/src/travel-orchestrator.ts`.
- [x] Implement journey parser & validator (origin, destination, date, class, quota, train number).
- [x] Implement Tatkal booking window rules (AC at 10:00 AM IST, Non-AC at 11:00 AM IST on the day prior to travel).
- [x] Implement availability checking with realistic latency simulation.
- [x] Implement passenger form automation with strict input validation (max 4 passengers for Tatkal).
- [x] Implement secure payment authorization gate:
  - Requires explicit user confirmation.
  - Surfaces exact transaction amount and railway booking reference.
  - Zero storage of payment credentials or account passwords.
- [x] Implement automated tests for successful booking (PNR issuance), Tatkal window closure, passenger limits, and payment refusal in `travel-orchestrator.test.ts` (9/9 tests passed).

---

### Milestone 4: Enhanced Task State Machine & FSM Hardening (COMPLETED)
- [x] Add `PARTIALLY_COMPLETED` and `BLOCKED` states to `taskStateSchema` in `@ai-platform/shared`.
- [x] Update `AgentEngine` in `@ai-platform/agent-core`:
  - When sub-nodes fail but at least one node succeeded, finalize task state as `PARTIALLY_COMPLETED` instead of total failure.
  - Emit typed `partially_completed` event with failing error details.
  - Include `PARTIALLY_COMPLETED` and `BLOCKED` in `TERMINAL_TASK_STATES`.

---

### Milestone 5: Production Benchmarks Suite & External Integrations (NEXT)
- [ ] Create end-to-end benchmark scenarios covering conversational Q&A, research, code repair, long-form video, and travel orchestration.
- [ ] Record latency, token usage, cost accounting, and error recovery metrics.
- [ ] Provision live credentials for model providers and live search (when authorized).
- [ ] Document local host setup for FFmpeg and Ollama in `docs/HOST_SETUP.md`.
