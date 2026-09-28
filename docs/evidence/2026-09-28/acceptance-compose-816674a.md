# Full-system acceptance

- API: `http://127.0.0.1:8787`
- Started: 2026-09-28T13:57:00.194Z, 1728.8 s
- **23 PASS · 1 FAIL · 0 BLOCKED_EXTERNAL**

| Check | Status | Seconds | Measurement |
|---|---|---|---|
| AUTH-SIGNUP — Create an account | PASS | 1.2 | signed up journey-1790603820298-30215@example.com; default project 6f886172…, role admin |
| AUTH-SESSION — Logout revokes the session; login restores it | PASS | 0.6 | logout 200; the old cookie replayed -> 401 (401 = revoked server-side); login again -> /auth/me 200 |
| PROJECT-CREATE — Create a project and work in it | PASS | 0.1 | created project 3d897b20…; the account now lists 2 project(s); all later checks run in it |
| PROVIDERS — The platform states what it runs | PASS | 0 | chat models: local/qwen2.5:7b; default local/qwen2.5:7b; image stable-diffusion.cpp, video image-motion, speech piper |
| CHAT-STREAM — A real model answers, streamed progressively | PASS | 14.7 | local/qwen2.5:7b: 45 token events, first at 2450 ms, last at 14413 ms (spread 11963 ms); 39 in / 46 out; "A unit test is a type of automated test that verifies the correctness of an indi" |
| CHAT-HISTORY — The conversation is stored and continues | PASS | 11.4 | 6 messages persisted in conversation 5143d733…; continued from the stored history, asked for the word planted two turns earlier (vermilion-416), it answered "vermilion-416" |
| MEMORY-FORMATION — A fact told in one conversation is remembered without being filed by hand | PASS | 25.1 | the model extracted "The user's project codename is NIGHTHAWK-356550." (scope user) from the turn |
| MEMORY-RECALL — A NEW conversation answers from memory | PASS | 5.4 | new conversation (no conversationId) answered "NIGHTHAWK-356550" — expected NIGHTHAWK-356550 |
| MEMORY-DELETE — A deleted memory is no longer recalled | PASS | 0 | deleted 1 memory item(s) holding the codename; 0 remain |
| RAG-INGEST — Upload a document; it is parsed, chunked and embedded | PASS | 4.1 | document 420749ea… reached "ready" (scan: skipped_no_scanner) |
| RAG-ANSWER — A grounded answer, with a real citation | PASS | 14.7 | grounded=true outcome=grounded; "An engineer receives 27 days of paid leave per calendar year. [1]"; 1 source(s), the handbook's excerpt cited: true |
| RAG-REFUSAL — No evidence, no answer — and a refusal is never called grounded | PASS | 4 | grounded=false outcome=refused; "The provided documents do not contain the answer to this question." |
| IMAGE — Generate a 512×512 image of a red apple on a wooden table | PASS | 547 | stable-diffusion.cpp in 547 s: image/png, 369699 bytes, 512×512; luminance stddev 75.9, 420 distinct colours, red-dominant pixels 3% |
| AUDIO — Synthesise speech and play it back | PASS | 6.1 | piper in 6.1 s: audio/wav, 130860 bytes, 16000 Hz, 4.09 s, RMS 0.154 (0 = silence) |
| VIDEO — Prompt → script → storyboard → narration → subtitles → visuals → MP4 | PASS | 595.3 | succeeded in 595.3 s: 2 scene(s), 2 narrated, storyboard model; MP4 436270 bytes, 8.0 s, streams [video:h264, audio:aac, subtitle:mov_text]; WebVTT valid |
| CODING-AGENT — The agent fixes the SOURCE so the test passes, and the fix is verified independently | FAIL | 481.7 | task FAILED in 481.6 s (The agent stopped after 12 turns (max_iterations) without reaching an answer.); source changed: false; test file untouched: true; independent run: exit 1: node:assert:150 |
| MCP — A tool served by a real MCP server runs inside an agent task, in this project only | PASS | 12.6 | task COMPLETED: reference-filesystem (stdio) read "The keeper's code word is lantern-519."; the model answered "lantern-519" (expected lantern-519); a path outside the workspace: refused |
| USAGE — Tokens spent are metered | PASS | 0.1 | this project spent 42208 tokens today across the calls above (scope organization) |
| QUOTA — A request over a configured limit is refused before any work, and says why | PASS | 0 | limit 60 s/month, 8 s used; asked for 56 s -> 429 QUOTA_EXCEEDED: "Monthly video-seconds limit of 60 would be exceeded (8s used so far this month)."; video projects before/after: 1/1 |
| AUDIT — The project's audit trail records what happened in it | PASS | 0 | 17 entries, all in this project: true; actions: tool.call.mcp, tool.call, project.create |
| TENANT-ISOLATION — Another tenant cannot read this one's data | PASS | 1.2 | victim's conversation, document and workspace file -> 404, 404, 404; the intruder's own workspace has no sum.js -> 404 |
| METRICS — Prometheus metrics carry real values | PASS | 0.6 | API 200, http://127.0.0.1:9464/metrics 200; summed: http_requests_total 694, provider_request_count 26, token_usage_total 42208, generation_total 4, job_processed_total 7, tool_call_count 16 |
| PERSISTENCE — Log out, log back in: everything is still there | PASS | 0.5 | after a fresh login: 3 conversation(s) in the project; the handbook -> 200 |
| RATE-LIMIT — A route's limit is enforced and says when to retry | PASS | 2.5 | 429 RATE_LIMITED; retry-after 58 s; limit 30 |
