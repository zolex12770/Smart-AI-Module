# Extra scenarios

- API: `http://127.0.0.1:8787`
- Started: 2026-09-28T11:15:39.829Z
- **3 PASS · 1 FAIL · 0 BLOCKED_EXTERNAL in 2894 s**

| Check | Status | Seconds | Observed |
|---|---|---|---|
| CODING-SECOND — A second, unrelated coding task: the source is fixed and the test passes, verified here | FAIL | 672 | task FAILED; independent run: exit 1: /tmp/extra-coding-fHgBiR/slugify.js:6; test untouched: true |
| CODING-BAD-PATCH — Where a naive patch is wrong, the task's verdict agrees with the test, and the test is not edited | PASS | 1138 | task FAILED; independent run: exit 1: node:assert:150; verdict agrees with the test: true; test untouched: true; reason: The agent stopped after 12 turns (max_iterations) without reaching an answer. |
| IMAGE-NEGATIVE — Invalid image requests are refused before anything is queued | PASS | 0 | 5 invalid requests, each 400; no generation created |
| IMAGE-REPRODUCIBLE — The same prompt and seed give the same image, byte for byte; another seed gives another | PASS | 1082 | seed 4242 twice → identical sha256 f7c2c1b99b51dc98… (290724 bytes, 512×512); seed 777 → 86e4b93435d2821a… |

## Notes

This run used the API image built from `70b4229`, which has every fix from DL-19 to DL-22, and a
30-minute node budget.

- **CODING-SECOND FAIL is the model's own error; no platform defect.** The audit log shows:
  1. Its first edit replaced the closing `}` with `return value.toLowerCase();`
     (`code.replace_text` applied exactly what it was asked), which left `slugify.js` unparseable.
  2. Every later edit was refused correctly: an empty `oldText`, a `/dev/null` creation diff over
     the existing file, and hunks quoting a `}` that was no longer there.
  3. It stopped at the 12-turn limit.

  The task reported `FAILED`, the test file was untouched, and the independent run agreed.
- **Run history of CODING-SECOND:**
  - Run 1 stopped at the 10-minute node deadline (DL-20).
  - Run 2 exposed three platform defects (DL-21).
  - Run 3 is this one.

  No run completed the task. qwen2.5:7b on CPU completed `fix_failing_test` for `sum.js` (the
  acceptance check, 4 of 4 runs) but not this task.
- **CODING-BAD-PATCH PASS:** in run 2 and in this run, the verdict agreed with the test.
- **IMAGE-REPRODUCIBLE PASS:** SDXL through stable-diffusion.cpp in the worker container.
