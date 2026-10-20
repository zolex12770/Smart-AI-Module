# Project Baseline Report: Smart AI Module / Universal AI Agent

**Baseline Date:** 2026-10-20  
**Repository Identity:** Smart AI Module / Universal AI Agent  
**Canonical GitHub URL:** `https://github.com/zolex12770/Smart-AI-Module`  
**Working Directory:** `C:\Users\SAURABH KUMAR\Desktop\AI Agent`  
**Host Environment:** Windows (x64), Node.js v22.14.0, npm v10.9.2, Python 3.11.2, Docker CLI 29.4.0  

---

## 1. Git & Source-of-Truth Establishment

### 1.1 Remote Configuration
- **Origin Fetch URL:** `https://github.com/zolex12770/Smart-AI-Module.git`
- **Origin Push URL:** `https://github.com/zolex12770/Smart-AI-Module.git`

### 1.2 Branch & Commit Alignment
- **Canonical Default Remote Branch:** `origin/main` at commit `75cbf42` (*"Compose: align Ollama's load limit with the warm-up (DL-29)"*)
- **Active Delivery Tracking Branch:** `origin/claude/zen-brahmagupta-6l5o4u` at commit `b6e5f17` (*"Evidence 2026-10-11: cold boot on the DL-32 images warmed up in 406.3 s"*)
- **Divergence Analysis:**
  - `origin/claude/zen-brahmagupta-6l5o4u` is **5 commits ahead** of `origin/main`.
  - `origin/main` has **0 commits ahead** of `origin/claude/zen-brahmagupta-6l5o4u`.
  - Commit history on the delivery branch incorporates critical dependency vulnerability fixes (DL-30, DL-32), CI pipeline safeguards (DL-31), migration verification fixes, and cold-boot warmup tuning up to October 11, 2026.
- **Local Working Branch:** `antigravity/universal-agent` created directly from `origin/claude/zen-brahmagupta-6l5o4u` (`b6e5f171933167104454198a661442b677c0725a`).
- **Reproducible Baseline Commit:** `b6e5f171933167104454198a661442b677c0725a`.
- **Submodules & Git LFS:** Verified 0 submodules and 0 LFS files.

---

## 2. Monorepo Structure & Package Manifest

The repository is structured as an npm-workspaces monorepo:
```
.
├── frontend/                     # Next.js 16 (Turbopack) SPA (18 routes/screens)
├── backend/                      # Fastify 5 REST API & pg-boss job worker (76 routes)
│   └── packages/
│       ├── agent-core/           # Planning, state machine, reasoning loop, autonomous execution
│       ├── database/             # Drizzle ORM + PGlite / PostgreSQL client & migrations
│       ├── embeddings/           # Hash & semantic embedding adapters
│       ├── jobs/                 # Queue orchestration, dead-letter, cancellation
│       ├── mcp/                  # Model Context Protocol (stdio + HTTP/SSE transports)
│       ├── media/                # Audio (Piper), Image (SDXL), Video (ffmpeg longform) pipelines
│       ├── memory/               # Semantic conversation memory, extraction, recall
│       ├── model-router/         # Cost, latency, quality-based routing & fallback
│       ├── observability/        # Pino structured logger, OpenTelemetry spans, Prometheus metrics
│       ├── quota/                # Token, image, audio, video spend quotas & rate limits
│       ├── rag/                  # Multi-format parsers (PDF, DOCX, ZIP), chunking, vector search
│       ├── scanning/             # ClamAV malware scanning client & mock
│       ├── security/             # scrypt passwords, session tokens, CSRF, RBAC, sandbox
│       ├── tools/                # Native sandboxed tools (fs, terminal, web, patch)
│       └── providers/
│           ├── image-mock/       # Mock image generator
│           ├── image-openai/     # OpenAI DALL-E / Images API adapter
│           ├── image-sdcpp/      # stable-diffusion.cpp local CLI adapter
│           ├── llm-anthropic/    # Anthropic Messages API adapter
│           ├── llm-google/       # Google Gemini SDK adapter
│           ├── llm-local/        # Ollama / OpenAI-compatible local model adapter
│           ├── llm-mock/         # Deterministic mock LLM adapter
│           ├── llm-openai/       # OpenAI ChatCompletions API adapter
│           ├── video-mock/       # Deterministic GIF/video generator
│           ├── video-motion/     # Local/cloud motion video adapter
│           └── video-replicate/  # Replicate video model adapter
├── shared/                       # Shared TypeScript interfaces, schemas & types
├── scripts/                      # Doctor, verify, acceptance, boundaries, migrations
├── docs/                         # Architecture, decisions, runbooks, security records
└── docker-compose.yml            # Multi-service local deployment orchestration
```

