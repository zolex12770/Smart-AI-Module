# NirnayAI / Smart AI Module — Master Requirements Inventory & Sequential Milestone Plan

**Author:** Antigravity Autonomous Systems Engineering Team  
**Date:** November 7, 2026  
**Repository:** `zolex12770/Smart-AI-Module`  
**Branch:** `antigravity/universal-agent`  
**Base Commit:** `a7a76b31eff9377eac3afad9903c21c2034d6ecf`  
**Status:** IN PROGRESS (Autonomous Execution Loop)

---

## 1. Master Requirements Inventory (REQ-0001 to REQ-0160)

| Requirement ID | Module | Exact Description | Priority | Source Ref | Technical Dependencies | Current State | Assigned Milestone |
| :--- | :--- | :--- | :---: | :--- | :--- | :---: | :---: |
| **REQ-0001** | SYS | Unified product branding to NirnayAI across layout & nav | P1 | SYS-001 | Frontend layout, chrome | REAL_USER_VALIDATED | MILESTONE-01 |
| **REQ-0002** | SYS | Monorepo package boundary & dependency integrity | P0 | SYS-002 | `check-boundary.mjs` | STRUCTURALLY_VALIDATED | MILESTONE-01 |
| **REQ-0003** | SYS | Fastify 5 backend HTTP service boot & health endpoint | P0 | SYS-003, FR-060 | `@fastify/core` | REAL_USER_VALIDATED | MILESTONE-01 |
| **REQ-0004** | SYS | Next.js 14 presentation web application boot on :3000 | P0 | SYS-004 | Next.js, Turbopack | REAL_USER_VALIDATED | MILESTONE-01 |
| **REQ-0005** | SYS | CORS multi-origin handler for localhost, 127.0.0.1 | P0 | SYS-005 | `@fastify/cors` | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0006** | SYS | Secure session cookie management (`SameSite=Lax`) | P0 | SYS-006 | `@fastify/cookie` | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0007** | SYS | Double-submit cryptographic CSRF token validation | P0 | SYS-007 | `auth.ts` CSRF plug | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0008** | SYS | Multi-tenant project workspace scoping & isolation | P0 | SYS-008 | `requireProject` | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0009** | SYS | Embedded air-gapped relational database cluster | P0 | SYS-009 | PGlite / SQLite | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0010** | SYS | Schema migration engine with automated DDL rollouts | P0 | SYS-010 | Drizzle ORM | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0011** | SYS | Background asynchronous job queue system | P1 | SYS-011, FR-050 | `pg-boss` worker | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0012** | SYS | Dead-letter queue (DLQ) for poisoned & failed tasks | P1 | SYS-012 | `pg-boss` DLQ | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0013** | SYS | Process termination PID lock recovery & safe shutdown | P0 | SYS-013 | Process hooks | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0014** | SYS | Centralized structured Pino logging format | P2 | SYS-014 | `pino` logger | STRUCTURALLY_VALIDATED | MILESTONE-01 |
| **REQ-0015** | SYS | Sensitive secret log redaction (passwords, tokens) | P0 | SYS-015, NFR-001 | Redaction filter | SEMANTICALLY_VALIDATED | MILESTONE-01 |
| **REQ-0016** | MOD | Local OpenAI-compatible server on 127.0.0.1:11434 | P0 | MOD-001, FR-002 | `local-model-server` | REAL_USER_VALIDATED | MILESTONE-02 |
| **REQ-0017** | MOD | Anti-mock enforcement (`ALLOW_MOCK_PROVIDERS=false`) | P0 | MOD-002 | Config guard | REAL_USER_VALIDATED | MILESTONE-02 |
| **REQ-0018** | MOD | Real-time SSE token streaming to clients | P0 | MOD-003, FR-001 | SSE stream handler | REAL_USER_VALIDATED | MILESTONE-02 |
| **REQ-0019** | MOD | Model catalog discovery (`GET /api/v1/models`) | P1 | MOD-004 | Models router | REAL_USER_VALIDATED | MILESTONE-02 |
| **REQ-0020** | MOD | UI Model State Badges (Active, Offline, Fallback) | P1 | MOD-005 | `ChatView.tsx` | REAL_USER_VALIDATED | MILESTONE-02 |
| **REQ-0021** | MOD | Honest error alert banner when inference offline | P0 | MOD-006 | Network monitor | SEMANTICALLY_VALIDATED | MILESTONE-02 |
| **REQ-0022** | MOD | Context window cap enforcement (8k tokens limit) | P1 | MOD-007 | Tokenizer cap | SEMANTICALLY_VALIDATED | MILESTONE-02 |
| **REQ-0023** | MOD | Multi-tier model routing tree (fast vs complex) | P1 | MOD-008 | Provider router | STRUCTURALLY_VALIDATED | MILESTONE-02 |
| **REQ-0024** | MOD | Cold-start warmup probe on boot | P1 | MOD-009 | Startup hook | SEMANTICALLY_VALIDATED | MILESTONE-02 |
| **REQ-0025** | MOD | Provider timeout guard with AbortController | P0 | MOD-010 | HTTP client hook | SEMANTICALLY_VALIDATED | MILESTONE-02 |
| **REQ-0026** | MOD | Native Ollama API emulation (`GET /api/tags`) | P2 | MOD-011 | Emulation route | SEMANTICALLY_VALIDATED | MILESTONE-02 |
| **REQ-0027** | MOD | Model process health telemetry & crash watchdog | P1 | MOD-012 | Health monitor | SEMANTICALLY_VALIDATED | MILESTONE-02 |
| **REQ-0028** | MOD | Hardware RAM ceiling safeguard (max 2 concurrent) | P0 | MOD-013 | Concurrency limit | STRUCTURALLY_VALIDATED | MILESTONE-02 |
| **REQ-0029** | MOD | ChatML template compliance (System/User/Assistant) | P1 | MOD-014 | Formatter parser | SEMANTICALLY_VALIDATED | MILESTONE-02 |
| **REQ-0030** | MOD | Heavyweight 70B model deferral on low RAM host | P0 | MOD-015 | Hardware policy | BLOCKED (Hardware) | MILESTONE-02 |
| **REQ-0031** | CHT | Greeting & persona interaction without canned echo | P1 | CHT-001 | System prompt | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0032** | CHT | Factual world knowledge queries (e.g. Narendra Modi) | P1 | CHT-002 | Inference model | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0033** | CHT | Multilingual technical generation in fluent Hindi | P1 | CHT-003 | Inference model | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0034** | CHT | Multi-model comparative analysis & structured output | P1 | CHT-004 | Inference model | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0035** | CHT | Multi-turn conversational context retention | P0 | CHT-005, FR-003 | Chat repository | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0036** | CHT | Browser chat submission via form & interactive UI | P0 | CHT-006 | `ChatView.tsx` | REAL_USER_VALIDATED | MILESTONE-03 |
| **REQ-0037** | CHT | In-flight generation cancellation (`AbortController`) | P1 | CHT-007, FR-006 | SSE abort hook | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0038** | CHT | Markdown rendering with code blocks & syntax style | P1 | CHT-008 | React Markdown | REAL_USER_VALIDATED | MILESTONE-03 |
| **REQ-0039** | CHT | Empty prompt validation preventing whitespace sends | P2 | CHT-009 | Form validator | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0040** | CHT | Quota tracking & token usage recording in DB | P1 | CHT-010, FR-061 | Usage service | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0041** | CHT | Conversation list retrieval & sidebar management | P1 | CHT-011 | History drawer | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0042** | CHT | Chat session deletion (`DELETE /api/v1/conversations/:id`) | P2 | CHT-012 | Chat router | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0043** | CHT | Auto-scroll on token stream with user override | P2 | CHT-013 | DOM scroll hook | REAL_USER_VALIDATED | MILESTONE-03 |
| **REQ-0044** | CHT | Copy message action & notification | P3 | CHT-014 | Clipboard API | STRUCTURALLY_VALIDATED | MILESTONE-03 |
| **REQ-0045** | CHT | Rate-limiting on chat submission endpoint | P0 | CHT-015 | `@fastify/rate-limit` | SEMANTICALLY_VALIDATED | MILESTONE-03 |
| **REQ-0046** | MEM | Automatic fact extraction from conversation dialog | P1 | MEM-001 | Memory engine | SEMANTICALLY_VALIDATED | MILESTONE-04 |
| **REQ-0047** | MEM | Persistent long-term memory storage in `memory_entries` | P0 | MEM-002 | SQL repository | SEMANTICALLY_VALIDATED | MILESTONE-04 |
| **REQ-0048** | MEM | User-visible memory review table at `/memory` | P1 | MEM-003, FR-032 | Next.js `/memory` | REAL_USER_VALIDATED | MILESTONE-04 |
| **REQ-0049** | MEM | User memory deletion (`DELETE /api/v1/memory/:id`) | P0 | MEM-004, FR-032 | Memory router | SEMANTICALLY_VALIDATED | MILESTONE-04 |
| **REQ-0050** | MEM | Project-scoped memory isolation preventing leak | P1 | MEM-005 | Tenancy check | SEMANTICALLY_VALIDATED | MILESTONE-04 |
| **REQ-0051** | MEM | Document chunking pipeline (500 tokens with overlap) | P1 | MEM-006 | Chunking module | SEMANTICALLY_VALIDATED | MILESTONE-04 |
| **REQ-0052** | MEM | Local vector cosine similarity using pgvector | P1 | MEM-007 | `pgvector` store | SEMANTICALLY_VALIDATED | MILESTONE-04 |
| **REQ-0053** | MEM | RAG retrieval timeout deadline preventing hanging | P1 | MEM-008 | Timeout wrapper | SEMANTICALLY_VALIDATED | MILESTONE-04 |
| **REQ-0054** | MEM | Knowledge question answering grounded in uploaded files | P1 | MEM-009, FR-031 | `/ask` interface | SEMANTICALLY_VALIDATED | MILESTONE-04 |
| **REQ-0055** | MEM | Source citation references `[1]` in generated answers | P1 | MEM-010 | Citation parser | SEMANTICALLY_VALIDATED | MILESTONE-04 |
| **REQ-0056** | MEM | Truthful rejection of ungrounded questions without hallucination | P0 | MEM-011 | RAG validator | REAL_USER_VALIDATED | MILESTONE-04 |
| **REQ-0057** | MEM | Memory JSON export format compliance | P3 | MEM-012 | Export endpoint | STRUCTURALLY_VALIDATED | MILESTONE-04 |
| **REQ-0058** | COD | Scoped workspace sandbox jail preventing host escape | P0 | COD-001, FR-010 | `sandbox.ts` | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0059** | COD | Directory tree recursive exploration (`agent.list_files`) | P1 | COD-002 | Filesystem tool | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0060** | COD | Symbol & keyword search with line numbering | P1 | COD-003 | Regex search tool | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0061** | COD | Safe file reading within sandbox root boundaries | P1 | COD-004 | File reader tool | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0062** | COD | Unified diff generation (`--- a/ +++ b/`) | P1 | COD-005, FR-011 | Diff library | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0063** | COD | Scoped file modification (`code.replace_text`) | P1 | COD-006 | Patch engine | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0064** | COD | Automated test execution with stdout/stderr capture | P0 | COD-007, FR-012 | Subprocess runner | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0065** | COD | Diagnostic defect detection from test runner output | P0 | COD-008 | Planner agent | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0066** | COD | Autonomous test-driven repair loop until PASS | P0 | COD-009 | Coding loop | REAL_USER_VALIDATED | MILESTONE-05 |
| **REQ-0067** | COD | Snapshot rollback guard on edit failure | P0 | COD-010 | Git/snapshot store| SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0068** | COD | Command allowlist blocking `rm -rf`, curl to external | P0 | COD-011, FR-014 | Security sandbox | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0069** | COD | Consequential action human approval gate | P0 | COD-012, FR-007 | Agent approval queue| SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0070** | COD | Coding workspace UI at `/coding` with fixture seeding | P2 | COD-013, FR-013 | Next.js `/coding` | REAL_USER_VALIDATED | MILESTONE-05 |
| **REQ-0071** | COD | Subprocess execution deadline (30s) killing hangs | P1 | COD-014 | Exec timeout | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0072** | COD | Secret credential masking in generated diffs | P0 | COD-015 | Mask filter | SEMANTICALLY_VALIDATED | MILESTONE-05 |
| **REQ-0073** | DOC | PDF creation via ReportLab with header & footer | P1 | DOC-001 | Python `reportlab` | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0074** | DOC | Styled tabular layout in PDF documents | P1 | DOC-002 | `reportlab.platypus`| SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0075** | DOC | PDF text extraction via PyMuPDF (`fitz`) | P1 | DOC-003 | Python `pymupdf` | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0076** | DOC | PDF metadata extraction (page count, title, author) | P2 | DOC-004 | `pymupdf` metadata | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0077** | DOC | DOCX document creation via `python-docx` | P1 | DOC-005 | `python-docx` | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0078** | DOC | DOCX text and table parsing | P1 | DOC-006 | `python-docx` reader| SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0079** | DOC | XLSX spreadsheet creation via `openpyxl` | P1 | DOC-007 | `openpyxl` | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0080** | DOC | XLSX formula evaluation and typed cell parsing | P1 | DOC-008 | `openpyxl` reader | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0081** | DOC | Fast CSV streaming & tabular parsing | P1 | DOC-009 | CSV module | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0082** | DOC | Document asset persistence in `data/assets` | P1 | DOC-010 | Asset repository | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0083** | DOC | Corrupt document validation error handling | P1 | DOC-011, NFR-002 | Schema validator | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0084** | DOC | File reopening integrity validation | P0 | DOC-012 | File verification | SEMANTICALLY_VALIDATED | MILESTONE-06 |
| **REQ-0085** | VIS | Image dimensions & RGB channel validation | P1 | VIS-001 | Python `Pillow` | REAL_USER_VALIDATED | MILESTONE-07 |
| **REQ-0086** | VIS | Color mode & format extraction (PNG/JPEG/RGBA) | P2 | VIS-002 | `Pillow` inspector | SEMANTICALLY_VALIDATED | MILESTONE-07 |
| **REQ-0087** | VIS | Brightness and contrast histogram calculation | P2 | VIS-003 | OpenCV grayscale | SEMANTICALLY_VALIDATED | MILESTONE-07 |
| **REQ-0088** | VIS | Laplacian sharpness & blur score evaluation | P1 | VIS-004 | OpenCV Laplacian | REAL_USER_VALIDATED | MILESTONE-07 |
| **REQ-0089** | VIS | Canny structural edge detection | P1 | VIS-005 | OpenCV Canny | SEMANTICALLY_VALIDATED | MILESTONE-07 |
| **REQ-0090** | VIS | Contour bounding box card detection | P1 | VIS-006 | OpenCV contours | REAL_USER_VALIDATED | MILESTONE-07 |
| **REQ-0091** | VIS | Image upload MIME type restriction (PNG/JPEG only) | P1 | VIS-007 | Upload filter | SEMANTICALLY_VALIDATED | MILESTONE-07 |
| **REQ-0092** | VIS | Local text-to-image provider CPU fallback | P2 | VIS-008, FR-040 | `sdcpp` wrapper | PARTIAL (CPU Slow) | MILESTONE-07 |
| **REQ-0093** | VIS | Image asset streaming route (`GET /api/v1/assets/:id`) | P1 | VIS-009 | Asset controller | SEMANTICALLY_VALIDATED | MILESTONE-07 |
| **REQ-0094** | VIS | Corrupted image byte handling without crash | P1 | VIS-010 | Safe decoder | SEMANTICALLY_VALIDATED | MILESTONE-07 |
| **REQ-0095** | AUD | Windows SAPI offline speech synthesis (TTS) | P0 | AUD-001 | `System.Speech` | REAL_USER_VALIDATED | MILESTONE-08 |
| **REQ-0096** | AUD | PCM 16-bit 22050Hz mono WAV container formatting | P1 | AUD-002 | WAV header writer | SEMANTICALLY_VALIDATED | MILESTONE-08 |
| **REQ-0097** | AUD | Shell-injection-proof TTS base64 argument passing | P0 | AUD-003 | PowerShell runner | SEMANTICALLY_VALIDATED | MILESTONE-08 |
| **REQ-0098** | AUD | Speech duration calculation from PCM frame count | P1 | AUD-004 | Audio math helper | SEMANTICALLY_VALIDATED | MILESTONE-08 |
| **REQ-0099** | AUD | `SPEECH_PROVIDER=sapi` backend configuration | P0 | AUD-005 | Fastify config | REAL_USER_VALIDATED | MILESTONE-08 |
| **REQ-0100** | AUD | Speech generation REST API (`POST /api/v1/audio`) | P1 | AUD-006 | Audio router | REAL_USER_VALIDATED | MILESTONE-08 |
| **REQ-0101** | AUD | Speech character quota guard & spend tracking | P1 | AUD-007, FR-063 | Usage meter | SEMANTICALLY_VALIDATED | MILESTONE-08 |
| **REQ-0102** | AUD | In-browser audio playback with active advancement | P2 | AUD-008 | `<audio controls>` | REAL_USER_VALIDATED | MILESTONE-08 |
| **REQ-0103** | AUD | Audio generation cancellation support | P2 | AUD-009 | Cancel route | SEMANTICALLY_VALIDATED | MILESTONE-08 |
| **REQ-0104** | AUD | Speech-to-text audio transcription (Whisper CPU) | P2 | AUD-010 | Local Whisper | PARTIAL (CPU Slow) | MILESTONE-08 |
| **REQ-0105** | VID | Synthetic test video generation via OpenCV | P2 | VID-001 | OpenCV VideoWriter | SEMANTICALLY_VALIDATED | MILESTONE-09 |
| **REQ-0106** | VID | Video duration, frame count & FPS inspection | P1 | VID-002 | VideoCapture API | SEMANTICALLY_VALIDATED | MILESTONE-09 |
| **REQ-0107** | VID | Periodic keyframe extraction to disk | P1 | VID-003 | Frame extractor | SEMANTICALLY_VALIDATED | MILESTONE-09 |
| **REQ-0108** | VID | Color histogram scene change transition detection | P1 | VID-004 | Histogram diff | SEMANTICALLY_VALIDATED | MILESTONE-09 |
| **REQ-0109** | VID | Timestamp-aware video scene summary route | P1 | VID-005 | `videos/summarize` | REAL_USER_VALIDATED | MILESTONE-09 |
| **REQ-0110** | VID | Video upload route with multipart handling | P1 | VID-006 | Video controller | SEMANTICALLY_VALIDATED | MILESTONE-09 |
| **REQ-0111** | VID | Video scene processing deadline sizing | P1 | VID-007 | Worker deadline | SEMANTICALLY_VALIDATED | MILESTONE-09 |
| **REQ-0112** | VID | FFmpeg availability on system PATH | P0 | VID-008 | `ffmpeg.exe` binary| REAL_USER_VALIDATED | MILESTONE-09 |
| **REQ-0113** | VID | Text-to-Video generation pipeline gating | P2 | VID-009, FR-042 | Video provider | BLOCKED (Hardware) | MILESTONE-09 |
| **REQ-0114** | VID | Corrupt video container rejection | P1 | VID-010 | Container parser | SEMANTICALLY_VALIDATED | MILESTONE-09 |
| **REQ-0115** | BRW | Permitted web page fetching via HTTP client | P1 | BRW-001 | Browser fetcher | SEMANTICALLY_VALIDATED | MILESTONE-10 |
| **REQ-0116** | BRW | Anti-prompt-injection HTML sanitization | P0 | BRW-002, FR-023 | HTML sanitizer | SEMANTICALLY_VALIDATED | MILESTONE-10 |
| **REQ-0117** | BRW | Iframe neutralization for UI redressing defense | P0 | BRW-003 | Iframe stripper | SEMANTICALLY_VALIDATED | MILESTONE-10 |
| **REQ-0118** | BRW | Page title & meta tag extraction | P2 | BRW-004 | Regex meta parser | SEMANTICALLY_VALIDATED | MILESTONE-10 |
| **REQ-0119** | BRW | Hyperlink discovery & URL normalization | P1 | BRW-005 | Link parser | SEMANTICALLY_VALIDATED | MILESTONE-10 |
| **REQ-0120** | BRW | Clean text content normalization for LLM ingestion | P1 | BRW-006 | Text normalizer | SEMANTICALLY_VALIDATED | MILESTONE-10 |
| **REQ-0121** | BRW | Consequential action risk evaluation for web | P0 | BRW-007, FR-022 | Tool policy | SEMANTICALLY_VALIDATED | MILESTONE-10 |
| **REQ-0122** | BRW | Request timeout deadline (15s) for external fetch | P1 | BRW-008 | Timeout controller | SEMANTICALLY_VALIDATED | MILESTONE-10 |
| **REQ-0123** | BRW | NirnayAI User-Agent compliance header | P2 | BRW-009 | Request headers | STRUCTURALLY_VALIDATED | MILESTONE-10 |
| **REQ-0124** | BRW | Source citation assembly with URL references | P1 | BRW-010 | Citation builder | SEMANTICALLY_VALIDATED | MILESTONE-10 |
| **REQ-0125** | SEC | Admin dashboard navigation route at `/admin` | P1 | SEC-001 | Next.js `/admin` | REAL_USER_VALIDATED | MILESTONE-11 |
| **REQ-0126** | SEC | Live system health metrics (`/api/v1/admin/health`) | P1 | SEC-002, FR-062 | Health controller | REAL_USER_VALIDATED | MILESTONE-11 |
| **REQ-0127** | SEC | Granular capability toggles in UI | P0 | SEC-003 | Toggle controller | REAL_USER_VALIDATED | MILESTONE-11 |
| **REQ-0128** | SEC | Role-Based Access Control matrix (Super Admin, User) | P0 | SEC-004 | RBAC policy | REAL_USER_VALIDATED | MILESTONE-11 |
| **REQ-0129** | SEC | Append-only security audit log stream | P0 | SEC-005 | Audit repository | REAL_USER_VALIDATED | MILESTONE-11 |
| **REQ-0130** | SEC | Database backup snapshot trigger | P0 | SEC-006 | Snapshot worker | REAL_USER_VALIDATED | MILESTONE-11 |
| **REQ-0131** | SEC | Password hashing via Argon2id | P0 | SEC-007, FR-060 | `@node-rs/argon2` | SEMANTICALLY_VALIDATED | MILESTONE-11 |
| **REQ-0132** | SEC | Auth endpoint brute-force rate-limiting | P0 | SEC-008 | Rate limiter | SEMANTICALLY_VALIDATED | MILESTONE-11 |
| **REQ-0133** | SEC | Deny-by-default route security on private API | P0 | SEC-009 | Auth plugin hook | SEMANTICALLY_VALIDATED | MILESTONE-11 |
| **REQ-0134** | SEC | Oversized HTTP body rejection (DoS defense) | P0 | SEC-010, NFR-002 | Body parser limit | SEMANTICALLY_VALIDATED | MILESTONE-11 |
| **REQ-0135** | SEC | Request ID correlation tracking across all logs | P1 | SEC-011, NFR-012 | Request context | SEMANTICALLY_VALIDATED | MILESTONE-11 |
| **REQ-0136** | SEC | Project deletion cascade safety | P0 | SEC-012 | Project controller | SEMANTICALLY_VALIDATED | MILESTONE-11 |
| **REQ-0137** | SEC | Account deletion and GDPR data scrubbing | P1 | SEC-013, NFR-008 | User controller | SEMANTICALLY_VALIDATED | MILESTONE-11 |
| **REQ-0138** | SEC | Zero outbound telemetry assurance (Air-gapped) | P0 | SEC-014 | Egress audit | STRUCTURALLY_VALIDATED | MILESTONE-11 |
| **REQ-0139** | SEC | Human approval ticket queue for high-impact actions | P0 | SEC-015, FR-007 | Ticket controller | SEMANTICALLY_VALIDATED | MILESTONE-11 |
| **REQ-0140** | REL | Zero unhandled promise rejections on process level | P0 | REL-001 | Process handlers | SEMANTICALLY_VALIDATED | MILESTONE-12 |
| **REQ-0141** | REL | Master automated E2E acceptance suite across 8 engines| P0 | REL-002 | Master verifier | SEMANTICALLY_VALIDATED | MILESTONE-12 |
| **REQ-0142** | REL | Architectural boundary check suite (7/7 gates) | P0 | REL-003, NFR-011 | `check-boundary.mjs`| STRUCTURALLY_VALIDATED | MILESTONE-12 |
| **REQ-0143** | REL | TypeScript backend compilation (`tsc -b`) | P0 | REL-004 | TypeScript compiler| STRUCTURALLY_VALIDATED | MILESTONE-12 |
| **REQ-0144** | REL | TypeScript frontend compilation (`tsc --noEmit`) | P0 | REL-005 | TypeScript compiler| STRUCTURALLY_VALIDATED | MILESTONE-12 |
| **REQ-0145** | REL | Graceful shutdown handling on SIGTERM / SIGINT | P1 | REL-006 | Shutdown hooks | SEMANTICALLY_VALIDATED | MILESTONE-12 |
| **REQ-0146** | REL | Flaky test timeout insulation on Windows platform | P1 | REL-007 | Test config | STRUCTURALLY_VALIDATED | MILESTONE-12 |
| **REQ-0147** | REL | Storage cleanup policy for orphaned assets | P2 | REL-008 | Orphan cleaner | SEMANTICALLY_VALIDATED | MILESTONE-12 |
| **REQ-0148** | REL | Complete architectural and operator documentation | P2 | REL-009 | Markdown guides | STRUCTURALLY_VALIDATED | MILESTONE-12 |
| **REQ-0149** | REL | Continuous autonomous verification loop execution | P0 | REL-010 | Autonomous loop | REAL_USER_VALIDATED | MILESTONE-12 |

