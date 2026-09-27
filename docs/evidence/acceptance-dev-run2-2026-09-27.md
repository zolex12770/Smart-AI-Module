# Full-system acceptance

- API: `http://127.0.0.1:8787`
- Started: 2026-09-27T12:36:33.637Z, 2383.9 s
- **19 PASS · 3 FAIL · 0 BLOCKED_EXTERNAL**

| Check | Status | Seconds | Measurement |
|---|---|---|---|
| AUTH-SIGNUP — Create an account | PASS | 0.8 | signed up journey-1790512593699-200915@example.com; default project 7fbdba76…, role admin |
| AUTH-SESSION — Logout revokes the session; login restores it | PASS | 0.4 | logout 200; the old cookie replayed -> 401 (401 = revoked server-side); login again -> /auth/me 200 |
| PROJECT-CREATE — Create a project and work in it | PASS | 0 | created project 35ab48b9…; the account now lists 2 project(s); all later checks run in it |
| PROVIDERS — The platform states what it runs | PASS | 0 | models: "provider":"local" default undefined; image stable-diffusion.cpp, video image-motion, speech piper |
| CHAT-STREAM — A real model answers, streamed progressively | PASS | 6.9 | local/qwen2.5:7b: 33 token events, first at 454 ms, last at 6721 ms (spread 6267 ms); 39 in / 34 out; "A unit test is a type of software testing where individual units or components o" |
| CHAT-HISTORY — The conversation is stored and continues | PASS | 9.2 | 6 messages persisted in conversation a999be11…; continued from the stored history, asked for the word planted two turns earlier (vermilion-847), it answered "vermilion-847" |
| MEMORY-FORMATION — A fact told in one conversation is remembered without being filed by hand | FAIL | 196.2 | no memory containing NIGHTHAWK-252997 was formed within 180 s |
| MEMORY-RECALL — A NEW conversation answers from memory | FAIL | 4.6 | new conversation (no conversationId) answered "NIGHTHAWK-252597" — expected NIGHTHAWK-252997 |
| MEMORY-DELETE — A deleted memory is no longer recalled | PASS | 0 | deleted 1 memory item(s) holding the codename; 0 remain |
| RAG-INGEST — Upload a document; it is parsed, chunked and embedded | PASS | 2.1 | document 55cccaa9… reached "ready" (scan: skipped_no_scanner) |
| RAG-ANSWER — A grounded answer, with a real citation | PASS | 5.4 | grounded=true outcome=grounded; "An engineer receives 27 days of paid leave per calendar year. [1]"; 1 source(s), the handbook's excerpt cited: true |
| RAG-REFUSAL — No evidence, no answer — and a refusal is never called grounded | PASS | 4 | grounded=false outcome=refused; "The provided documents do not contain the answer to this question." |
| IMAGE — Generate a 512×512 image of a red apple on a wooden table | PASS | 350.4 | stable-diffusion.cpp in 350.4 s: image/png, 369699 bytes, 512×512; luminance stddev 75.9, 420 distinct colours, red-dominant pixels 3% |
| AUDIO — Synthesise speech and play it back | PASS | 3 | piper in 3 s: audio/wav, 125228 bytes, 16000 Hz, 3.91 s, RMS 0.129 (0 = silence) |
| VIDEO — Prompt → script → storyboard → narration → subtitles → visuals → MP4 | PASS | 427.2 | succeeded in 427.2 s: 2 scene(s), 2 narrated, storyboard model; MP4 387577 bytes, 8.0 s, streams [video:h264, audio:aac, subtitle:mov_text]; WebVTT valid |
| CODING-AGENT — The agent fixes the SOURCE so the test passes, and the fix is verified independently | FAIL | 1369.7 | task FAILED in 1369.6 s (Test command exited 1. node:assert:150   throw new AssertionError(obj);   ^  Ass); source changed: false; test file untouched: true; independent run: exit 1: node:assert:150 |
| USAGE — Tokens spent are metered | PASS | 0 | this project spent 89771 tokens today across the calls above (scope organization) |
| AUDIT — The project's audit trail records what happened in it | PASS | 0 | 17 entries, all in this project: true; actions: tool.call, project.create |
| TENANT-ISOLATION — Another tenant cannot read this one's data | PASS | 0.9 | victim's conversation, document and workspace file -> 404, 404, 404; the intruder's own workspace has no sum.js -> 404 |
| METRICS — Prometheus metrics carry real values | PASS | 0.5 | 200; http_requests_total 590, provider_request_count 27, token_usage_total 89771, generation_total 4, job_processed_total 7, tool_call_count 16 |
| PERSISTENCE — Log out, log back in: everything is still there | PASS | 0.5 | after a fresh login: 3 conversation(s) in the project; the handbook -> 200 |
| RATE-LIMIT — A route's limit is enforced and says when to retry | PASS | 2 | 429 RATE_LIMITED; retry-after 59 s; limit 30 |
