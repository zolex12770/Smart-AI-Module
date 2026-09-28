# Full-system acceptance

- API: `http://127.0.0.1:8787`
- Started: 2026-09-28T06:19:35.485Z, 1772.5 s
- **24 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL**

| Check | Status | Seconds | Measurement |
|---|---|---|---|
| AUTH-SIGNUP — Create an account | PASS | 0.9 | signed up journey-1790576375547-643146@example.com; default project 8f70464f…, role admin |
| AUTH-SESSION — Logout revokes the session; login restores it | PASS | 0.4 | logout 200; the old cookie replayed -> 401 (401 = revoked server-side); login again -> /auth/me 200 |
| PROJECT-CREATE — Create a project and work in it | PASS | 0 | created project 2e4f4cfc…; the account now lists 2 project(s); all later checks run in it |
| PROVIDERS — The platform states what it runs | PASS | 0 | chat models: local/qwen2.5:7b; default local/qwen2.5:7b; image stable-diffusion.cpp, video image-motion, speech piper |
| CHAT-STREAM — A real model answers, streamed progressively | PASS | 9.5 | local/qwen2.5:7b: 35 token events, first at 915 ms, last at 9107 ms (spread 8192 ms); 39 in / 36 out; "A unit test is a type of automated test used to verify that a small, identifiabl" |
| CHAT-HISTORY — The conversation is stored and continues | PASS | 15.6 | 6 messages persisted in conversation 0c7f3988…; continued from the stored history, asked for the word planted two turns earlier (vermilion-479), it answered "vermilion-479" |
| MEMORY-FORMATION — A fact told in one conversation is remembered without being filed by hand | PASS | 28.6 | the model extracted "The user's project codename is NIGHTHAWK-908536." (scope user) from the turn |
| MEMORY-RECALL — A NEW conversation answers from memory | PASS | 6.9 | new conversation (no conversationId) answered "NIGHTHAWK-908536" — expected NIGHTHAWK-908536 |
| MEMORY-DELETE — A deleted memory is no longer recalled | PASS | 0 | deleted 1 memory item(s) holding the codename; 0 remain |
| RAG-INGEST — Upload a document; it is parsed, chunked and embedded | PASS | 2 | document 09f3075b… reached "ready" (scan: skipped_no_scanner) |
| RAG-ANSWER — A grounded answer, with a real citation | PASS | 13.8 | grounded=true outcome=grounded; "An engineer receives 27 days of paid leave per calendar year. [1]"; 1 source(s), the handbook's excerpt cited: true |
| RAG-REFUSAL — No evidence, no answer — and a refusal is never called grounded | PASS | 4 | grounded=false outcome=refused; "The provided documents do not contain the answer to this question." |
| IMAGE — Generate a 512×512 image of a red apple on a wooden table | PASS | 632.3 | stable-diffusion.cpp in 632.3 s: image/png, 369699 bytes, 512×512; luminance stddev 75.9, 420 distinct colours, red-dominant pixels 3% |
| AUDIO — Synthesise speech and play it back | PASS | 3 | piper in 3 s: audio/wav, 130860 bytes, 16000 Hz, 4.09 s, RMS 0.136 (0 = silence) |
| VIDEO — Prompt → script → storyboard → narration → subtitles → visuals → MP4 | PASS | 486.8 | succeeded in 486.8 s: 2 scene(s), 2 narrated, storyboard model; MP4 499968 bytes, 8.0 s, streams [video:h264, audio:aac, subtitle:mov_text]; WebVTT valid |
| CODING-AGENT — The agent fixes the SOURCE so the test passes, and the fix is verified independently | PASS | 547 | task COMPLETED in 547 s; source changed: true; test file untouched: true; independent run: ok (exit 0) |
| MCP — A tool served by a real MCP server runs inside an agent task, in this project only | PASS | 9.6 | task COMPLETED: reference-filesystem (stdio) read "The keeper's code word is lantern-480."; the model answered "lantern-480" (expected lantern-480); a path outside the workspace: refused |
| USAGE — Tokens spent are metered | PASS | 0.1 | this project spent 23479 tokens today across the calls above (scope organization) |
| QUOTA — A request over a configured limit is refused before any work, and says why | PASS | 0.1 | limit 60 s/month, 8 s used; asked for 56 s -> 429 QUOTA_EXCEEDED: "Monthly video-seconds limit of 60 would be exceeded (8s used so far this month)."; video projects before/after: 1/1 |
| AUDIT — The project's audit trail records what happened in it | PASS | 0 | 10 entries, all in this project: true; actions: tool.call.mcp, tool.call, project.create |
| TENANT-ISOLATION — Another tenant cannot read this one's data | PASS | 1 | victim's conversation, document and workspace file -> 404, 404, 404; the intruder's own workspace has no sum.js -> 404 |
| METRICS — Prometheus metrics carry real values | PASS | 0.4 | API 200, http://127.0.0.1:9464/metrics 200; summed: http_requests_total 648, provider_request_count 21, token_usage_total 23479, generation_total 4, job_processed_total 7, tool_call_count 9 |
| PERSISTENCE — Log out, log back in: everything is still there | PASS | 0.4 | after a fresh login: 3 conversation(s) in the project; the handbook -> 200 |
| RATE-LIMIT — A route's limit is enforced and says when to retry | PASS | 9.9 | 429 RATE_LIMITED; retry-after 51 s; limit 30 |
