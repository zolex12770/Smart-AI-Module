# Runtime security checks

- API: `http://127.0.0.1:8787`
- Started: 2026-09-30T11:35:57.418Z
- **9 PASS · 2 FAIL · 0 BLOCKED_EXTERNAL in 5 s**

| Check | Status | Observed |
|---|---|---|
| UNAUTHENTICATED — Every route docs/API.md does not mark public answers 401 without a session | FAIL | POST /api/v1/rag/query → 429 |
| CSRF — A session cookie without the double-submit header cannot write | PASS | missing token 403, wrong token 403 |
| TENANT-IDOR — A second tenant gets 404 for the first tenant's resources, by id and by project header | PASS | 6 cross-tenant probes, every one 404; nothing changed |
| API-KEY-SCOPE — A key for one project cannot act in another, and cannot manage the account | PASS | own project 200; other project 403; account and invitation routes 403 |
| PATH-TRAVERSAL — Workspace paths cannot escape the project's directory | PASS | 4 escapes refused on write (400) and read; a backslash path is stored as one literal filename inside the workspace (POSIX) |
| UPLOAD-VALIDATION — Uploads are allow-listed and sniffed, not trusted by name or header | PASS | executable, disguised HTML and SVG all refused with 400 |
| MALFORMED-INPUT — Oversized bodies, bad JSON and hostile ids fail cleanly (4xx, never 5xx) | PASS | 413 for 8 MiB, 400 for bad JSON, no 5xx for hostile ids |
| CHAT-OVERRIDES — A caller cannot pick the model or buy an unbounded answer | PASS | model override 400; oversized maxOutputTokens 400 |
| ENUMERATION — Neither login nor inviting a member reveals whether an address is registered | PASS | same answer for unknown and wrong password; same answer for any invitee; nobody joins without accepting |
| RESPONSE-HEADERS — Uploaded documents are served as downloads, and responses forbid sniffing | PASS | nosniff set; uploaded documents download as attachments under a generated name |
| RAG-INJECTION — Instructions inside an uploaded document are not followed | FAIL | rag/query → 429: {"error":{"code":"RATE_LIMITED","message":"Rate limit exceeded, retry in 2 seconds.","requestId":"2597fd09-74bb-446d-8f80-c6d78c85b063"}} |
