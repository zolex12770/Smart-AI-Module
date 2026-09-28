# Full-system acceptance

- API: `http://127.0.0.1:8787`
- Started: 2026-09-28T12:39:04.169Z, 1192.6 s
- **24 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL**

| Check | Status | Seconds | Measurement |
|---|---|---|---|
| AUTH-SIGNUP — Create an account | PASS | 1.1 | signed up journey-1790599144249-925775@example.com; default project de40cdad…, role admin |
| AUTH-SESSION — Logout revokes the session; login restores it | PASS | 0.5 | logout 200; the old cookie replayed -> 401 (401 = revoked server-side); login again -> /auth/me 200 |
| PROJECT-CREATE — Create a project and work in it | PASS | 0 | created project 4cfca59b…; the account now lists 2 project(s); all later checks run in it |
| PROVIDERS — The platform states what it runs | PASS | 0 | chat models: local/qwen2.5:7b; default local/qwen2.5:7b; image stable-diffusion.cpp, video image-motion, speech piper |
| CHAT-STREAM — A real model answers, streamed progressively | PASS | 10.1 | local/qwen2.5:7b: 34 token events, first at 927 ms, last at 9805 ms (spread 8878 ms); 39 in / 35 out; "A unit test is a type of automated test used to verify that a small identifiable" |
| CHAT-HISTORY — The conversation is stored and continues | PASS | 11.1 | 6 messages persisted in conversation 15116774…; continued from the stored history, asked for the word planted two turns earlier (vermilion-298), it answered "vermilion-298" |
| MEMORY-FORMATION — A fact told in one conversation is remembered without being filed by hand | PASS | 29.6 | the model extracted "The user's project codename is NIGHTHAWK-384272." (scope user) from the turn |
| MEMORY-RECALL — A NEW conversation answers from memory | PASS | 6.9 | new conversation (no conversationId) answered "NIGHTHAWK-384272" — expected NIGHTHAWK-384272 |
| MEMORY-DELETE — A deleted memory is no longer recalled | PASS | 0 | deleted 1 memory item(s) holding the codename; 0 remain |
| RAG-INGEST — Upload a document; it is parsed, chunked and embedded | PASS | 2.1 | document 4f0c1a18… reached "ready" (scan: skipped_no_scanner) |
| RAG-ANSWER — A grounded answer, with a real citation | PASS | 18 | grounded=true outcome=grounded; "An engineer receives 27 days of paid leave per calendar year. [1]"; 1 source(s), the handbook's excerpt cited: true |
| RAG-REFUSAL — No evidence, no answer — and a refusal is never called grounded | PASS | 4.9 | grounded=false outcome=refused; "The provided documents do not contain the answer to this question." |
| IMAGE — Generate a 512×512 image of a red apple on a wooden table | PASS | 352.8 | stable-diffusion.cpp in 352.8 s: image/png, 369699 bytes, 512×512; luminance stddev 75.9, 420 distinct colours, red-dominant pixels 3% |
| AUDIO — Synthesise speech and play it back | PASS | 6.1 | piper in 6.1 s: audio/wav, 130860 bytes, 16000 Hz, 4.09 s, RMS 0.142 (0 = silence) |
| VIDEO — Prompt → script → storyboard → narration → subtitles → visuals → MP4 | PASS | 486.9 | succeeded in 486.9 s: 2 scene(s), 2 narrated, storyboard model; MP4 385243 bytes, 8.0 s, streams [video:h264, audio:aac, subtitle:mov_text]; WebVTT valid |
| CODING-AGENT — The agent fixes the SOURCE so the test passes, and the fix is verified independently | PASS | 246.2 | task COMPLETED in 246.1 s; source changed: true; test file untouched: true; independent run: ok (exit 0) |
| MCP — A tool served by a real MCP server runs inside an agent task, in this project only | PASS | 12.6 | task COMPLETED: reference-filesystem (stdio) read "The keeper's code word is lantern-904."; the model answered "lantern-904" (expected lantern-904); a path outside the workspace: refused |
| USAGE — Tokens spent are metered | PASS | 0 | this project spent 18682 tokens today across the calls above (scope organization) |
| QUOTA — A request over a configured limit is refused before any work, and says why | PASS | 0 | limit 60 s/month, 8 s used; asked for 56 s -> 429 QUOTA_EXCEEDED: "Monthly video-seconds limit of 60 would be exceeded (8s used so far this month)."; video projects before/after: 1/1 |
| AUDIT — The project's audit trail records what happened in it | PASS | 0 | 10 entries, all in this project: true; actions: tool.call.mcp, tool.call, project.create |
| TENANT-ISOLATION — Another tenant cannot read this one's data | PASS | 1 | victim's conversation, document and workspace file -> 404, 404, 404; the intruder's own workspace has no sum.js -> 404 |
| METRICS — Prometheus metrics carry real values | PASS | 0.6 | API 200, http://127.0.0.1:9464/metrics 200; summed: http_requests_total 606, provider_request_count 25, token_usage_total 18966, generation_total 6, job_processed_total 9, tool_call_count 9 |
| PERSISTENCE — Log out, log back in: everything is still there | PASS | 0.6 | after a fresh login: 3 conversation(s) in the project; the handbook -> 200 |
| RATE-LIMIT — A route's limit is enforced and says when to retry | PASS | 1.4 | 429 RATE_LIMITED; retry-after 59 s; limit 30 |
