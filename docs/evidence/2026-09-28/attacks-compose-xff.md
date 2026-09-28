# Runtime security checks

- API: `http://127.0.0.1:8787`
- Started: 2026-09-28T06:08:45.177Z
- **1 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL in 5 s**

| Check | Status | Observed |
|---|---|---|
| XFF-SPOOF — A caller cannot dodge the login limit by inventing X-Forwarded-For | PASS | refused with 429 after 11 attempts, each with a different forged address |
