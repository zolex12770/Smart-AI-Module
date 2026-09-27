# Latency — 2026-09-27T14:34:34.123Z

API: http://127.0.0.1:8787

| Measurement (ms) | n | p50 | p95 | max |
|---|---|---|---|---|
| liveness `GET /api/health` | 50 | 2.4 | 3 | 3.5 |
| authenticated read `GET /api/v1/conversations` | 30 | 5.4 | 7.6 | 7.8 |
| readiness `GET /api/v1/admin/health` (database + queue) | 20 | 11.4 | 14.9 | 14.9 |
| embedding, one passage (nomic-embed-text) | 10 | 121.9 | 308.4 | 308.4 |
| chat: time to first token | 3 | 3555 | 3850 | 3850 |
| chat: interval between tokens | 154 | 207 | 289 | 429 |
