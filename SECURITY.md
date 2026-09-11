# Security

What is actually implemented, what it protects against, and what it does not. Every claim below
corresponds to code and, where stated, to a test that runs in `npm test`.

Design intent lives in [docs/13_SECURITY_ARCHITECTURE.md](docs/13_SECURITY_ARCHITECTURE.md); this
file describes the **implementation**, and says plainly where the two diverge.

---

## 1. Authentication

| Control | Implementation |
|---|---|
| Password storage | scrypt (RFC 7914) from Node's own crypto, `N=2^17, r=8, p=1`. Parameters are encoded in the hash, so the cost can be raised without invalidating existing hashes; a weaker hash is upgraded on next successful login. |
| Session storage | 256-bit CSPRNG token; the database stores **only** a SHA-256. A database dump cannot be replayed as live sessions. |
| Session transport | `httpOnly` cookie (JavaScript cannot read it, so an XSS bug cannot exfiltrate it), `SameSite=Lax`, `Secure` in production. |
| API keys | 256-bit token prefixed `aip_`; only a SHA-256 is stored. The plaintext is returned exactly once, at creation. A non-secret prefix is kept so a user can identify a key in a list. |
| Enumeration resistance | A wrong password and an unknown email return the **same** error and do comparable work (a decoy hash is verified when no account exists). |
| Brute force | Failed-login counter with temporary lockout; signup and login carry tighter per-route rate limits than the global default. |
| Revocation | Logout revokes the session immediately; `revokeAllSessions` exists for password change and administrative use; revoking an API key takes effect on the next request. |

**Tested** — `packages/security/src/{password,auth-service}.test.ts`: the hash never contains the
password, salting produces different hashes for the same input, a malformed hash returns `false`
rather than throwing, wrong-password and unknown-email errors are byte-identical, lockout engages,
a revoked session and a revoked/expired API key both stop authenticating.

## 2. Authorization and multi-tenancy

The hierarchy is **User → Organization → Project → Resource**.

The rule the whole model rests on: **authorization is a SQL predicate, not a post-fetch check.**
Every content table carries `project_id`, and every repository read filters on it in the `WHERE`.
There is deliberately no `get(id)` left to call — the signature is `get(projectId, id)` — so the
ownership check a route might forget cannot be forgotten.

- A project the caller cannot see returns **404, not 403**: confirming that an id exists is itself
  a disclosure.
- API keys are bound to exactly one project and are refused if used against another.
- Roles: organization `owner`/`admin`/`member`; project `admin`/`editor`/`viewer`. Permissions are
  a static table in `packages/shared/src/auth.ts`, so the whole policy is readable in one place.
  A `viewer` cannot spend money — no `chat:write`, `agent:run` or `media:generate`.
- Approval actors come from the authenticated session, never from the request body. (Previously
  `approvedBy` was a client-supplied string, so the audit trail recorded who *claimed* to approve.)
- Assets are no longer readable by knowing a UUID; `GET /api/v1/assets/:id` authenticates and
  resolves the asset within the caller's project.

**Tested** — cross-tenant reads return 404, a viewer is refused `chat:write`, another project's
API key cannot be revoked (and still works afterwards, proving the failed attempt had no effect),
and an organization owner reaches a project they are not an explicit member of.

## 3. CSRF

Cookie-authenticated **mutating** requests require a double-submit token: a non-`httpOnly` `aip_csrf`
cookie echoed in an `x-csrf-token` header. A cross-site attacker can cause the cookie to be sent but
cannot read it to set the header.

Bearer-token requests are exempt by design — a token is not attached automatically by the browser,
so it is not forgeable cross-site.

## 4. Execution isolation

The agent executes commands a **model** chose, which is the highest-risk surface in the platform.

| Control | `DockerSandbox` (production) | `ProcessSandbox` (development) |
|---|---|---|
| Network | `--network none` | shares the host's |
| Filesystem | read-only root, tmpfs `/tmp`, workspace bind-mount only | workspace path containment only |
| Privileges | `--cap-drop ALL`, `no-new-privileges`, non-root user | host user |
| Resources | `--pids-limit`, `-m`, `--cpus` | output cap only |
| Environment | scrubbed | scrubbed |
| Timeout | real process-tree kill | real process-tree kill |

Production **refuses to start** with process isolation unless `SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true`,
and only for a process that actually runs the agent engine — a worker pool that executes no
model-chosen commands does not carry that risk.

**Two real vulnerabilities fixed here**, both found by audit and both now asserted by tests that run
real processes: the child used to inherit the API process's **entire environment** (every provider
key, `DATABASE_URL`), and the "timeout" only rejected a promise while the child kept running.

## 5. Tool safety

- Arguments are validated against the tool's declared `inputSchema` **before** the handler runs.
  This matters far more now that a model chooses them.
- All four approval modes are distinct: `never`, `first_use` (real per-project history),
  `always`, `risk_threshold` (a real, configurable risk level).
- Re-registering a tool id is refused, so one server cannot silently replace another's tool — or
  re-enable one an operator disabled.
- MCP-discovered tools register **disabled**; enabling one is an explicit, authenticated,
  permission-checked action. Verified live on a running platform: 14 discovered tools, 0 enabled,
  against 8 native tools all enabled.
