# Ollama's load limit (DL-29)

| Run | Configuration | Result |
|---|---|---|
| Real cold boot, 2026-10-01 04:27 | the previous `docker-compose.yml` (no `OLLAMA_LOAD_TIMEOUT`) | the API's warm-up got **500 after 5m5s**: "timed out waiting for llama-server to start" |
| Reproduction | the previous compose file; page cache dropped; Ollama's reads limited to 6 MiB/s | `POST /api/generate` → **500 after 301.7 s**, the same error |
| After the change | `OLLAMA_LOAD_TIMEOUT=20m` (the new compose file); the same cache drop and the same 6 MiB/s limit | `POST /api/generate` → **200 after 772.6 s**, `"done": true` |

The read limit came from a compose override kept outside the repository:
`blkio_config.device_read_bps: [{path: /dev/vda, rate: 6mb}]`.
