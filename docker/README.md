# Docker

The images and the local stack. The Dockerfiles live beside the code they build
(`backend/Dockerfile`, `frontend/Dockerfile`) because each is built from the repository root: an
npm-workspaces monorepo needs the whole tree for `npm ci` to resolve the internal `@ai-platform/*`
packages. The stack that runs them is `docker-compose.yml` at the root.

## Images

| Image | Built from | Contains |
|---|---|---|
| `smart-ai-api:local` | `backend/Dockerfile` | The API and the worker (same image, `ROLE=api` / `ROLE=worker`), ffmpeg, Piper and one voice |
| `smart-ai-web:local` | `frontend/Dockerfile` | The Next.js standalone server. `NEXT_PUBLIC_API_URL` is inlined at **build** time |

```bash
docker build -f backend/Dockerfile -t smart-ai-api:local .
docker build -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=http://localhost:8787 -t smart-ai-web:local .
```

### Building behind a TLS-intercepting proxy

Both Dockerfiles accept an optional BuildKit secret, `build_ca`: the proxy's CA bundle, trusted
only by the RUN steps that download (npm, the Piper archive) and never written into a layer.

```bash
docker build -f backend/Dockerfile --secret id=build_ca,src=/path/to/proxy-ca.pem -t smart-ai-api:local .
```

With Compose, add under each service's `build:` a `secrets: [build_ca]` entry and declare
`secrets: { build_ca: { file: /path/to/proxy-ca.pem } }` at the top level.

### A network that cannot reach huggingface.co

The API image downloads its Piper voice from the Hugging Face voice repository. Where that host is
blocked, point it at an archive on GitHub instead (the voice from Piper's own `v0.0.2` release):

```bash
PIPER_VOICE_ARCHIVE_URL=https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-us-lessac-low.tar.gz \
  docker compose build api
```

Either way the voice lands at `/opt/piper-voices/voice.onnx`, which is what `PIPER_VOICE` names.

## The local stack

```bash
docker compose up -d --build
docker compose --profile setup run --rm ollama-pull   # once: qwen2.5:7b and nomic-embed-text
open http://localhost:3000
```

| Service | Port | Role |
|---|---|---|
| `postgres` | — | pgvector/pgvector:pg16. Migrations are applied by the API at boot |
| `ollama` | 127.0.0.1:11434 | The model runtime, with a 16K context (`OLLAMA_CONTEXT_LENGTH`) |
| `api` | 8787 | HTTP API (`ROLE=api`) |
| `worker` | — | Document ingestion and media rendering (`ROLE=worker`), started after the API is healthy so the two never migrate at once |
| `web` | 3000 | The browser application |

`docker compose ps` shows health; `docker compose logs -f api worker` shows what each is doing.

**What the compose file relaxes for one machine** is stated at its top: `COOKIE_SECURE=false`
(plain-HTTP localhost), process isolation for the agent's sandbox inside the API container, and a
local-only default Postgres password. None of these is how `infrastructure/terraform` deploys.

### Models already downloaded

A volume that already holds models can be reused instead of pulling again:

```bash
OLLAMA_VOLUME=ollama docker compose up -d
```