- **A remote (HTTP) MCP server is untrusted third-party code supplying tool DEFINITIONS** — a
  materially different position from a local subprocess an operator launched (ADR-083). An id
  collision is refused rather than resolved, so a server cannot rename its tool to `fs.write_file`
  and impersonate a native one; the refused ids are reported on `/api/v1/mcp` so an operator can
  see what a server tried to claim. Disconnecting a server now really UNREGISTERS its tools —
  previously they were only disabled, which also meant reconnect had never worked.
- Plaintext `http` to a non-loopback MCP server carrying credential headers is refused. The first
  implementation of that check used `/^127\./`, which matched `127.0.0.1.attacker.tld` — an
  ordinary DNS name pointing anywhere — and sent the bearer token in clear. Caught in review; the
  host is now parsed as a real IPv4 literal, pinned by a regression test.

## 6. Input handling

- Zod validation on every request body.
- Uploads: extension allow-list, declared-MIME check, **content sniffing** (a `.pdf` must carry
  `%PDF-`; a `.docx` must be a real ZIP containing `word/document.xml`), a hard 25 MiB cap enforced
  by the multipart parser (a real 413, never a silent truncation), and rename-on-upload so the
  stored object is keyed by a generated id.
- Malware scanning via a real clamd `INSTREAM` client. An upload is held in `scanning` and is
  neither ingested nor served until it clears; an infected verdict deletes the bytes and the row.
  A scan that *could not run* is never reported as clean. Fail-open locally (durably marked
  `skipped_no_scanner`), fail-closed with `UPLOAD_SCAN_REQUIRED=true`.
- Path containment resolves symlinks (`realpath`) before the prefix check, and rejects a sibling
  directory that merely shares the root's prefix.
- The terminal tool uses an argument array with `shell: false` and an allow-list; a real historical
  `--eval=` argument-injection exploit is pinned by a regression test.
- **Every model-authored command runs through `ExecutionSandbox`, not a bare `spawn`** (ADR-077).
  This was not true until it was fixed: the tool called `spawn` with no `env`, and Node hands a
  child the parent's entire `process.env` — so a command a model wrote could print every provider
  key and the database URL, which a probe against that code path demonstrated. The defect was that
  TWO execution paths existed and the tool registry was wired to the unhardened one. A regression
  test now dumps the child's whole environment and asserts no canary appears anywhere in it.

## 7. Secrets

- No secret is logged: the structured logger redacts key-shaped fields at any depth (tested,
  including a negative case so ordinary fields are not over-redacted).
- `.env` files are loaded natively; a real environment variable always wins over a file value, and
  nothing is loaded under `NODE_ENV=test`.
- Child processes receive only the variables they are explicitly given — built from scratch
  (`PATH`, plus the few Windows loader variables), never filtered from the parent's, because an
  allow-list of names to strip has to be updated for every new secret and the one nobody
  remembers is the one that leaks. See the terminal-tool note in §6: this sentence was in this
  document before it was true of the path that actually ran.
- CI runs gitleaks, and every commit in this repository was preceded by a staged-diff secret scan.

## 8. Audit

An append-only `audit_log` records the authenticated principal, the action, the outcome
(`success`/`denied`/`failure`), the credential type, IP and request id. **Denials are recorded, not
just grants** — a permission refusal writes a row naming the permission that was refused.

## 9. Transport and headers

`@fastify/helmet` supplies security headers (the audit found none at all). CORS is restricted to a
configured origin with credentials enabled. `trustProxy` is set so per-IP rate limiting is correct
behind a proxy.

---

## What is NOT protected — read this before deploying

- **The rate limiter fails open.** Counters are shared across instances via Postgres (ADR-071), so
  N instances enforce one limit rather than N — but if the database is unreachable the request is
  allowed and the error is logged. That is deliberate and opposite to the malware scanner's
  fail-closed rule (ADR-042): a scanner that cannot scan must not certify a file clean, whereas a
  limiter that cannot count would turn a database blip into a total outage. Nothing in the
  authorization model rests on rate limiting; it is a mitigation, not a boundary.
- **Process isolation is not container isolation.** The development sandbox shares the host's
  network and filesystem. Production refuses it by default for exactly this reason, but an operator
  who sets `SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true` has accepted a real risk.
- **The Docker sandbox has never been exercised in this environment** — no Docker installation
  exists here. Its flags are reviewed and correct, and the code path is selected and refused
  correctly, but a real container run is unverified.
- **No SSO/OIDC, no MFA, no password reset flow, no email verification.** Sessions and API keys
  only.
- **No SSRF protections**, because no tool fetches a URL. Adding one requires adding them.
- **Prompt injection is mitigated, not solved.** Untrusted content is structurally delimited and
  carries a trust-boundary system message; provenance tracking is not implemented, so a tool call
  that *results from* untrusted content is not automatically escalated for approval.
- **The malware scanner has only been run against a one-signature EICAR database**, never the
  official signature set, and never as a Cloud Run sidecar.
- **Terraform grants `allUsers` invoker on the API service.** That is now an authenticated API, so
  it is no longer an open door — but it is still a public endpoint and should be reviewed against
  your own exposure requirements before `terraform apply`.

## Reporting

This is a single-tenant self-hosted platform with no vendor. Treat findings as you would for any
self-hosted service you operate.
