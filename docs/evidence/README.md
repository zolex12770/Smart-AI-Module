# Evidence

Artifacts from real runs on 2026-09-27, kept so the claims in
[FINAL_PRODUCTION_READINESS_REPORT.md](../FINAL_PRODUCTION_READINESS_REPORT.md) can be checked
without re-running them. The machine had 4 CPU cores, 16 GB of RAM and no GPU. The models were
Ollama `qwen2.5:7b` and `nomic-embed-text`, stable-diffusion.cpp running SDXL base 1.0 (q8_0),
and Piper `en_US-lessac-low`.

| File | What it is |
|---|---|
| `acceptance-dev-run1-2026-09-27.md` | `scripts/acceptance/full-system.mjs` against the dev backend, first run: 19 PASS, 3 FAIL. The FAILs were CHAT-HISTORY (a defect in the check), VIDEO (storyboard fallback, so no narration) and CODING-AGENT (the model gave up in prose). Each led to a fix. |
| `acceptance-dev-run2-2026-09-27.md` / `.json` | The second run after those fixes: VIDEO and CHAT-HISTORY PASS. MEMORY-FORMATION/RECALL FAIL (the model mis-copied one digit of the codename, which led to the grounding filter) and CODING-AGENT FAIL (text-written tool calls and wrong indentation, which led to recovery and clearer errors). |
| `acceptance-compose-2026-09-27.md` / `.json` | The same script against the Docker Compose stack: postgres/pgvector, ollama, api, worker and web as separate containers, with SDXL through the sd.cpp overlay. **23 PASS · 1 FAIL**; METRICS failed because the worker's counters were unreachable, which led to `METRICS_PORT` |
| `acceptance-compose-metrics-rerun-2026-09-27.md` | After that fix, METRICS and its prerequisites re-run on the rebuilt stack: **7 PASS · 0 FAIL**, summing the API and the worker's `/metrics` |
| `compose-chat-2026-09-27.jpg` | A real browser (Chromium) that signed up, chatted and reloaded through the compose web container. The answer is `qwen2.5:7b`'s, and the header names that model (it used to say "mock by default", which was false). The only failed request was the expected pre-login 401 on `/auth/me` |
| `latency-compose-2026-09-27.md` / `.json` | `scripts/acceptance/latency.mjs` against the compose stack: measured p50/p95/max, no targets |
| `coding-agent-probes-2026-09-27.log` | Three `fix_failing_test` runs on the current build against a real project, each checked independently. All three COMPLETED (211 s, 381 s, 326 s), the test file unchanged, and an independent re-run of the test exits 0 |
| `image-red-apple-sdxl-2026-09-27.jpg` | The IMAGE check's PNG, re-encoded as JPEG: SDXL, 512×512, 12 steps, CFG 6 |
| `video-bees-frame-2026-09-27.jpg` | A frame at 1.5 s of the VIDEO check's MP4 (run 2). The caption was burned in from the MP4's own subtitle track when the frame was extracted; the MP4 carries it as a soft `mov_text` track. SDXL at 512×512 and 12 steps is far below its native 1024 px, which is why the image is stylised. |
| `video-bees-ffprobe-2026-09-27.json` | `ffprobe` of that MP4: h264 video, AAC audio, mov_text subtitles, 8.0 s |
| `coding-agent-run-2026-09-27.log` | A successful real coding-agent run (earlier build): 9 tool calls, one refused edit to the read-only test, `sum.js` fixed with `code.replace_text`, the test file unchanged, an independent re-run of the test exiting 0 |