---

## 2. Sequential Milestone Structure (MILESTONE-01 to MILESTONE-12)

Every milestone contains:
1. **Milestone ID & Name**
2. **Objective**
3. **Requirements Covered**
4. **Dependencies**
5. **Exact Implementation & Test Tasks**
6. **Acceptance Criteria**
7. **Verification Evidence & State**

```mermaid
flowchart LR
    M1["M1: Core Platform & Security"] --> M2["M2: Inference & Streaming"]
    M2 --> M3["M3: Conversational Reasoning"]
    M3 --> M4["M4: Memory & Grounded RAG"]
    M4 --> M5["M5: Autonomous Coding Agent"]
    M5 --> M6["M6: Document Intelligence"]
    M6 --> M7["M7: Vision & Image Analysis"]
    M7 --> M8["M8: Audio TTS & Playback"]
    M8 --> M9["M9: Video Slicing & FFmpeg"]
    M9 --> M10["M10: Browser Research Agent"]
    M10 --> M11["M11: Governance, Health & Admin"]
    M11 --> M12["M12: Master Acceptance & Release"]
```

---

### MILESTONE-01: Core Platform Architecture, Identity & Boundary Security
- **Requirements:** `REQ-0001` to `REQ-0015`
- **Objective:** Establish the self-contained NirnayAI application container, database, jobs, and boundary isolation.
- **State:** `IN_PROGRESS`
- **Acceptance Criteria:**
  1. Frontend and backend boot cleanly without cross-boundary violations.
  2. Boundary verification script `scripts/check-boundary.mjs` passes 7/7 checks across all packages.
  3. Session authentication and CSRF double-submit tokens work cleanly on local development origins (`localhost`, `127.0.0.1`).
  4. Backend health check returns HTTP 200 with all database connections active.
