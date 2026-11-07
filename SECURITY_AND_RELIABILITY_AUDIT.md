# Security and Reliability Audit

**Updated:** 2026-11-06
**Branch:** `antigravity/universal-agent`
**Milestone 6 Anchor Commit:** `cdd827a8800ab701fa849eeafc2ec9af18fc6ef4`
**Scope:** Whole monorepo security posture, runtime attack simulation suite, dependency vulnerability audit, and reliability gates.

---

## 1. Dependency Security Audit

A clean install using `npm ci` and subsequent vulnerability scan:
```bash
npm audit --audit-level=high --omit=dev
```
**Result:** **`found 0 vulnerabilities`** (Exit Code 0).

### Key Remediations Applied:
- Upgraded `zod` to `^4.6.7` with monorepo overrides to resolve CVEs.
- Upgraded Fastify core to `5.12.7` and `body-parser` to `2.4.0`.
- Upgraded Next.js to `16.4.3` with Turbopack bundler.
- Upgraded `undici` to `7.30.1` and `@google-cloud/storage` to `8.4.0`.
- Enforced `as const` on enum arrays to maintain compile-time type safety under Zod 4.

---

## 2. Runtime Security Attack Suite

Executed via `node scripts/acceptance/attacks.mjs` against a live Fastify backend server on `:8787`:

| Probe ID | Attack Scenario | Probe Logic | Result |
|---|---|---|---|
| **ATTACK-01** | Unauthenticated Access | Probed all protected endpoints without credentials. | **PASS** (72 routes returned 401 Unauthorized) |
| **ATTACK-02** | Cross-Site Request Forgery (CSRF) | Attempted mutating POST requests without valid CSRF header. | **PASS** (Rejected with 403 / CSRF mismatch) |
| **ATTACK-03** | Tenant IDOR / Cross-Project Access | User in Project A probed 6 resources belonging to Project B. | **PASS** (6 probes returned 404 Not Found, preventing cross-tenant leakage) |
| **ATTACK-04** | API Key Scoping | Attempted privileged operations using read-only API key. | **PASS** (Rejected with 403 Forbidden) |
| **ATTACK-05** | Path Traversal / Sandboxing | Attempted `../` path escapes during file and sandbox tool execution. | **PASS** (Contained strictly within `./data/sandbox`) |
| **ATTACK-06** | Upload Validation & MIME Verification | Uploaded executable masquerading as document. | **PASS** (Validation rejected invalid payload) |
| **ATTACK-07** | Malformed Input & Fuzzing | Submitted oversized payloads, SQL injection tokens, and invalid JSON. | **PASS** (Zod request validation rejected payloads before handler execution) |
| **ATTACK-08** | Chat Parameter Overrides | Attempted client-side override of server-enforced temperature and system prompt. | **PASS** (Server sanitized overrides) |
| **ATTACK-09** | User & Resource Enumeration | Probed authentication endpoints with timing and message variations. | **PASS** (Uniform responses returned, preventing account enumeration) |
| **ATTACK-10** | Security Response Headers | Checked headers on HTTP responses. | **PASS** (`Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` present) |
| **ATTACK-11** | RAG Adversarial Injection | Ingested documents containing closing delimiter overrides and fake system directives. | **PASS** (Sanitized delimiters, stripped tool directives, output grounding refused malicious commands) |

---

## 3. Core Acceptance Checks

Executed via `node scripts/accept-local.mjs`:
- **15/15 Checks PASSED**: Auth, permissions, session management, chat, streaming token spread (1999ms measured), multi-turn history, query cancellation, persistent memory facts, RAG document ingestion, RAG grounded answer, RAG prompt injection refusal, RAG citations, usage limits and spend tracking, tenant isolation, and rate limiting.

---

## 4. Reliability & Concurrency Hardening

- **Serialized Backend Application Fixtures (`fileParallelism: false`):** Resolved concurrent PGlite database startup locks on Windows. All 46 backend test files and 281 tests in `@ai-platform/api` now pass with 100% determinism.
- **Model Router Circuit Breaker & Fallbacks:** Bounded retry budgets with exponential backoff and jitter prevent cascading model failures. Streamed responses never fall back mid-generation.
- **Boot Matrix Verification:** `bash scripts/verify-boot.sh` confirms that production mode refuses mock providers and halts if process sandbox isolation is enabled without explicit acknowledgment.

---

## 5. Residual Risks & Security Recommendations

1. **Malware Scanner Inactive:** ClamAV is not installed locally (`CLAMD_HOST` unset). File uploads are accepted unscanned in development. In production, configure ClamAV daemon and set `UPLOAD_SCAN_REQUIRED=true`.
2. **Container Isolation in Production:** Process sandbox mode is permitted only in development. For production deployments, ensure Docker daemon is active and `SANDBOX_RUNTIME=docker`.
3. **Prompt Injection Inherent Nature:** While lexical sanitization and output grounding pass all test cases, external LLMs retain inherent non-deterministic risks against novel adversarial attacks.
