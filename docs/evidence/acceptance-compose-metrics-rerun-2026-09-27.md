# Full-system acceptance

- API: `http://127.0.0.1:8787`
- Started: 2026-09-27T14:34:04.607Z, 22.4 s
- **7 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL**

| Check | Status | Seconds | Measurement |
|---|---|---|---|
| AUTH-SIGNUP — Create an account | PASS | 0.9 | signed up journey-1790519644675-487519@example.com; default project 2816751b…, role admin |
| PROJECT-CREATE — Create a project and work in it | PASS | 0 | created project 86b5a813…; the account now lists 2 project(s); all later checks run in it |
| PROVIDERS — The platform states what it runs | PASS | 0 | chat models: local/qwen2.5:7b; default local/qwen2.5:7b; image stable-diffusion.cpp, video image-motion, speech piper |
| CHAT-STREAM — A real model answers, streamed progressively | PASS | 8.2 | local/qwen2.5:7b: 35 token events, first at 720 ms, last at 8022 ms (spread 7302 ms); 39 in / 36 out; "A unit test is a type of automated software testing where individual units or sm" |
| AUDIO — Synthesise speech and play it back | PASS | 3.1 | piper in 3.1 s: audio/wav, 130860 bytes, 16000 Hz, 4.09 s, RMS 0.174 (0 = silence) |
| MCP — A tool served by a real MCP server runs inside an agent task, in this project only | PASS | 9.6 | task COMPLETED: reference-filesystem (stdio) read "The keeper's code word is lantern-978."; the model answered "lantern-978" (expected lantern-978); a path outside the workspace: refused |
| METRICS — Prometheus metrics carry real values | PASS | 0.5 | API 200, http://127.0.0.1:9464/metrics 200; summed: http_requests_total 32, provider_request_count 3, token_usage_total 489, generation_total 1, job_processed_total 1, tool_call_count 4 |