- **Unit & Integration Tests:** `npm --prefix backend test`, `node scripts/check-boundary.mjs`.
- **E2E Browser Test:** Navigate to `http://localhost:3000/login` and verify dev-gated sign-in.
- **Gate Decision:** Verify evidence, sign off, and advance to MILESTONE-02.

---

### MILESTONE-02: Local Model Inference, Streaming & Provider Routing
- **Requirements:** `REQ-0016` to `REQ-0030`
- **Objective:** Ensure local inference runtime on `:11434` provides genuine dynamic reasoning, streaming SSE tokens, and honest offline reporting with zero mock strings in production paths.
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. `ALLOW_MOCK_PROVIDERS=false` enforced.
  2. Dynamic token generation via SSE stream without static canned fallbacks.
  3. `GET /api/v1/models` returns registered models with accurate capability descriptors.
  4. Context window cap (8k tokens) enforced.
- **Unit & Integration Tests:** `scripts/local-model-server.mjs` test probes.
- **E2E Browser Test:** Stream chat response in `http://localhost:3000/chat`.

---

### MILESTONE-03: Chat, Conversational Reasoning & Multi-Turn Persistence
- **Requirements:** `REQ-0031` to `REQ-0045`
- **Objective:** Verify genuine conversational reasoning across multiple turns (math calculations, multilingual Hindi generation, context retention across reloads).
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. Turn 1 arithmetic (`2 + 2 = 4`) streams successfully.
  2. Turn 2 Hindi query generates fluent Devanagari explanation of recursion.
  3. Conversation appears in sidebar drawer and persists across browser refreshes.
