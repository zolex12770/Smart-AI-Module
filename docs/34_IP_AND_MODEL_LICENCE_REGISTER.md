# NirnayAI — IP & Model Licence Register

**Document ID:** `docs/34_IP_AND_MODEL_LICENCE_REGISTER.md`  
**Milestone:** 9 — Fully Independent, Self-Hosted, Multimodal Autonomous AI Platform  
**Classification:** Legal & Architectural Governance Record  

---

## 1. Intellectual Property Boundaries & Declarations

### 1.1 Original NirnayAI IP Ownership
The NirnayAI platform asserts proprietary/open ownership over its **original software engineering assets**:
* **Application Architecture & Orchestration Engines:** All original Fastify backend services, Next.js presentation code, task classification logic, agent loops, context managers, and tool runners.
* **Original UI/UX Assets:** Proprietary layout, design system, component hierarchy, custom CSS variables, brand identity, and user workflows.
* **Domain Tools & Agent Workflows:** Autonomous coding sandbox protocols, document processing pipelines, audio/vision integrations, and safety policies.
* **Custom Dataset Curations:** Proprietary multi-turn evaluation datasets, domain instruction datasets, and task benchmark suites created specifically for the platform.

### 1.2 Truthful Foundation Model Attribution
> [!IMPORTANT]
> **Strict Legal Honesty:** NirnayAI does **NOT** falsely claim to have trained a proprietary trillion-parameter foundation model from raw pre-training scratch. The platform orchestrates, fine-tunes, quantizes, and hosts proven open-weight foundation models (e.g. Qwen 2.5, Llama 3) under their respective licenses. Training a custom foundation model from scratch remains a distinct long-term research program requiring massive compute clusters.

---

## 2. Model Weights & Runtimes Licence Register

| Model / Runtime Component | Model Family & Version | Author / Creator | Licence Type | Commercial Use Permitted? | Attribution & Usage Terms |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Qwen 2.5 7B Instruct** | Qwen 2.5 (Alibaba Cloud) | Alibaba Cloud | **Apache 2.0** / Qianwen License | **Yes** (Free commercial use $<100$M MAU) | Retain copyright notice; Apache 2.0 terms apply to model weights. |
| **Qwen 2.5 3B / 1.5B** | Qwen 2.5 (Alibaba Cloud) | Alibaba Cloud | **Apache 2.0** | **Yes** | Fully open permissive commercial license. |
| **Llama 3.2 (1B, 3B)** | Llama 3.2 (Meta AI) | Meta Platforms, Inc. | **Llama 3.2 Community License** | **Yes** (Up to 700M monthly active users) | Must include "Built with Llama"; compliant with Meta acceptable use policy. |
| **Whisper (Tiny, Base, Small)** | OpenAI Whisper | OpenAI | **MIT License** | **Yes** | Fully permissive open source speech recognition weights. |
| **Windows SAPI 5.4** | System.Speech.Synthesis | Microsoft Corporation | **Microsoft Windows EULA / .NET SDK** | **Yes** (On licensed Windows hosts) | Built into Windows OS; no separate license or subscription fee. |
| **Piper Neural TTS** | Piper TTS | Michael Hansen (rhasspy) | **MIT / GPLv3** | **Yes** (Voice-dependent) | Fast, local neural text-to-speech for cross-platform deployments. |
| **Stable Diffusion 1.5** | Latent Diffusion | Stability AI / Runway | **CreativeML OpenRAIL-M** | **Yes** (With behavioral restrictions) | Prohibits harmful/illegal generation; requires attribution. |

---

## 3. Third-Party Software Dependencies & Libraries

All production runtime libraries used within NirnayAI are governed by verified permissive open-source licenses:

| Software Package | Ecosystem | Primary Purpose | Licence | Compliance Obligations |
| :--- | :--- | :--- | :--- | :--- |
| **Node.js** | Runtime | JavaScript backend engine | MIT | Standard notice |
| **Fastify** | Node.js | Low-overhead HTTP/SSE gateway | MIT | Standard notice |
| **Next.js** | Node.js / React | Full-stack UI presentation framework | MIT | Standard notice |
| **PGlite** | Node.js / WASM | Embedded Postgres/SQLite SQL database | PostgreSQL / MIT | Standard notice |
| **Playwright** | Node.js | Headless browser automation engine | Apache 2.0 | Standard notice |
| **Python** | Runtime | Scripting & document intelligence | PSF | Standard notice |
| **PyMuPDF / pypdf** | Python | High-performance PDF extraction | AGPL / BSD | Used via separate process CLI/script |
| **ReportLab** | Python | PDF document generation engine | BSD | Permissive commercial use |
| **python-docx** | Python | Microsoft Word document creation & parsing | MIT | Permissive commercial use |
| **openpyxl** | Python | Excel spreadsheet generation & parsing | MIT | Permissive commercial use |
| **Pillow (PIL)** | Python | Image processing and manipulation | HPND (MIT-like) | Permissive commercial use |
| **OpenCV (opencv-python)** | Python | Computer vision, OCR preprocessing | Apache 2.0 | Standard notice |
| **MoviePy / imageio** | Python | Video frame extraction and audio track slicing | MIT | Permissive commercial use |

---

## 4. Fine-Tuning Dataset Provenance & Data Rights

When creating fine-tuning corpora or domain adaptations for NirnayAI:
1. **Source Tracking:** Every instruction dataset must record its origin (synthetic self-instruct, verified public domain code, authorized enterprise documents, or user feedback).
2. **No Scraping of Restricted Content:** Data subjected to restrictive non-commercial terms or protected by copyright paywalls is excluded from training pipelines.
3. **Artifact Retention:** Training configs, git commit IDs of data generation scripts, and loss curves must be preserved alongside model checkpoints in `weights/provenance/`.
