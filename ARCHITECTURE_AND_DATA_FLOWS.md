# Architecture and Data Flows: Universal AI Agent Platform

**Document Version:** 1.0.0  
**Scope:** Universal AI Agent & Smart AI Module System Architecture  
**Status:** SEMANTICALLY_VALIDATED & STRUCTURALLY_VALIDATED  

---

## 1. High-Level Architecture Overview

The platform is designed as a multi-tenant, modular, provider-independent autonomous AI orchestration platform.

```mermaid
graph TD
    User["User / Client (Browser / API Client)"]
    
    subgraph Frontend ["Frontend Tier (Next.js 16 - Turbopack)"]
        UI["React SPA & Chat / Agent / Video / Memory Screens"]
        SSEClient["SSE Streaming & Event Subscriber"]
        AuthContext["Auth Context & Session Manager"]
    end
    
    subgraph API ["Backend API Gateway (Fastify 5)"]
        Router["Route Handlers (76 v1 Routes)"]
        AuthGuard["Auth Plugin (Session / Bearer / CSRF)"]
        RateLimiter["Token Bucket Rate Limiter"]
        QuotaEnforcer["Quota Manager & Ledger Guard"]
        AuditLogger["Structured Pino Logger & Trace Spans"]
    end
    
    subgraph CoreServices ["Core Agent & Intelligence Tier"]
        AgentEngine["Agent Engine (Finite State Machine)"]
        Planner["Decomposition Planner"]
        ReasoningLoop["Model-Driven Reasoning Loop"]
        ModelRouter["Model Router (Quality / Cost / Latency / Fallback)"]
        MemoryService["Memory Service (Extraction, Vector Indexing, Injection)"]
        RAGPipeline["RAG Pipeline (Parsers, Chunkers, Grounding Guard)"]
    end
    
    subgraph ExecutionEnclave ["Tool Execution & Sandboxing"]
        ToolRegistry["Tool Registry & Approval Gate"]
        SandboxedFS["Confined File Operations (Lexical & Symlink Contained)"]
        SandboxedCmd["Process Sandbox (Docker / Isolated Path)"]
        WebTool["SSRF-Hardened Web Retrieval"]
        MCPManager["MCP Manager (stdio + HTTP/SSE Transports)"]
    end
    
    subgraph MediaPipeline ["Multimodal Generation Tier"]
        ImageGen["Image Engine (SDXL cpp / OpenAI)"]
        AudioGen["Audio Engine (Piper / SAPI / Cloud)"]
        VideoOrchestrator["Long-Form Video Orchestrator (Timeline & ffmpeg)"]
    end
    
    subgraph Persistence ["Persistence & Workers Tier"]
        DB[(PGlite / PostgreSQL + pgvector)]
        AssetStore["Asset Store (Local Disk / Cloud Storage)"]
        JobQueue["pg-boss Distributed Job Queue & Workers"]
    end

    User --> UI
    UI --> Router
    Router --> AuthGuard --> RateLimiter --> QuotaEnforcer
    QuotaEnforcer --> AgentEngine
    AgentEngine --> Planner --> ReasoningLoop
    ReasoningLoop --> ModelRouter
    ReasoningLoop --> ToolRegistry
    ToolRegistry --> SandboxedFS
    ToolRegistry --> SandboxedCmd
    ToolRegistry --> WebTool
    ToolRegistry --> MCPManager
    AgentEngine --> MemoryService
    AgentEngine --> RAGPipeline
    AgentEngine --> MediaPipeline
    AgentEngine --> JobQueue
    JobQueue --> MediaPipeline
    JobQueue --> DB
    AgentEngine --> DB
    RAGPipeline --> AssetStore
    MediaPipeline --> AssetStore
```

---

## 2. Core Subsystems

### 2.1 Backend API & Authentication Gateway (`backend/`)
- **Framework:** Fastify 5 with strict schema validation (Zod + `@sinclair/typebox`).
- **Authentication Protocols:**
  - `httpOnly`, `SameSite` resolved session cookies.
  - Double-submit CSRF protection for mutating browser requests.
  - Project-scoped Bearer API keys (`pk_...`) for automated pipelines.
  - Mandatory project tenancy: all resource operations are scoped by `project_id` via PostgreSQL predicates.
- **Security Boundaries:**
  - Non-public routes deny by default unless explicitly decorated.
  - API keys are explicitly barred from modifying account-level ownership or session tokens (`ADR-147`).
  - IP resolution strictly honors configured reverse-proxy hops (`TRUST_PROXY_HOPS`).

### 2.2 Autonomous Agent Engine (`backend/packages/agent-core`)
- **State Machine Lifecycle:**
  `REQUEST_RECEIVED` → `UNDERSTANDING` → `PLANNING` → `EXECUTING` → `VERIFYING` → `COMPLETED` / `FAILED` / `PAUSED` / `CANCELLED`.
- **Node-Level Execution & Leases:**
  - Distributed node claiming via database leases (`claimed_until`, `claimed_by`).
  - Automatic stale lease recovery (`takeOverExpiredLeases`).
  - Bounded exponential backoff with jitter and `maxAttempts`.
- **Human-in-the-Loop & Approval Gating:**
  - Tool actions classified into risk tiers (`safe`, `sensitive`, `destructive`).
  - Destructive tools (terminal execution, code patching, project deletion) mandate human confirmation before execution.
  - Transient approval state stored with cryptographic call binding (preventing recycled call-ID spoofing, `ADR-108`).
