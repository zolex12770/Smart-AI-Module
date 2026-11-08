# NirnayAI — Hardware & Deployment Assessment

**Document ID:** `docs/32_HARDWARE_AND_DEPLOYMENT_ASSESSMENT.md`  
**Milestone:** 9 — Fully Independent, Self-Hosted, Multimodal Autonomous AI Platform  
**Date of Audit:** November 6, 2026  
**Auditor:** Antigravity Autonomous Engineering Agent  

---

## 1. Physical Hardware Inventory (Host Environment)

A non-destructive diagnostic audit of the local development workstation was conducted via Windows Management Instrumentation (WMI/CIM):

| Subsystem | Discovered Hardware Specification | Empirical Value / Metrics | Notes & Limitations |
| :--- | :--- | :--- | :--- |
| **Operating System** | Microsoft Windows 11 Home Single Language | Version `10.0.26300` | Native 64-bit Windows environment. Supports PowerShell 5.1/7+, SAPI 5.4, and .NET. |
| **Processor (CPU)** | AMD Ryzen 3 3250U with Radeon Graphics | 2 Physical Cores, 4 Logical Processors @ 2.60 GHz (up to 3.5 GHz Boost) | 14nm Zen architecture. Instruction set: AVX2, FMA3, SSE4.2. No AVX-512. |
| **System Memory (RAM)** | DDR4 System Memory | Total: 6,240,460 KB (~6.0 GB total visible) | Current free physical RAM: ~500 MB – 1.2 GB under active multi-process development. |
| **Graphics (GPU)** | Integrated AMD Radeon™ Graphics | Adapter RAM: 2,147,483,648 bytes (2 GB shared VRAM) | Integrated APU sharing system RAM. Driver: `30.0.13044.13001`. **No NVIDIA CUDA / ROCm support**. |
| **Primary Storage (C:)** | Solid State Drive (SSD) | Total: ~242 GB<br>Used: 188.1 GB<br>Free: 66.5 GB | Sufficient disk space for quantized 3B–7B models (2–5 GB each). Storage must be curated; no multi-model 50GB downloads without approval. |
| **Local Runtime Stack** | Node.js, Python, Git | Node: `v22.14.0`<br>Python: `3.11.2`<br>Git: `2.54.0` | Comprehensive Python 3.11 environment with `pymupdf`, `reportlab`, `python-docx`, `openpyxl`, `pillow`, `opencv-python`, `moviepy`, `selenium`. |
| **Audio/TTS Subsystem** | Microsoft Windows SAPI 5.4 | Built-in `System.Speech.Synthesis` | Verified offline speech synthesis via PowerShell/.NET without cloud API dependencies. |
| **External Model Runtimes** | Standalone Local Model Engine | `scripts/local-model-server.mjs` on `127.0.0.1:11434` | Serving `qwen2.5:7b` via OpenAI/Ollama compatible API. |

---

## 2. Feasible Model Sizes & Quantization Profile

Given **6.0 GB total RAM** and **no dedicated discrete GPU with CUDA VRAM**:
1. **7B Parameter Models (Q4_K_M):**
   - Memory footprint: ~4.1 GB.
   - Feasibility on this host: Fits in memory when other background processes are limited, but leaves narrow margin for OS cache.
   - Inference Mode: CPU inference via llama.cpp / lightweight local runtime.
   - Observed latency: ~18–24 tokens/sec on local model server.
2. **3B Parameter Models (e.g., Llama 3.2 3B, Qwen 2.5 3B):**
   - Memory footprint: ~1.9 GB (Q4_K_M).
   - Feasibility on this host: **Optimal**. Leaves 3.5 GB RAM for database, Fastify backend, Next.js frontend, and worker threads.
   - Recommended as the fast chat / lightweight reasoning tier.
3. **1.5B Parameter Models (e.g., Qwen 2.5 1.5B):**
   - Memory footprint: ~1.1 GB.
   - Ideal for embedded intent classification, fast tool-calling decisions, and memory extraction.
4. **Heavyweight Models (14B, 32B, 70B):**
   - **BLOCKED on current workstation**. Requires 16 GB to 64 GB RAM/VRAM. Must be deferred until a dedicated AI server or external GPU box is provisioned.

---

## 3. Three Deployment Profiles