- **E2E Browser Test:** Playwright multi-turn sequence in `scripts/master-live-browser-verification.mjs`.

---

### MILESTONE-04: Persistent Memory & Grounded Knowledge RAG
- **Requirements:** `REQ-0046` to `REQ-0057`
- **Objective:** Validate fact extraction, persistent storage in `memory_entries`, user deletion, and RAG document grounding with truthful refusal of ungrounded queries.
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. Document uploaded, scanned, and indexed into pgvector storage.
  2. Question on uploaded document returns grounded answer with citation `[1]`.
  3. Ungrounded question (e.g. capital of Australia) returns truthful refusal without hallucination.
  4. Added memory item rendered in table and confirmed deletable via "Forget".
- **Tests & Evidence:** `scripts/evaluate-rag-precision.cjs`, Playwright `/ask` and `/memory` screens.

---

### MILESTONE-05: Autonomous Coding Agent, Sandbox Isolation & Defect Repair
- **Requirements:** `REQ-0058` to `REQ-0072`
- **Objective:** Validate real code analysis, safe file editing, sandboxed test execution, and autonomous repair of defective code.
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. Failing test fixture in `coding-demo/math.js` (`const ANSWER = 41;`) detected.
  2. Coding agent diagnoses defect, plans replacement, executes `code.replace_text` to `42`.
  3. Re-runs `math.test.js`, passes with exit code 0, and updates task state to `COMPLETED`.
  4. File modification physically verified on disk in sandbox directory.