- **Self-Healing & Grounding Guards:**
  - Independent post-execution verifier checks outputs against ground truth and invariants.
  - Grounding refusals reject model hallucinations before delivering final state to the user.

### 2.3 Provider-Independent Model Router (`backend/packages/model-router`)
- **Provider Abstraction Layer:** Common interface across OpenAI, Anthropic Claude, Google Gemini, and Local Ollama/vLLM.
- **Dynamic Routing Policies:**
  - Quality tier (coding/complex reasoning vs rapid summarization).
  - Provider health, rate limits (HTTP 429 backoff), and automated fallbacks.
  - Pre-flight quota estimation and post-flight actual token/credit ledger tracking.
- **Fail-Safe Operation:** Production rejects mock providers unless explicitly set for synthetic test suites.

### 2.4 Media & Multimodal Pipelines (`backend/packages/media`)
- **Image Generation:** Local diffusers (`stable-diffusion.cpp` GGUF models) or remote DALL-E adapters with resolution and seed reproducibility.
- **Audio Synthesizer:** Piper neural TTS / Windows SAPI with speech rate and voice pitch configuration.
- **Video Production Engine:**
  - Modular script generation with scene decomposition.
  - Per-scene storyboard rendering, narration synthesis, and subtitle timecoding (`WebVTT` / `mov_text`).
  - Audio/video multiplexing, scene transition concatenation, and WebM/MP4 dual-rendition encoding via `ffmpeg`.

### 2.5 Sandboxing & Tool Containment (`backend/packages/tools`)
- **Filesystem Containment:**
  - Path canonicalization resolves symlinks before containment evaluation (`ADR-088`).
  - Relative lexical escapes (`../`) and target symlinks outside project workspace are rejected.
- **Subprocess Isolation:** Commands run inside designated project sandbox directories with CPU/memory ceilings.
- **SSRF Hardening (`web.fetch`):**
  - Rejects private IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.1`, `::1`), link-local/cloud metadata (`169.254.169.254`), and IPv6 mapped ranges.
  - Socket IP address pinning prevents DNS rebinding attacks.

---

## 3. Data Flow Diagrams

### 3.1 Autonomous Agent Task Execution Loop

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Client
    participant API as Fastify API
    participant Engine as Agent Engine
    participant DB as Postgres / PGlite
    participant LLM as Model Router (Gemini / Anthropic / Local)
    participant Tools as Tool Registry & Sandbox
    participant Verifier as Grounding Verifier

    User->>API: POST /api/v1/agent/tasks (goal, options)
    API->>DB: Insert Task (state = REQUEST_RECEIVED)
    API-->>User: 202 Accepted (task_id, stream_url)
    
    API->>Engine: dispatch(task_id)
    Engine->>DB: Transition state -> PLANNING
    Engine->>LLM: Generate plan & tool requirements
    LLM-->>Engine: Structured Plan (subtasks / DAG)
    Engine->>DB: Persist Task Nodes
    
    loop For each task node
        Engine->>DB: Transition node -> EXECUTING (acquire lease)
        Engine->>LLM: Reasoning prompt (transcript + tools)
        LLM-->>Engine: ToolCall (tool, parameters)
        
        alt Tool requires human approval
            Engine->>DB: Transition node -> PAUSED (needs_approval)
            Engine-->>User: SSE event (needs_approval)
            User->>API: POST /api/v1/agent/tasks/:id/approve
            API->>Engine: resumeApproval(node_id)
        end
        
        Engine->>Tools: execute(tool, parameters, projectSandbox)
        Tools-->>Engine: ToolResult (output, error)
        Engine->>DB: Append to Node Transcript & Ledger
    end
    
    Engine->>Verifier: verifyDeliverable(goal, transcripts, files)
    Verifier-->>Engine: Verification Result (Passed / Corrective Hints)
    
    alt Verification Passed
        Engine->>DB: Transition Task -> COMPLETED
    else Needs Correction
        Engine->>LLM: Feedback prompt & self-healing retry
    end
    Engine-->>User: SSE event (task_completed, artifacts)
```

### 3.2 Long-Form Video Assembly Pipeline

```mermaid
sequenceDiagram
    autonumber
    actor User as User
    participant API as Fastify API
    participant Queue as pg-boss Job Queue
    participant Worker as Background Media Worker
    participant LLM as LLM Script Engine
    participant TTS as Speech Engine (Piper / SAPI)
    participant Diffuser as Image/Video Generator
    participant FFmpeg as FFmpeg Processor
    participant Assets as Asset Store

    User->>API: POST /api/v1/videos (topic, target_duration)
    API->>Queue: Enqueue video.render job
    API-->>User: 202 Accepted (job_id, video_id)
    
    Worker->>Queue: Dequeue job
    Worker->>LLM: Generate multi-scene script & narration
    LLM-->>Worker: Script (scenes[], prompt, narration, timing)
    
    par For each scene
        Worker->>Diffuser: Render scene visual (image/clip)
        Diffuser-->>Worker: visual_asset_id
        Worker->>TTS: Synthesize narration audio
        TTS-->>Worker: audio_asset_id + measured duration
    end
    
    Worker->>Worker: Align timeline & generate WebVTT subtitles
    Worker->>FFmpeg: Concatenate scenes, multiplex audio & burn/embed captions
    FFmpeg-->>Worker: Output MP4 (h264/aac) + WebM (vp9/opus)
    Worker->>Assets: Store final renditions & thumbnails
    Worker->>Queue: Complete job (status = COMPLETED)
    User->>API: GET /api/v1/videos/:id (status, stream links)
```
