# Browser acceptance

- Web: `http://127.0.0.1:3011`
- Started: 2026-09-28T04:34:24.138Z
- **7 PASS · 1 FAIL · 3 BLOCKED_EXTERNAL in 75 s**

| Check | Status | Seconds | Observed |
|---|---|---|---|
| SIGNUP — Sign up in the browser | PASS | 1.2 | signed up browser-1790570064555@example.com, landed on /chat |
| CHAT-STREAMING — The answer is rendered progressively, not all at once | PASS | 22.2 | 80 distinct rendered lengths while streaming (1, 3, 12, 18, 21, 27…397); header "ChatAnswers come from local (qwen2.5:7b)."; answer 397 chars |
| CHAT-MULTI-TURN — A second message continues the same conversation, and survives a reload | PASS | 15.7 | 4 messages before reload, 4 after, same URL: true |
| CHAT-CANCEL — Stop ends the stream, and the next message still works | PASS | 8.9 | stopped at 6 chars, 6 three seconds later; Send back: true; next answer "ready" |
| MEMORY-UI — A memory filed on the Memory screen is used by a new conversation | PASS | 7.8 | filed "teal-337" on /memory; a new chat answered "teal-337" |
| RAG-UI — Upload a document, ask, see the cited passage; an unanswerable question is refused | PASS | 9.3 | answered with "22:00", source shown: true; unanswerable question refused: "Your documents do not answer this question. The passages bel" |
| IMAGE-UI — Generate an image and see the browser decode it | BLOCKED_EXTERNAL | 0 | BROWSER_SKIP_MEDIA=1 |
| AUDIO-UI — Generate speech and let the browser load and measure it | BLOCKED_EXTERNAL | 0 | BROWSER_SKIP_MEDIA=1 |
| VIDEO-UI — Generate a short video and let the browser load it, with its subtitle track | BLOCKED_EXTERNAL | 0 | BROWSER_SKIP_MEDIA=1 |
| ROUTES — Every screen renders without a browser error | PASS | 8.2 | 12 screens, no browser errors, no placeholders |
| LOGOUT-LOGIN — Sign out, sign back in, and the conversations are still there | FAIL | 1.3 | 4 conversation(s) listed after signing back in; but the browser logged: 401 GET /api/v1/conversations \| 401 GET /api/v1/models \| Failed to load resource: the server responded with a status of 401 (Unauthorized) \| Failed to load resource: the server responded with a status of 401 (Unauthorized) |
