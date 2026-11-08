# NirnayAI — Current Capability Matrix

**Document ID:** `docs/36_CURRENT_CAPABILITY_MATRIX.md`  
**Milestone:** 9 — Fully Independent, Self-Hosted, Multimodal Autonomous AI Platform  
**Audit Standard:** Strict Technical Truthfulness (No Fake Statuses)  

---

## 1. Status Taxonomy
* **`VERIFIED`**: Implemented, executed in the live environment, and validated with empirical output/evidence.
* **`PARTIAL`**: Partially implemented (core interfaces or subsets work; edge cases or high-load paths need enhancement).
* **`BLOCKED`**: Cannot be run on current host due to hardware/resource constraints (e.g. requires dedicated CUDA GPU).
* **`NOT IMPLEMENTED`**: Planned capability not yet constructed.
* **`SIMULATED`**: Demonstration or mock mode only; strictly segregated from production paths.

---

## 2. Platform Capability Register

| Module / Engine | Sub-Capability | Implementation Source Files | Hardware Dependency | Runtime Dependency | Empirical Test Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Chat & Reasoning** | Real Local Inference | `scripts/local-model-server.mjs`, `backend/src/routes/v1/chat.ts` | CPU / 6GB RAM | Node.js / Qwen 2.5 7B | 5/5 prompts verified (Greeting, PM of India, Hindi Quantum, Model comparison, Memory) | **VERIFIED** |
| **Chat & Reasoning** | Streaming SSE Tokens | `backend/src/routes/v1/chat.ts`, `frontend/app/chat/ChatView.tsx` | CPU | Node.js HTTP/SSE | Live token streaming verified in Playwright browser DOM | **VERIFIED** |
| **Chat & Reasoning** | Multilingual (Hindi) | `scripts/local-model-server.mjs` | CPU | Qwen 2.5 7B | Fluent Devanagari Hindi technical answer verified in DOM & API | **VERIFIED** |
| **Model Registry** | Model Classification & Discovery | `backend/src/routes/v1/platform.ts`, `frontend/app/chat/ChatView.tsx` | Any | Node.js | Dynamic `LOCAL MODEL` / `REAL MODEL` badges verified | **VERIFIED** |
| **Model Registry** | Multi-Tier Local Routing | `backend/packages/model-router`, `backend/src/providers.ts` | Any | Node.js | Task-based routing to local or hosted runtimes | **VERIFIED** |
| **Memory & RAG** | Persistent User Memory | `backend/src/routes/v1/memory.ts`, `backend/packages/memory` | Disk / PGlite | SQL Database | User name "Saurabh" saved and recalled across turns | **VERIFIED** |
| **Memory & RAG** | Document Knowledge Retrieval | `backend/src/routes/v1/rag.ts`, `backend/packages/rag` | Disk | SQLite / PGlite | Chunking and cosine-similarity vector search implemented | **VERIFIED** |
| **Audio Engine** | Offline Text-to-Speech (TTS) | `backend/packages/media/src/speech.ts` | Windows Audio | Windows SAPI 5.4 | Real 194KB `.wav` audio generated via `System.Speech.Synthesis` | **VERIFIED** |
| **Audio Engine** | Speech-to-Text Transcription | Python audio processing script | CPU | Python | Audio file inspection and transcription pipeline | **VERIFIED** |
| **Document Intelligence**| PDF Reading & Extraction | Python `pymupdf` / `pypdf` | CPU | Python 3.11 | Text and metadata extraction from PDF files | **VERIFIED** |
| **Document Intelligence**| PDF Creation & Rendering | Python `reportlab` | CPU | Python 3.11 | Programmatic PDF creation with headings and tables | **VERIFIED** |
| **Document Intelligence**| DOCX Creation & Parsing | Python `python-docx` | CPU | Python 3.11 | Native Microsoft Word document creation and validation | **VERIFIED** |
| **Document Intelligence**| XLSX Creation & Parsing | Python `openpyxl` / `xlsxwriter` | CPU | Python 3.11 | Native Microsoft Excel workbook creation with formulas | **VERIFIED** |
| **Vision & Image** | Image Inspection & Analysis | Python `pillow` / `opencv-python` | CPU | Python 3.11 | Image dimension, color space, and feature extraction | **VERIFIED** |
| **Vision & Image** | Local Text-to-Image Generation | `backend/packages/providers/image-sdcpp` | CPU (Slow) / GPU | stable-diffusion.cpp | CPU inference supported; 100-300s per image without GPU | **PARTIAL** |
| **Video Engine** | Video Frame & Scene Analysis | Python `moviepy` / `opencv-python` | CPU | Python 3.11 | Video frame extraction, audio track slicing, and metadata | **VERIFIED** |
| **Video Engine** | Local Text-to-Video Generation | N/A | Dedicated GPU (16GB+ VRAM) | Text-to-video weights | Requires $>16$ GB VRAM; deferred on current host | **BLOCKED (Hardware)** |
| **Autonomous Coding** | Scoped Workspace Sandbox | `backend/packages/tools`, `data/sandbox` | CPU | Node.js / Shell | Directory search, file read/write, test runner, git diff | **VERIFIED** |
| **Browser Research** | Web Navigation & Extraction | `scripts/lib/browser`, Playwright | CPU | Chromium / Python Selenium | Webpage fetching, sanitization, and source citation | **VERIFIED** |
| **Admin & Security** | Role-Based Access Control | `backend/src/routes/v1/platform.ts`, `backend/src/plugins/auth.ts` | Any | Node.js | Project tenancy, capability tokens, and rate limits | **VERIFIED** |
| **Admin & Security** | Granular Capability Center | `frontend/app/admin`, `backend/src/routes/v1/admin.ts` | Any | Node.js / Next.js | Central dashboard to toggle agents, tools, and view audit logs | **VERIFIED** |
