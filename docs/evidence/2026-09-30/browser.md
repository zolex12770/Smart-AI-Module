# Browser acceptance

- Web: `http://localhost:3000`
- Started: 2026-09-30T11:36:03.286Z
- **11 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL in 928 s**

| Check | Status | Seconds | Observed |
|---|---|---|---|
| SIGNUP — Sign up in the browser | PASS | 2.1 | signed up browser-1790768163665@example.com, landed on /chat |
| CHAT-STREAMING — The answer is rendered progressively, not all at once | PASS | 24.7 | 82 distinct rendered lengths while streaming (1, 3, 12, 18, 20, 25…419); header "ChatAnswers come from local (qwen2.5:7b)."; answer 419 chars |
| CHAT-MULTI-TURN — A second message continues the same conversation, and survives a reload | PASS | 17.2 | 4 messages before reload, 4 after, same URL: true |
| CHAT-CANCEL — Stop ends the stream, and the next message still works | PASS | 9.4 | stopped at 6 chars, 6 three seconds later; Send back: true; next answer "ready" |
| MEMORY-UI — A memory filed on the Memory screen is used by a new conversation | PASS | 7.8 | filed "teal-307" on /memory; a new chat answered "teal-307" |
| RAG-UI — Upload a document, ask, see the cited passage; an unanswerable question is refused | PASS | 11 | answered with "22:00", source shown: true; unanswerable question refused: "Your documents do not answer this question. The passages bel" |
| IMAGE-UI — Generate an image and see the browser decode it | PASS | 348.2 | the browser decoded the generated image: 512×512; download links: 1 |
| AUDIO-UI — Generate speech and let the browser load and measure it | PASS | 2.7 | the browser loaded the audio: 3.06 s |
| VIDEO-UI — Generate a short video and let the browser load it, with its subtitle track | PASS | 494.7 | the browser decoded the render (video/webm; codecs="vp9, opus"; its H.264 support: ""): 8.0 s, 640px wide, 1 subtitle track(s); 2 narration player(s) |
| ROUTES — Every screen renders without a browser error | PASS | 8.6 | 12 screens, no browser errors, no placeholders |
| LOGOUT-LOGIN — Sign out, sign back in, and the conversations are still there | PASS | 0.8 | 4 conversation(s) listed after signing back in |