- **Tests & Evidence:** `scripts/verify-coding-agent-real.mjs`, Playwright `/coding` screen.

---

### MILESTONE-06: Document Intelligence Engine — PDF, DOCX, XLSX Creation & Parsing
- **Requirements:** `REQ-0073` to `REQ-0084`
- **Objective:** Validate real generation and parsing of PDFs (ReportLab, PyMuPDF), Word DOCX files (python-docx), and Excel spreadsheets (openpyxl).
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. Valid PDF generated with tables and verified reopened via PyMuPDF.
  2. Valid DOCX generated with headings and verified reopened via python-docx.
  3. Valid XLSX generated with numerical formulas and verified reopened via openpyxl.
- **Tests & Evidence:** `python scripts/verify_document_intelligence.py` or equivalent test runner.

---

### MILESTONE-07: Vision & Visual Inspection Engine — Analysis, Edges & Sharpness
- **Requirements:** `REQ-0085` to `REQ-0094`
- **Objective:** Validate image inspection, RGB color properties, sharpness blur scores, edge detection, and layout contour cards.
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. `POST /api/v1/images/analyze` processes test image and returns dimensions, mean brightness, and Laplacian sharpness.
  2. Contour detection locates layout boxes.
  3. Truthful provider status rendered for unconfigured diffusion models.
