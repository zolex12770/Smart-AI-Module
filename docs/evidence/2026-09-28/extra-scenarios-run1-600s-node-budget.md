# Extra scenarios

- API: `http://127.0.0.1:8787`
- Started: 2026-09-28T08:01:21.704Z
- **2 PASS · 1 FAIL · 1 BLOCKED_EXTERNAL in 1205 s**

| Check | Status | Seconds | Observed |
|---|---|---|---|
| CODING-SECOND — A second, unrelated coding task: the source is fixed and the test passes, verified here | FAIL | 602 | task FAILED; independent run: exit 1: node:assert:150; test untouched: true |
| CODING-BAD-PATCH — Where a naive patch is wrong, the task's verdict agrees with the test, and the test is not edited | PASS | 602 | task FAILED; independent run: exit 1: node:assert:150; verdict agrees with the test: true; test untouched: true; reason: Node "399dca74-3b7a-4647-ab1a-68d897d77643" exceeded its 600000ms timeout. |
| IMAGE-NEGATIVE — Invalid image requests are refused before anything is queued | PASS | 0 | 5 invalid requests, each 400; no generation created |
| IMAGE-REPRODUCIBLE — The same prompt and seed give the same image, byte for byte; another seed gives another | BLOCKED_EXTERNAL | 0 | no real image provider configured |

## Notes added after the run

- **IMAGE-REPRODUCIBLE's `BLOCKED_EXTERNAL` was wrong.** The stack had SDXL through
  stable-diffusion.cpp. The script read `body.image` where the API answers
  `body.providers.image`. The script is fixed, and it now fails (not blocks) on a mock provider.
  See the second run.
- **Both coding tasks were stopped by the planner's 10-minute node deadline.** The compose stack
  did not pass `AGENT_NODE_TIMEOUT_MS` through, although docs/ENVIRONMENT.md recommends 30 minutes
  for a 7B model on CPU. The audit trail of CODING-SECOND shows 9 model turns (about 5 output
  tokens/s): an attempt to edit the test, which was refused, then two wrong edits to `slugify.js`.
  Its FAIL stands as the result under the old budget (DL-20).
