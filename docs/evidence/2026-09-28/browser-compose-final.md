# Browser acceptance

- Web: `http://localhost:3000`
- Started: 2026-09-28T13:01:40.818Z
- **11 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL in 916 s**

| Check | Status | Seconds | Observed |
|---|---|---|---|
| SIGNUP — Sign up in the browser | PASS | 1.8 | signed up browser-1790600501294@example.com, landed on /chat |
| CHAT-STREAMING — The answer is rendered progressively, not all at once | PASS | 20.9 | 78 distinct rendered lengths while streaming (1, 3, 12, 18, 20, 25…393); header "ChatAnswers come from local (qwen2.5:7b)."; answer 393 chars |
| CHAT-MULTI-TURN — A second message continues the same conversation, and survives a reload | PASS | 15.3 | 4 messages before reload, 4 after, same URL: true |
| CHAT-CANCEL — Stop ends the stream, and the next message still works | PASS | 9.4 | stopped at 12 chars, 12 three seconds later; Send back: true; next answer "ready" |
| MEMORY-UI — A memory filed on the Memory screen is used by a new conversation | PASS | 7.2 | filed "teal-599" on /memory; a new chat answered "teal-599" |
| RAG-UI — Upload a document, ask, see the cited passage; an unanswerable question is refused | PASS | 11.9 | answered with "22:00", source shown: true; unanswerable question refused: "Your documents do not answer this question. The passages bel" |
| IMAGE-UI — Generate an image and see the browser decode it | PASS | 344.2 | the browser decoded the generated image: 512×512; download links: 1 |
| AUDIO-UI — Generate speech and let the browser load and measure it | PASS | 4.6 | the browser loaded the audio: 3.18 s |
| VIDEO-UI — Generate a short video and let the browser load it, with its subtitle track | PASS | 490.8 | the browser decoded the render (video/webm; codecs="vp9, opus"; its H.264 support: ""): 8.0 s, 640px wide, 1 subtitle track(s); 2 narration player(s) |
| ROUTES — Every screen renders without a browser error | PASS | 8.4 | 12 screens, no browser errors, no placeholders |
| LOGOUT-LOGIN — Sign out, sign back in, and the conversations are still there | PASS | 0.8 | 4 conversation(s) listed after signing back in |
