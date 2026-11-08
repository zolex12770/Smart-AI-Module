# Host Setup and Verification

This file describes the exact external actions needed to move capabilities from internal/contract
validated to live operational evidence. Current host observation: Node 22.14.0, npm 10.9.2, Chrome
available; Ollama, FFmpeg, speech/image/OCR runtimes, Docker, Terraform and cloud credentials absent.

## Baseline

```powershell
npm ci
npm run build
npm run typecheck
npm run lint
npm run doctor
```

Run the commands from the repository root. Never put credentials in tracked files or logs.

## Local model and embeddings

```powershell
winget install Ollama.Ollama
ollama serve
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
npm run doctor
```

For a different OpenAI-compatible runtime set `LLM_BASE_URL`, `LLM_MODEL`, and the corresponding
embedding variables in an ignored `.env`. Verify the model and embedding capabilities separately.

## Media

```powershell
winget install Gyan.FFmpeg
ffmpeg -version
```

Configure `SPEECH_PROVIDER=sapi` on Windows, or set `PIPER_PATH` and `PIPER_VOICE` to real Piper
assets. For real images configure `IMAGE_BASE_URL`/`IMAGE_MODEL`, or provide stable-diffusion.cpp
binary and model paths. A mock SVG/GIF is not production evidence.

## OCR

Searchable PDFs and DOCX are supported without OCR. For scanned PDFs, install a page-rendering
utility and Tesseract, then complete the OCR adapter and verify non-empty extracted text:

```powershell
winget install UB-Mannheim.TesseractOCR
tesseract --version
```

The current code intentionally reports image-only PDFs as unextractable; do not label that path as
OCR-complete until a real scanned fixture passes.

## Upload scanning and isolation

Configure ClamAV/clamd with `CLAMD_HOST` and `CLAMD_PORT` for scanned uploads. Production should use
`UPLOAD_SCAN_REQUIRED=true` when accepting unscanned files is not acceptable. Use Docker sandboxing
(`SANDBOX_RUNTIME=docker`) for production agent command isolation; process mode is a development
fallback.

## Browser and live acceptance

The doctor detects installed Chrome. Start the API and frontend test pair using the repository's
E2E scripts, then run:

```powershell
npm run test:e2e
```

Archive Playwright output, browser console errors and failed network requests. Unit tests with mocked
API calls must be labelled separately from this run.

## Cloud deployment

Install Docker Desktop and Terraform, authenticate an authorized GCP project, review the Terraform
plan, and use a staged deployment with backups and rollback. The Milestone 7 pass performed no cloud
mutation. A local build is not production deployment evidence.
