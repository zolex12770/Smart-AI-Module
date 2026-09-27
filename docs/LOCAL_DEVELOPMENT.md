# Local development

Two ways to run the platform on one machine: **two terminals** (fastest to iterate on), or
**Docker Compose** (the production images, with Postgres). Both use models that run on your
machine; no hosted AI account is needed.

## Prerequisites

- Node.js 22 or newer (CI uses 22; the images use 24)
- A local model runtime for chat, RAG answers, memory and the agent — [Ollama](https://ollama.com):
  ```bash
  OLLAMA_CONTEXT_LENGTH=16384 ollama serve          # 16K context: see docs/PROVIDERS.md
  ollama pull qwen2.5:7b && ollama pull nomic-embed-text
  ```
  Without one, the platform still starts; chat and the agent report that no model is configured.
- Optional, for media: `ffmpeg` (video), [Piper](https://github.com/rhasspy/piper) and a voice
  (speech), a stable-diffusion.cpp binary and model (images) — see [MEDIA.md](MEDIA.md).

## Two terminals

The repository is an npm-workspaces monorepo, so `npm install` in either directory installs the
whole workspace once.

```bash
# Terminal 1 — the API on http://localhost:8787
cd backend
npm install
npm run dev
```

```bash
# Terminal 2 — the web app on http://localhost:3000
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 and sign up. The first account is an ordinary user; set
`BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` before the first boot to create a system
administrator (metrics, tool enablement).

What the backend does on its own:

- **Database**: an embedded PostgreSQL (PGlite, with pgvector) under `backend/data/pgdata`,
  created and migrated on boot. Set `DATABASE_URL` to use a standalone Postgres instead.
- **Model runtime**: in development, a running Ollama is detected and used (the boot log names
  the chat model, the embedding model and the context window). `LLM_BASE_URL`/`LLM_MODEL` override
  it; production never auto-detects.
- **Media tools**: `ffmpeg` on `PATH` is probed at boot; Piper is used when `PIPER_PATH` and
  `PIPER_VOICE` are set.

Configuration lives in `.env` (copy `.env.example`) at the repository root or in `backend/.env`.
The frontend reads `NEXT_PUBLIC_API_URL` (default `http://localhost:8787`).

## Docker Compose

```bash
docker compose up -d --build
docker compose --profile setup run --rm ollama-pull     # once
open http://localhost:3000
```

Postgres, Ollama, the API, the background worker and the web app, each in its own container.
[docker/README.md](../docker/README.md) describes the services and what the file relaxes for a
single machine.

## Checks

```bash
npm run build && npm run typecheck && npm run lint && npm test   # from the root
bash scripts/verify-boundary.sh     # frontend/backend separation, from the syntax tree
bash scripts/verify-migrations.sh   # migrations apply to an empty DB, no drift
bash scripts/verify-boot.sh         # production boot refusals and roles
cd frontend && npx playwright test  # real browser against a real API and database
node scripts/acceptance/full-system.mjs   # the whole user journey against a running stack
```

[TESTING.md](TESTING.md) says what each of these proves and which binaries the gated suites need.

## Troubleshooting

- **PGlite `RuntimeError: Aborted()` at boot**: the local database was corrupted by a forced kill.
  Delete `backend/data/pgdata`; it is re-created and migrated on the next boot.
- **Chat says no model is configured**: start Ollama (above), or set `LLM_BASE_URL` and
  `LLM_MODEL`.
- **The agent's answers ignore the task on long runs**: the model's context window is too small
  for the run. Raise `OLLAMA_CONTEXT_LENGTH` (and `LLM_CONTEXT_WINDOW` if set explicitly).
- **Sign-up returns 429**: the per-IP sign-up limit (`AUTH_RATE_LIMIT_MAX`, default 5 per 10
  minutes; login allows twice that) is working. Wait, or raise it for scripted testing.
