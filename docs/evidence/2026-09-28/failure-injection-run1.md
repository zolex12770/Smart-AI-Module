# Failure injection

- API: `http://127.0.0.1:8787`
- Started: 2026-09-28T12:04:41.275Z
- **1 PASS · 4 FAIL · 0 BLOCKED_EXTERNAL in 108 s**

| Check | Status | Seconds | Observed |
|---|---|---|---|
| LLM-DOWN — Model runtime stopped: chat and RAG fail fast with a clear error, then recover | FAIL | 65 | RAG with no embedding runtime → 500 |
| DB-DOWN — Postgres stopped: readiness says so, requests fail fast, and the API recovers without a restart | FAIL | 6 | liveness (/api/health) → 500; it must stay up so the orchestrator does not kill a process that will recover |
| WORKER-DOWN — Worker stopped: queued work waits, durably, and completes when a worker returns | PASS | 27 | pending for 20 s with no worker; succeeded after the worker restarted |
| MEDIA-CRASH — The image process killed mid-generation: the image fails honestly and is not charged | FAIL | 7 | threw: Command failed: docker exec cf5c1fd478133ea1e32d296f5766e95ef823c12f34a3ee07a1baa90747dffa10 sh -c 'pkill -9 -f sd-cli \|\| kill -9 $(pidof sd-cli)' |
| MCP-CRASH — The MCP server process killed: it is marked down and its tools removed; reconnect restores it | FAIL | 1 | threw: Command failed: docker exec 331b3d71cde2eea70000f7df0c55dbd6f7aa8ac584e6498532e420303e52d1de sh -c 'pkill -9 -f server-filesystem' |
