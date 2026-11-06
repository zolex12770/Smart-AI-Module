# Gap Analysis

**Updated:** 2026-11-06
**Branch:** `antigravity/universal-agent`
**Anchor Commit:** `cdd827a8800ab701fa849eeafc2ec9af18fc6ef4`
**Current Verdict:** `INTERNAL_GATES_PASS_EXTERNAL_DEPENDENCIES_REMAIN`

---

## 1. Resolved Internally in Milestone 7

| ID | Issue / Gap | Root Cause | Resolution | Verification Evidence |
|---|---|---|---|---|
| **M7-1** | Windows backend Vitest flakiness / timeouts | Concurrent PGlite embedded database startup contention across multiple test files on Windows. | Added `fileParallelism: false` to `backend/vitest.config.ts`. | All 46 test files and 281 tests in `@ai-platform/api` passed cleanly (exit code 0). |
| **M7-2** | Monorepo dependency security advisories | Vulnerable transitive dependencies in Fastify, Next.js, undici, and Zod. | Upgraded to Zod 4.6.7, Fastify 5.12.7, Next.js 16.4.3, undici 7.30.1, uuid 14.0.3, and GCS 8.4.0; refreshed lockfile. | `npm audit --audit-level=high --omit=dev` reports 0 vulnerabilities. |
| **M7-3** | Zod 4 enum schema widening | Zod v4 `z.enum([...])` widened array types to generic string arrays without explicit `as const`. | Enforced `as const` on enum arrays across `shared/src/` contracts and backend routes (`agent.ts`, `rag.ts`, `config.ts`). | `npm run typecheck` passes 100% across all 28 workspaces with 0 errors. |
| **M7-4** | Frontend typecheck missing test peer | Missing `@testing-library/dom` peer dependency for `@testing-library/react`. | Added `@testing-library/dom` to `frontend/package.json` devDependencies. | Clean `npm ci` and frontend typecheck pass. |
| **M7-5** | Fragmented test accounting across milestones | Reports quoted inconsistent test totals (1,014, 1,034, 1,037) due to unsynchronized ad-hoc test invocations. | Executed full reconciled workspace test suite (`test-accounting.json`) + Playwright E2E suite. | Total reconciled: 1,328 unit/integration tests (1,296 passed, 32 skipped) + 14 Playwright browser tests (14 passed) = 1,342 total tests. |
| **M7-6** | Browser E2E verification gap | Playwright browser E2E was previously not rerun under fresh dependencies. | Executed `npm run test:e2e --workspace=@ai-platform/web` on host Chrome (`chrome.exe`). | 14/14 tests PASSED across all 5 spec files (auth, sessions, account security, tasks, chat). |
| **M7-7** | Security attack & local acceptance gap | Verification of live attack resistance was needed against active backend. | Ran `scripts/acceptance/attacks.mjs` and `scripts/accept-local.mjs` on `:8787`. | 11/11 attack probes PASSED; 15/15 local acceptance checks PASSED. |

---

## 2. Remaining Internal Product Gaps

| Gap | Current State | Remediation Path |
|---|---|---|
| **OCR for Scanned PDFs** | Searchable PDFs and DOCX are parsed accurately. Scanned/image-only PDFs return an explicit error stating no extractable text was found rather than inventing text. | Integrate Tesseract.js / native OCR engine and pdf-to-image renderer when OCR binary dependencies are provisioned. |
| **Console Warnings in Lint** | `npm run lint` completes with 0 errors, but outputs 5 console warnings from CLI/bootstrap/test scripts. | Clean up remaining `console.log` statements in non-production CLI scripts. |

---

## 3. External Blockers (Host & Cloud Constraints)

These capabilities are completely implemented in the codebase and verified with mock/fallback unit tests, but require external assets, hardware, or credentials to operate live:

| External Blocker | Impacted Capability | What Is Needed to Activate Live | Fallback / Honest Status |
|---|---|---|---|
| **Local LLM Runtime (Ollama / vLLM)** | Live local neural chat, reasoning, and semantic embeddings | Install Ollama on host, run `ollama pull qwen2.5:7b` and `ollama pull nomic-embed-text`. | `DEGRADED` (deterministic lexical feature hash embeddings and labelled mock chat provider). |
| **Hosted LLM API Keys** | Hosted provider adapters (`@ai-platform/llm-openai`, `llm-anthropic`, `llm-google`) | Provision valid `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`. | `BLOCKED_EXTERNAL` (adapters verified via fixture tests; API refuses unconfigured providers). |
| **FFmpeg Binary on PATH** | Long-form video assembly, audio-video muxing, measured audio durations | Install FFmpeg on host and add to Windows PATH or set `FFMPEG_PATH`. | `DEGRADED` (video generates animated GIF placeholders; speech audio narration skipped). |
| **Piper TTS / Speech Weights** | Local text-to-speech narration | Download Piper executable and ONNX voice model weights. | `DEGRADED` (pipeline renders video scenes without speech narration and reports explicit status). |
| **Diffusion Weights (SDXL)** | Local high-resolution image generation | Install `stable-diffusion.cpp` binary and download SDXL `.safetensors` model weights. | `DEGRADED` (generates labelled SVG placeholder images). |
| **Web Search API Key** | Live internet search tool | Provision Brave Search API key in `BRAVE_SEARCH_API_KEY`. | `DEGRADED` (SSRF-safe direct web fetch works; search tool returns mock/refusal). |
| **Authorized IRCTC Portal API** | Live rail ticket booking | Enterprise IRCTC partner credentials, production payment gateway, and OTP/CAPTCHA handler. | `DEGRADED / SIMULATION ONLY` (safe travel orchestration engine tested with strict user approval gates; no fake live booking). |
| **Docker Daemon & Terraform CLI** | Full containerized execution & GCP Cloud Run / Cloud SQL deployment | Install Docker Desktop for Windows; provision GCP service account credentials with Cloud Run admin roles. | `BLOCKED_EXTERNAL` (process sandbox fallback active for local development; boot script verifies production refusal). |