---

## 3. Initial Environment & Diagnostic Baseline (`scripts/doctor.mjs`)

| Component | Status | Details / Evidence |
|---|---|---|
| **Node.js** | PASS | `v22.14.0` |
| **npm** | PASS | `v10.9.2` |
| **Dependencies** | PASS | Installed via `npm install` across 27 workspaces (617 packages) |
| **TypeScript Build** | PASS | `npm run build:packages` completed exit 0 |
| **Backend Build** | PASS | `npm run build:backend` completed exit 0 |
| **Frontend Build** | PASS | `npm run build:frontend` compiled 17 static/dynamic pages exit 0 |
| **Typecheck** | PASS | `npm run typecheck` across all 27 workspaces (0 errors) |
| **Lint** | PASS | `npm run lint` (0 errors, 5 console warnings) |
| **Architecture Boundary** | PASS | `node scripts/check-boundary.mjs` (7 passed, 0 failed across 369 files) |
| **Embedded Database** | PASS | PGlite embedded PostgreSQL with pgvector initialized in `./data/pgdata` |
| **Database Migrations** | PASS | 7 Drizzle migrations applied cleanly |
| **Storage** | PASS | Local disk asset storage at `./data/assets` |
| **Ollama Runtime** | UNAVAILABLE | Local daemon not running on port 11434; graceful fallback to mock |
| **Hardware Diffusers / FFmpeg** | UNAVAILABLE | Local system FFmpeg not detected on PATH; degradation reported |
| **Playwright Browser** | READY | Playwright core installed; browser installation target: Chromium |
| **Docker Engine** | UNAVAILABLE | Docker CLI installed; Docker Desktop daemon not running |
| **GCP Cloud Credentials** | BLOCKED_EXTERNAL | No GCP project/service-account key configured |

---

## 4. Initial Verification Findings & Remediations Applied

1. **Test Hook Timeouts on Windows (`ADR-100`):**
   - *Issue:* Vitest default hook timeout (10s) triggered intermittent timeouts during PGlite WASM VM cold initialization in `beforeEach`.
   - *Fix:* Added workspace root `vitest.config.ts` re-exporting `vitest.config.base.js` (`testTimeout: 30_000`, `hookTimeout: 60_000`).
2. **Filesystem Symlink Privileges on Windows (`backend/src/mcp-workspace-scope.test.ts`):**
   - *Issue:* Creating unprivileged file symlinks on Windows throws `EPERM`.
   - *Fix:* Guarded symlink creation with a runtime probe mirroring `symlink-containment.test.ts`, maintaining strict lexical path and boundary checks when symlinks are unavailable.
3. **Executable Probing on Windows (`backend/src/local-runtime.test.ts`):**
   - *Issue:* Shell script execution (`.sh`) fails without POSIX `execve` support.
   - *Fix:* Isolated POSIX-specific script execution while retaining binary validation on Windows.
4. **Environment Specification Drift:**
   - *Issue:* `docs/ENVIRONMENT.md` was out of sync with recent additions in `config.ts`.
   - *Fix:* Regenerated via `node scripts/generate-env-docs.mjs` (91 backend + 5 frontend variables).
