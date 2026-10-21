# Host Setup & External Dependencies Guide

This guide documents the optional host dependencies required to upgrade degraded or mocked capabilities into fully offline, native local executions on Windows.

---

## 1. Local Runtime Diagnostics (`npm run doctor`)

Run the automated diagnostic suite at any time to verify what your machine can actually run:
```powershell
npm run doctor
```
Every row is determined by actively executing the underlying binary or probe.

---

## 2. Local Model Provider (Ollama)

By default, without Ollama or cloud API keys, the platform falls back to `@ai-platform/llm-mock` when `ALLOW_MOCK_PROVIDERS=true`.

To enable offline local neural LLM inference:
1. **Install Ollama on Windows:**
   ```powershell
   winget install Ollama.Ollama
   ```
2. **Start the Ollama daemon:**
   ```powershell
   ollama serve
   ```
3. **Pull the recommended chat & embedding models:**
   ```powershell
   ollama pull qwen2.5-coder:7b
   ollama pull nomic-embed-text
   ```
4. **Platform Auto-Detection:**
   The backend automatically probes `http://127.0.0.1:11434` at boot. When running, local LLM inference and semantic embeddings activate automatically without requiring API keys.

---

## 3. Video Transcoding & Audio Muxing (FFmpeg)

Without FFmpeg on `PATH`, the long-form video pipeline completes its script, scene, and asset planning, but reports `renderStatus: skipped_no_ffmpeg` rather than hanging.

To enable full MP4 video encoding and narration muxing:
1. **Install FFmpeg via winget:**
   ```powershell
   winget install Gyan.FFmpeg
   ```
2. **Or configure custom binary path in `.env`:**
   ```env
   FFMPEG_PATH=C:\path\to\ffmpeg\bin\ffmpeg.exe
   ```
3. **Verify:**
   ```powershell
   ffmpeg -version
   ```

---

## 4. Native Windows Speech Synthesis (SAPI / Piper)

When no speech provider is configured, audio endpoints refuse with HTTP 503 and long-form video renders silently.

To enable audio narration on Windows:
1. **Option A: Built-in Windows Speech API (Zero install):**
   In `backend/.env`:
   ```env
   SPEECH_PROVIDER=sapi
   ```
   Uses Windows installed voices (e.g. Microsoft David / Zira) via native SAPI automation.
2. **Option B: Piper Neural Voices (High Quality Offline ONNX):**
   Download the Piper Windows binary and ONNX voice model, then set:
   ```env
   PIPER_PATH=C:\path\to\piper.exe
   PIPER_VOICE=C:\path\to\en_US-lessac-medium.onnx
   ```

---

## 5. Offline Image Generation (Stable Diffusion GGUF)

Without a diffusion model or OpenAI API key, images generate as labeled SVG mock placeholders (`isMock: true`).

To generate real diffusion images locally on CPU/GPU without third-party cloud accounts:
1. Download `sd` binary from `stable-diffusion.cpp` release.
2. Download an SD 1.5 or SDXL GGUF model (e.g. `sd-v1-5-q4_0.gguf`).
3. Set in `backend/.env`:
   ```env
   IMAGE_SD_CLI_PATH=C:\path\to\sd.exe
   IMAGE_SD_MODEL_PATH=C:\path\to\sd-v1-5-q4_0.gguf
   IMAGE_SD_SIZE=512
   IMAGE_SD_STEPS=20
   ```

---

## 6. Document OCR (Scanned Image-Only PDFs)

`@ai-platform/rag` extracts text from searchable PDFs and DOCX files. For scanned image-only PDFs:
1. Install Tesseract OCR:
   ```powershell
   winget install UB-Mannheim.TesseractOCR
   ```
2. Ensure `tesseract` is on system `PATH`.

---

## 7. Cloud Deployment (GCP / Terraform) — `BLOCKED_EXTERNAL`

Terraform configurations in `infrastructure/terraform/` provision Cloud Run, Cloud SQL, and Cloud Storage.
On machines without GCP credentials:
- Status remains `BLOCKED_EXTERNAL`.
- Local verification runs 100% using embedded PGlite PostgreSQL (`./data/pgdata`) and local disk storage (`./data/assets`).
- To authenticate an authorized GCP deployment:
  ```powershell
  gcloud auth application-default login
  gcloud config set project YOUR_GCP_PROJECT_ID
  ```
