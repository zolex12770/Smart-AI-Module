# Cold boot on the 2026-10-11 images

This was the stack's first start after the images were rebuilt with the DL-32 lockfile. Ollama's
process had just started and had no model in memory, and the API's warm-up was its first chat
request.

| Image | ID | Built (UTC) |
|---|---|---|
| `smart-ai-api:local` | `sha256:4628914e55be…` | 2026-10-11 09:00:54 |
| `smart-ai-web:local` | `sha256:4fda67675bcb…` | 2026-10-11 09:03:34 |

| Step | Result |
|---|---|
| API container started | 09:03:50 |
| Ollama `OLLAMA_LOAD_TIMEOUT` in the container | `20m` (DL-29) |
| API log | `"model":"qwen2.5:7b","ms":406251,"msg":"chat model warmed up"` at 09:10:39 |
| Ollama log | `200 \| 6m46s \| POST "/v1/chat/completions"` at 09:10:39 |

The load took **406.3 s**. That is past both 300-second limits that failed earlier cold boots:
undici's default headers timeout (DL-27) and Ollama's default load timeout (DL-29). It still
succeeded on the first attempt, with no retry.
