# Failure injection

- API: `http://127.0.0.1:8787`
- Started: 2026-09-30T11:52:14.244Z
- **5 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL in 70 s**

| Check | Status | Seconds | Observed |
|---|---|---|---|
| LLM-DOWN — Model runtime stopped: chat and RAG fail fast with a clear error, then recover | PASS | 20 | chat failed in 1s with "The model provider failed to respond. Please try again."; RAG → 502; nothing charged; chat answered again after restart |
| DB-DOWN — Postgres stopped: readiness says so, requests fail fast, and the API recovers without a restart | PASS | 6 | authenticated read → 503 in 0s; liveness stayed 200; recovered without restarting the API |
| WORKER-DOWN — Worker stopped: queued work waits, durably, and completes when a worker returns | PASS | 27 | pending for 20 s with no worker; succeeded after the worker restarted |
| MEDIA-CRASH — The image process killed mid-generation: the image fails honestly and is not charged | PASS | 9 | settled "failed" with "Image generation failed. The server log records why, against this id."; not charged |
| MCP-CRASH — The MCP server process killed: it is marked down and its tools removed; reconnect restores it | PASS | 6 | marked "failed" with 0 tools ("Not connected"); reconnect restored 14 tools |
