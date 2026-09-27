# Full-system acceptance

- API: `http://127.0.0.1:8787`
- Started: 2026-09-27T14:03:27.357Z, 1507.6 s
- **23 PASS · 1 FAIL · 0 BLOCKED_EXTERNAL**

| Check | Status | Seconds | Measurement |
|---|---|---|---|
| AUTH-SIGNUP — Create an account | PASS | 1 | signed up journey-1790517807428-799413@example.com; default project c216be6b…, role admin |
| AUTH-SESSION — Logout revokes the session; login restores it | PASS | 0.5 | logout 200; the old cookie replayed -> 401 (401 = revoked server-side); login again -> /auth/me 200 |
| PROJECT-CREATE — Create a project and work in it | PASS | 0 | created project 8601beef…; the account now lists 2 project(s); all later checks run in it |
| PROVIDERS — The platform states what it runs | PASS | 0 | models: "provider":"local" default undefined; image stable-diffusion.cpp, video image-motion, speech piper |
| CHAT-STREAM — A real model answers, streamed progressively | PASS | 8.6 | local/qwen2.5:7b: 32 token events, first at 827 ms, last at 8368 ms (spread 7541 ms); 39 in / 33 out; "A unit test is a type of automated test used to verify that a small, discrete pi" |
| CHAT-HISTORY — The conversation is stored and continues | PASS | 18.1 | 6 messages persisted in conversation aff6f59a…; continued from the stored history, asked for the word planted two turns earlier (vermilion-629), it answered "vermilion-629" |
| MEMORY-FORMATION — A fact told in one conversation is remembered without being filed by hand | PASS | 26.4 | the model extracted "The user's project codename is NIGHTHAWK-986403." (scope user) from the turn |
| MEMORY-RECALL — A NEW conversation answers from memory | PASS | 5.7 | new conversation (no conversationId) answered "NIGHTHAWK-986403" — expected NIGHTHAWK-986403 |
| MEMORY-DELETE — A deleted memory is no longer recalled | PASS | 0 | deleted 1 memory item(s) holding the codename; 0 remain |
| RAG-INGEST — Upload a document; it is parsed, chunked and embedded | PASS | 2 | document 1e450a68… reached "ready" (scan: skipped_no_scanner) |
| RAG-ANSWER — A grounded answer, with a real citation | PASS | 21.2 | grounded=true outcome=grounded; "An engineer receives 27 days of paid leave per calendar year. [1]"; 1 source(s), the handbook's excerpt cited: true |
| RAG-REFUSAL — No evidence, no answer — and a refusal is never called grounded | PASS | 4.1 | grounded=false outcome=refused; "The provided documents do not contain the answer to this question." |
| IMAGE — Generate a 512×512 image of a red apple on a wooden table | PASS | 443.3 | stable-diffusion.cpp in 443.3 s: image/png, 369699 bytes, 512×512; luminance stddev 75.9, 420 distinct colours, red-dominant pixels 3% |
| AUDIO — Synthesise speech and play it back | PASS | 3 | piper in 3 s: audio/wav, 127276 bytes, 16000 Hz, 3.98 s, RMS 0.158 (0 = silence) |
| VIDEO — Prompt → script → storyboard → narration → subtitles → visuals → MP4 | PASS | 461.6 | succeeded in 461.6 s: 2 scene(s), 2 narrated, storyboard model; MP4 426558 bytes, 8.0 s, streams [video:h264, audio:aac, subtitle:mov_text]; WebVTT valid |
| CODING-AGENT — The agent fixes the SOURCE so the test passes, and the fix is verified independently | PASS | 496.5 | task COMPLETED in 496.5 s; source changed: true; test file untouched: true; independent run: ok (exit 0) |
| MCP — A tool served by a real MCP server runs inside an agent task, in this project only | PASS | 12.6 | task COMPLETED: reference-filesystem (stdio) read "The keeper's code word is lantern-416."; the model answered "lantern-416" (expected lantern-416); a path outside the workspace: refused |
| USAGE — Tokens spent are metered | PASS | 0 | this project spent 42044 tokens today across the calls above (scope organization) |
| QUOTA — A request over a configured limit is refused before any work, and says why | PASS | 0 | limit 60 s/month, 8 s used; asked for 56 s -> 429 QUOTA_EXCEEDED: "Monthly video-seconds limit of 60 would be exceeded (8s used so far this month)."; video projects before/after: 1/1 |
| AUDIT — The project's audit trail records what happened in it | PASS | 0 | 18 entries, all in this project: true; actions: tool.call.mcp, tool.call, project.create |
| TENANT-ISOLATION — Another tenant cannot read this one's data | PASS | 0.9 | victim's conversation, document and workspace file -> 404, 404, 404; the intruder's own workspace has no sum.js -> 404 |
| METRICS — Prometheus metrics carry real values | FAIL | 0.5 | 200; http_requests_total 604, provider_request_count 29, token_usage_total 42732, generation_total 0, job_processed_total 1, tool_call_count 17; still zero: generation_total |
| PERSISTENCE — Log out, log back in: everything is still there | PASS | 0.5 | after a fresh login: 3 conversation(s) in the project; the handbook -> 200 |
| RATE-LIMIT — A route's limit is enforced and says when to retry | PASS | 1.1 | 429 RATE_LIMITED; retry-after 59 s; limit 30 |