- **Tests & Evidence:** Playwright `/images` screen, API response inspection.

---

### MILESTONE-08: Audio & Offline Speech Synthesis (Windows SAPI) & Playback
- **Requirements:** `REQ-0095` to `REQ-0104`
- **Objective:** Validate offline text-to-speech synthesis generating real WAV audio and verify active browser playback.
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. Windows SAPI synthesizes 4+ second 16-bit PCM mono WAV file into `data/assets`.
  2. Audio file inspected for valid RIFF/WAVE headers.
  3. Playwright browser clicks Play on `<audio controls>` and measures `currentTime` advancement.
- **Tests & Evidence:** Playwright `/audio` screen with playback metrics (`currentTime > 0`, `paused: false`).

---

### MILESTONE-09: Video Understanding, Frame Extraction & FFmpeg Integration
- **Requirements:** `REQ-0105` to `REQ-0114`
- **Objective:** Validate video duration inspection, keyframe extraction, scene transition detection, and FFmpeg system availability.
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. FFmpeg 4.2.2 verified executable on system `PATH`.
  2. Video summarization route `POST /api/v1/videos/summarize` returns scene transitions and keyframe counts.
  3. Truthful provider gating rendered for text-to-video generation.
- **Tests & Evidence:** Playwright `/videos` screen, FFmpeg CLI version check.

