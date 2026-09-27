# Full-system acceptance

- API: `http://127.0.0.1:8787`
- Started: 2026-09-27T11:49:57.543Z, 2281.4 s
- **19 PASS · 3 FAIL · 0 BLOCKED_EXTERNAL**

| Check | Status | Seconds | Measurement |
|---|---|---|---|
| AUTH-SIGNUP — Create an account | PASS | 0.9 | signed up journey-1790509797607-285551@example.com; default project 32795588…, role admin |
| AUTH-SESSION — Logout revokes the session; login restores it | PASS | 0.5 | logout 200; the old cookie replayed -> 401 (401 = revoked server-side); login again -> /auth/me 200 |
| PROJECT-CREATE — Create a project and work in it | PASS | 0 | created project cec9f005…; the account now lists 2 project(s); all later checks run in it |
| PROVIDERS — The platform states what it runs | PASS | 0 | models: "provider":"local" default undefined; image stable-diffusion.cpp, video image-motion, speech piper |
| CHAT-STREAM — A real model answers, streamed progressively | PASS | 7.7 | local/qwen2.5:7b: 28 token events, first at 1700 ms, last at 7511 ms (spread 5811 ms); 39 in / 29 out; "A unit test is a type of software testing where individual units or the smallest" |
| CHAT-HISTORY — The conversation is stored and continues | FAIL | 11.9 | 6 messages persisted in conversation 4d9a8239…; asked for the word planted two turns earlier (vermilion-943), it answered "password123" |
| MEMORY-FORMATION — A fact told in one conversation is remembered without being filed by hand | PASS | 20.9 | the model extracted "The user's project codename is NIGHTHAWK-938934." (scope user) from the turn |
| MEMORY-RECALL — A NEW conversation answers from memory | PASS | 6 | new conversation (no conversationId) answered "NIGHTHAWK-938934" — expected NIGHTHAWK-938934 |
| MEMORY-DELETE — A deleted memory is no longer recalled | PASS | 0 | deleted 1 memory item(s) holding the codename; 0 remain |
| RAG-INGEST — Upload a document; it is parsed, chunked and embedded | PASS | 4.1 | document 64c07cbe… reached "ready" (scan: skipped_no_scanner) |
| RAG-ANSWER — A grounded answer, with a real citation | PASS | 8.3 | grounded=true outcome=grounded; "An engineer receives 27 days of paid leave per calendar year. [1]"; 1 source(s), the handbook's excerpt cited: true |
| RAG-REFUSAL — No evidence, no answer — and a refusal is never called grounded | PASS | 4.2 | grounded=false outcome=refused; "The provided documents do not contain the answer to this question." |
| IMAGE — Generate a 512×512 image of a red apple on a wooden table | PASS | 456.5 | stable-diffusion.cpp in 456.4 s: image/png, 369699 bytes, 512×512; luminance stddev 75.9, 420 distinct colours, red-dominant pixels 3% |
| AUDIO — Synthesise speech and play it back | PASS | 3 | piper in 3 s: audio/wav, 126252 bytes, 16000 Hz, 3.94 s, RMS 0.157 (0 = silence) |
| VIDEO — Prompt → script → storyboard → narration → subtitles → visuals → MP4 | FAIL | 925.8 | succeeded in 925.8 s: 2 scene(s), 0 narrated; MP4 404199 bytes, 8.0 s, streams [video:h264]; WebVTT missing/invalid |
| CODING-AGENT — The agent fixes the SOURCE so the test passes, and the fix is verified independently | FAIL | 827.8 | task FAILED in 827.7 s (Test command exited 1. node:assert:150   throw new AssertionError(obj);   ^  Ass); source changed: false; test file untouched: true; independent run: exit 1: node:assert:150 |
| USAGE — Tokens spent are metered | PASS | 0 | this project spent 48843 tokens today across the calls above (scope organization) |
| AUDIT — The project's audit trail records what happened in it | PASS | 0 | 9 entries, all in this project: true; actions: tool.call, project.create |
| TENANT-ISOLATION — Another tenant cannot read this one's data | PASS | 0.9 | victim's conversation, document and workspace file -> 404, 404, 404; the intruder's own workspace has no sum.js -> 404 |
| METRICS — Prometheus metrics carry real values | PASS | 0.4 | 200; http_requests_total 564, provider_request_count 31, token_usage_total 49845, generation_total 4, job_processed_total 7, tool_call_count 8 |
| PERSISTENCE — Log out, log back in: everything is still there | PASS | 0.4 | after a fresh login: 3 conversation(s) in the project; the handbook -> 200 |
| RATE-LIMIT — A route's limit is enforced and says when to retry | PASS | 2 | 429 RATE_LIMITED; retry-after 59 s; limit 30 |