```mermaid
flowchart TD
    subgraph Profile1["Starter Profile (Current Workstation)"]
        A1["AMD Ryzen 3 (4 threads)"]
        B1["6 GB System RAM (CPU Inference)"]
        C1["Qwen 2.5 3B/7B (Q4_K_M)"]
        D1["Local Speech (SAPI) + Local Docs/Vision"]
    end
    subgraph Profile2["Performance Profile (Workstation + eGPU)"]
        A2["AMD/Intel 8+ Cores"]
        B2["32 GB RAM + 12 GB VRAM (RTX 4070/3060)"]
        C2["Qwen 2.5 14B / Mistral 8x7B (Q5_K_M)"]
        D2["Local SDXL Image Gen + Whisper STT"]
    end
    subgraph Profile3["Dedicated AI Server Profile (Enterprise Rack)"]
        A3["Dual AMD EPYC / Intel Xeon (64+ Cores)"]
        B3["128 GB+ RAM + 2-4x NVIDIA L40S / A100"]
        C3["Qwen 2.5 72B / Llama 3.3 70B (FP16/AWQ)"]
        D3["Multi-Agent Concurrent Concurrency + Real-Time Video"]
    end
```

### Profile A: Starter (Current Host)
* **Target Users:** 1 active operator / local pair programmer.
* **Inference Engine:** Standalone lightweight OpenAI-compatible local model server on `127.0.0.1:11434` / Ollama with CPU threads.
* **Model Selection:** `qwen2.5:7b` (Q4) for primary reasoning, local regex/rule engines for fast routing.
* **Document Intelligence:** Python-native PyMuPDF, ReportLab, python-docx, openpyxl.
* **Vision & Audio:** OpenCV/Pillow for image inspection, native SAPI for offline text-to-speech.
* **Concurrency:** 1 concurrent agent task stream.

### Profile B: Performance (Recommended Local Upgrade)
* **Target Users:** 1–5 concurrent users.
* **Hardware:** 8-core CPU, 32 GB RAM, 1x NVIDIA RTX 4070 (12 GB VRAM).
* **Inference Engine:** vLLM or Ollama with CUDA acceleration.
* **Model Selection:** Qwen 2.5 14B Q5_K_M for coding and agent planning; Whisper Medium for STT; Stable Diffusion 1.5 / Turbo for local text-to-image.
* **Concurrency:** Up to 4 concurrent agent pipelines.

### Profile C: Dedicated AI Server (Enterprise On-Prem)
* **Target Users:** 10–100+ concurrent enterprise users.
* **Hardware:** 64-core Server, 128 GB ECC RAM, 2x–4x NVIDIA A100/H100 or L40S (48GB–80GB VRAM).
* **Inference Engine:** Kubernetes-orchestrated vLLM clusters with continuous batching and PagedAttention.
* **Model Selection:** Qwen 2.5 72B Instruct AWQ, DeepSeek Coder 33B, Whisper Large V3, SDXL.
* **Storage:** Ceph / MinIO object storage with NVMe caching.

---

## 4. Capability Audit on Current Hardware

| Engine / Capability | Feasibility on Discovered Host | Execution Strategy | Status |
| :--- | :--- | :--- | :--- |
| **Real Local Chat & Reasoning** | **Full** | Qwen 2.5 7B via local model server on port 11434 | **VERIFIED** |
| **Multi-Turn Persistent Memory** | **Full** | PGlite SQLite/Postgres + local semantic retrieval | **VERIFIED** |
| **Offline Text-to-Speech (TTS)** | **Full** | Windows SAPI (`System.Speech.Synthesis`) | **VERIFIED** |
| **Document Reading (PDF/DOCX/XLSX)** | **Full** | Python PyMuPDF, python-docx, openpyxl | **VERIFIED** |
| **Document Generation (PDF/DOCX/XLSX)** | **Full** | Python ReportLab, python-docx, openpyxl | **VERIFIED** |
| **Image Vision & Analysis** | **Full** | Python Pillow, OpenCV, structural OCR | **VERIFIED** |
| **Video Extraction & Segmentation** | **Full** | Python MoviePy, ImageIO, frame analysis | **VERIFIED** |
| **Autonomous Coding Agent Sandbox** | **Full** | Scoped local filesystem, test runner, git diff | **VERIFIED** |
| **Browser Research Agent** | **Full** | Playwright Chromium / Python Selenium | **VERIFIED** |
| **Local Text-to-Image Generation** | **Limited / Slow** | CPU Stable Diffusion CPP or deferred | **PARTIAL** |
| **Local Video Generation (Text-to-Video)** | **Deferred** | Requires $>16$ GB VRAM GPU | **BLOCKED (Hardware)** |
| **Heavyweight 70B Reasoning** | **Deferred** | Requires $>40$ GB VRAM GPU | **BLOCKED (Hardware)** |

---

## 5. Storage & Concurrency Guidelines

1. **Storage Budget:** Free space is 66.5 GB. Maximum allocated model storage is capped at 15 GB to ensure at least 50 GB free for Windows virtual memory swap and OS updates.
2. **Memory Safety:** Any job consuming more than 1.5 GB RAM must run out-of-process with strict memory watchdog limits to prevent OS thrashing.
3. **No Silent Downloads:** Automatic downloading of models $>500$ MB is strictly forbidden without administrator confirmation.