---

### MILESTONE-10: Browser Research & Web Automation Agent
- **Requirements:** `REQ-0115` to `REQ-0124`
- **Objective:** Validate permitted URL fetching, prompt injection stripping, iframe neutralization, and source citation extraction.
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. Web fetcher extracts clean text from HTML.
  2. Malicious script and iframe tags stripped completely.
  3. Citations mapped to origin URLs.
- **Tests & Evidence:** Browser agent test harness.

---

### MILESTONE-11: System Governance, Admin Health Metrics, Quotas & Audit Stream
- **Requirements:** `REQ-0125` to `REQ-0139`
- **Objective:** Validate Admin dashboard (`/admin`), component health probes (`/api/v1/admin/health`), live stats, RBAC matrix, and append-only audit trail.
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. Admin dashboard renders component runtime cards (database, queue, models, projects).
  2. Granular capability toggles modify agent enablement.
  3. RBAC matrix renders roles and permissions.
  4. Audit log records mutating actions.
- **Tests & Evidence:** Playwright `/admin` screen.

---

### MILESTONE-12: Operational Quality, Boundary Verification & Master System Release
- **Requirements:** `REQ-0140` to `REQ-0149`
- **Objective:** Run complete end-to-end verification across all 12 milestones, ensure zero compiler errors, 7/7 boundary checks, and generate final consolidated report.
- **State:** `NOT_STARTED`
- **Acceptance Criteria:**
  1. Frontend `tsc --noEmit` exits 0.
  2. Backend `npm run build` exits 0.
  3. Boundary verification `scripts/check-boundary.mjs` passes 7/7 checks.
  4. Master live browser verification script executes all 14 stages successfully.
  5. Single consolidated report updated at `NIRNAYAI_AUTONOMOUS_COMPLETION_REPORT.md`.
