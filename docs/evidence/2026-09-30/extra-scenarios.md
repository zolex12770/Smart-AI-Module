# Extra scenarios

- API: `http://127.0.0.1:8787`
- Started: 2026-09-30T11:53:33.126Z
- **3 PASS · 1 FAIL · 0 BLOCKED_EXTERNAL in 3847 s**

| Check | Status | Seconds | Observed |
|---|---|---|---|
| CODING-SECOND — A second, unrelated coding task: the source is fixed and the test passes, verified here | FAIL | 1801 | task FAILED; independent run: exit 1: node:assert:150; test untouched: true |
| CODING-BAD-PATCH — Where a naive patch is wrong, the task's verdict agrees with the test, and the test is not edited | PASS | 923 | task FAILED; independent run: exit 1: node:assert:150; verdict agrees with the test: true; test untouched: true; reason: The agent stopped after 12 turns (max_iterations) without reaching an answer. |
| IMAGE-NEGATIVE — Invalid image requests are refused before anything is queued | PASS | 0 | 5 invalid requests, each 400; no generation created |
| IMAGE-REPRODUCIBLE — The same prompt and seed give the same image, byte for byte; another seed gives another | PASS | 1122 | seed 4242 twice → identical sha256 f7c2c1b99b51dc98… (290724 bytes, 512×512); seed 777 → 86e4b93435d2821a… |

## CODING-SECOND: a model-quality limitation, not a platform bug

The audit log of the task, which ran from 11:54 to 12:24:
- The model ran the test once.
- It then sent eight diffs against `slugify.cjs`, a file that does not exist. Each was refused
  with "Cannot patch "slugify.cjs": "slugify.cjs" does not exist. Files in ".": slugify.js,
  slugify.test.cjs."
- It twice tried to edit the read-only test, and was refused both times.
- It never read `slugify.js`.

At 1800 s the node deadline ended the task, reported `FAILED`. The test file was untouched, and an
independent run of the test agreed (exit 1).

This is the fourth run of this task with qwen2.5:7b on CPU, and none has completed it. Runs 1 and
2 exposed platform defects (DL-20, DL-21) that are fixed; runs 3 and 4 are the model's own
errors. The platform was not changed to make a wrong edit look successful.
