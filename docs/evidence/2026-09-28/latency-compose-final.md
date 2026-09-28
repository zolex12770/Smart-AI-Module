# Latency — 2026-09-28T13:18:03.465Z

API: http://127.0.0.1:8787

| Measurement (ms) | n | p50 | p95 | max |
|---|---|---|---|---|
| liveness `GET /api/health` | 50 | 2.8 | 4.3 | 6.5 |
| authenticated read `GET /api/v1/conversations` | 30 | 6.2 | 14.9 | 29.5 |
| readiness `GET /api/v1/admin/health` (database + queue) | 20 | 12.3 | 15.4 | 15.4 |
| embedding, one passage (nomic-embed-text) | 10 | 138.5 | 219.5 | 219.5 |
| chat: time to first token | 3 | 3370 | 3911 | 3911 |
| chat: interval between tokens | 154 | 224 | 306 | 391 |
