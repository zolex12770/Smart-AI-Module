# Security

What is actually implemented, what it protects against, and what it does not. Every claim below
corresponds to code and, where stated, to a test that runs in `npm test`. Nothing here has been
verified in a deployment; there has been none.

Design intent lives in [13_SECURITY_ARCHITECTURE.md](13_SECURITY_ARCHITECTURE.md); this
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
| Brute force | Failed-login counter with temporary lockout, shared by login and by the password re-check before account deletion (ADR-108); signup and login carry tighter per-route rate limits than the global default. Those limits are per IP, so they depend on `TRUST_PROXY_HOPS` (§9). |
| Revocation | Logout revokes the session immediately; `revokeAllSessions` exists for password change and administrative use; revoking an API key takes effect on the next request. |

**Tested** — `backend/packages/security/src/{password,auth-service}.test.ts`: the hash never contains the
password, salting produces different hashes for the same input, a malformed hash returns `false`
rather than throwing, wrong-password and unknown-email errors are byte-identical, lockout engages,
a revoked session and a revoked/expired API key both stop authenticating, wrong re-authentication
passwords count toward the lockout, and a locked account refuses even the correct one.

**Nothing is reachable without a credential, and that is now enforced rather than assumed**
(ADR-097). The auth plugin refuses any request to a matched route outside the four public paths
that presented no valid credential. Before this, `publicPaths` was passed to the plugin and never
read: the property rested entirely on all 53 routes remembering their own guard. They all did —
which is why nothing noticed — but a route that forgets is now closed anyway.

**An account can be deleted, with its data** (ADR-102, NFR-008; corrected by ADR-107, ADR-108 and
ADR-109). `DELETE /api/v1/auth/account` requires an interactive session, the current password and a
typed confirmation.

- **Session only.** A request authenticated by an API key is refused with 403 before the password
  is looked at. This document said "requires the session" before that was true: an API key plus the
  password deleted the account, because `requireUser` accepts any credential and a bearer request
  is exempt from CSRF (third audit, finding #27).
- **The password re-check is a password check like any other.** A wrong password counts toward the
  account lockout and writes a denied `auth.reauth` audit row; a locked account is refused even with
  the correct password. The first version did neither, and leaned on a rate limit keyed on a
  client-written `X-Forwarded-For` (#3).
- **5 attempts per 15 minutes per authenticated user.** The limit is keyed on the user and evaluated
  after authentication, so it holds however the client's address is derived.
- **Decided per project** (ADR-109). The organizations considered are every one the caller reaches
  through an organization membership or a project membership. An organization with another
  organization member is kept whole. Otherwise each project is judged on its own: one another user
  is a member of is kept, every other one is deleted with its content, and the organization goes if
  nothing in it is kept. The caller's memberships in whatever survives are removed. The earlier
  versions kept a private project nobody else could reach whenever any other project in its
  organization had a collaborator (#2), and kept an organization after its last collaborator
  deleted their own account too (#32).
- **After the database commits**, the deleted projects' storage objects and agent workspaces
  (`SANDBOX_ROOT/<projectId>`) are removed and their queued jobs cancelled. Anything that could not
  be removed or cancelled is reported in the response rather than swallowed. Before ADR-109 the
  workspaces stayed on disk while the route reported 200 (#1).
- **The erasure record** is written only after the deletion succeeds, with a null `user_id` (the
  former id is kept in `detail`), a SHA-256 of the email address instead of the address, and no IP
  address. The person's older audit rows are
  scrubbed (§8).

**Tested** — `backend/src/routes/v1/account-deletion.test.ts`: an API key gets 403 and the user still
exists; seven wrong passwords, each with a different `X-Forwarded-For`, get 401 five times and then
429; a file the agent wrote is gone from disk; a queued job is cancelled.
`backend/packages/security/src/account-deletion.test.ts`: a private project is deleted even when
another project in the organization has a collaborator, the last collaborator's deletion removes the
organization, and no audit row the person left keeps their IP or email.

## 2. Authorization and multi-tenancy

The hierarchy is **User → Organization → Project → Resource**.

The rule the whole model rests on: **authorization is a SQL predicate, not a post-fetch check.**
Every content table carries `project_id`, and every repository read filters on it in the `WHERE`.
There is deliberately no `get(id)` left to call — the signature is `get(projectId, id)` — so the
ownership check a route might forget cannot be forgotten.

- **Membership is the only way into a project** (ADR-108). A caller reaches a project through a role
  in its organization or a role on the project, and through nothing else. The system administrator
  has no implicit tenant access: that flag gates `/api/v1/admin/*`, `POST /api/v1/tools/:id/enable`
  and `POST /api/v1/mcp/:id/reconnect`, and no project. Until ADR-108, `authorizeProject`
  short-circuited on `isSystemAdmin` into owner+admin on every project in every organization — read
  any tenant's data, spend its quota, mint API keys for its projects — while the documentation
  described the flag as gating the administrator surface only (third audit, #38).
- A project the caller cannot reach returns **404, not 403**: confirming that an id exists is itself
  a disclosure.
- API keys are bound to exactly one project. The one 403 for a project the caller cannot reach is an
  API key naming a project other than its own — in the path, query, body or `x-project-id`. It is
  refused in `requireProject` before any lookup, so an existing and a non-existent foreign id get
  the same answer. `docs/API.md` said "404, never 403" until ADR-112 corrected its generator (#41).
- Roles: organization `owner`/`admin`/`member`; project `admin`/`editor`/`viewer`. Permissions are
  a static table in `shared/src/auth.ts`, so the whole policy is readable in one place.
  A `viewer` cannot spend money — no `chat:write`, `agent:run` or `media:generate`.
- Approval actors come from the authenticated session, never from the request body. (Previously
  `approvedBy` was a client-supplied string, so the audit trail recorded who *claimed* to approve.)
- Assets are no longer readable by knowing a UUID; `GET /api/v1/assets/:id` authenticates and
  resolves the asset within the caller's project.

**Tested** — cross-tenant reads return 404, a viewer is refused `chat:write`, another project's
API key cannot be revoked (and still works afterwards, proving the failed attempt had no effect),
an organization owner reaches a project they are not an explicit member of, and a system
administrator can neither authorize into another tenant's project nor create a project in another
tenant's organization, while still reaching its own.

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
- **An approval covers one call, not a call id** (ADR-108). The engine used to remember approved
  calls by id, but adapters synthesise ids that repeat every turn (`gemini-call-1`, `call_0`), so one
  human approval let a later, different destructive call carrying a recycled id skip the gate
  (third audit, #33). The id set is gone: the approved call runs from the parked transcript, and
  every other call goes through the approval gate. `backend/packages/agent-core/src/autonomous.test.ts` asserts that
  a later turn reusing the approved call's id for a different call parks again.
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

**Network egress is its own permission level.** `web.fetch` is registered as `network`, not
`read_only` — a tool that can reach the network can reach the network the deployment is on, and
describing that as read-only would understate it where an operator looks. See the SSRF note
below for what the guard does and does not cover.

**`web.fetch` is bounded in time and CPU, and its refusals disclose nothing** (ADR-108). Each of these
was a third-audit finding and each is asserted in `backend/packages/tools/src/native/web.test.ts`, most against a
real local server:

- A hostname that resolves to a private address and one that does not resolve at all get the
  identical refusal, naming no address. The refusal used to name the private address, and an
  unresolvable name surfaced the raw `ENOTFOUND` — an internal DNS map for a prompt-injected model
  (#5). A literal address written in the URL can still be echoed back; the caller wrote it.
- One total deadline spans DNS, every redirect hop and the body. Before it, the only bound was the
  socket `timeout`, an idle timer, which a server sending a byte at a time resets forever (#6).
- Cancellation reaches the socket. The invocation's abort signal, fired when a task is cancelled or a
  node passes its deadline, destroys the request and its response (#14).
- A redirect's body is destroyed, not drained. Draining downloaded 7 GB in six seconds, outside the
  byte cap, after the tool had already returned (#10).
- HTML is stripped in one linear forward pass. The regex version was quadratic: 64 KB of `<` took
  1.4 s, which at the 512 KB cap is about 90 s of synchronous work on the API's event loop, for
  every tenant (#31). 512 KB hostile inputs are now asserted to finish in under 2 s.

- **No fake output in production.** Mock LLM, image and video providers are registered only when
  `ALLOW_MOCK_PROVIDERS=true`, which configuration refuses under `NODE_ENV=production`; without a
  real provider a capability answers `CAPABILITY_UNAVAILABLE`. Tested in
  `backend/src/no-fake-in-production.test.ts`.
- **The coding agent cannot edit the test it is asked to make pass.** The task's test file is a
  `readOnlyPaths` entry: every file-writing tool refuses it (`ReadOnlyPathError`), and the engine
  restores it from a snapshot before each test run in case a terminal command changed it.

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
- The CI workflow runs gitleaks over the full history on every run (green on GitHub Actions since
  run 36311897333). Three findings are listed by fingerprint in `.gitleaksignore`, each a
  non-secret (a cache key and test fixtures), with the reason beside it.

## 8. Audit

An `audit_log` records the authenticated principal, the action, the outcome
(`success`/`denied`/`failure`), the credential type, IP (§9 says whose address that is) and request
id. **Denials are recorded, not just grants** — a permission refusal writes a row naming the
permission that was refused. Application code never deletes a row; the one update it makes is the
erasure scrub below.

**Account deletion scrubs the person from the trail** (ADR-109). Inside the deletion transaction,
every row naming the user has `ip_address` cleared and `email` removed from `detail`, and so does
every denied-login row that recorded their address with no user id. Before this, the `set null` on
`user_id` cleared the id and nothing else: every login IP, and the email on every denied login,
survived beside a code comment claiming no personal data remained (third audit, #7). The erasure
record itself holds a SHA-256 of the address and no IP, so "was the account for this address
deleted, and when" is answered by hashing the address, without that record being the row that
keeps it.

## 9. Transport and headers

`@fastify/helmet` supplies security headers (the audit found none at all). CORS is restricted to a
configured origin with credentials enabled.

**`request.ip` trusts exactly `TRUST_PROXY_HOPS` proxies** (ADR-112). It feeds every per-IP rate
limit and the IP address an audit row records. The default, 0, trusts no `X-Forwarded-For` entry and uses the socket's
address, which is right for a process nothing sits in front of; N skips exactly the N entries the
deployment's own proxies appended. Terraform sets 1 for Cloud Run, whose front end appends the
caller's address (an external HTTPS load balancer in front would make it 2). **That value has not
been verified against a live Cloud Run service** — there is no GCP project here.

Before ADR-112 the server ran `trustProxy: true`, under which Fastify takes the LEFTMOST
`X-Forwarded-For` entry — the one the client writes. Any caller could choose its address and rotate
it per request, so no per-IP limit (signup, login, generation) bound anyone, and every audit row
recorded whatever address a caller claimed. This section used to say `trustProxy` made per-IP rate
limiting correct behind a proxy; it did the opposite. `backend/src/trust-proxy.test.ts` asserts the
address a failed login's audit row records at 0, 1 and 2 hops.

---

## What is NOT protected — read this before deploying

- **The first-administrator bootstrap is not mutually exclusive across replicas.** Its
  empty-table check is a plain SELECT under READ COMMITTED, so two replicas booting at the same
  instant with DIFFERENT `BOOTSTRAP_ADMIN_EMAIL` values could both create an administrator (the
  same email collides on a unique index). It can never promote anyone on a database that already
  has committed users, which is what makes the variables inert after first boot. An earlier comment
  claimed stronger; it was wrong and has been corrected. Set the bootstrap variables on one replica.
- **The rate limiter fails open.** Counters are shared across instances via Postgres (ADR-071), so
  N instances enforce one limit rather than N — but if the database is unreachable the request is
  allowed and the error is logged. That is deliberate and opposite to the malware scanner's
  fail-closed rule (ADR-042): a scanner that cannot scan must not certify a file clean, whereas a
  limiter that cannot count would turn a database blip into a total outage. Nothing in the
  authorization model rests on rate limiting; it is a mitigation, not a boundary.
- **Process isolation is not container isolation.** The development sandbox shares the host's
  network and filesystem. Production refuses it by default for exactly this reason, but an operator
  who sets `SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true` has accepted a real risk.
- **Docker isolation is verified in a real container, but the compose stack does not use it.**
  `npm test` asserts the argument list `dockerRunArgs` builds; the real-container suite
  (`sandbox.docker.test.ts`, `npm run test:docker --workspace=@ai-platform/security`) observes each
  property from inside a real container — no network, read-only root, dropped capabilities, the
  single writable workspace — and passes 4/4 locally (Docker 29) and in CI. It fails, rather than
  skips, without Docker. The API container in `docker-compose.yml` is given no Docker socket
  (mounting one would hand the model's commands the host), so that stack runs the coding agent
  under the process sandbox with `SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true`, inside the API
  container's own filesystem. A deployment that wants container isolation for agent commands
  needs a runtime designed for it (a rootless or remote Docker endpoint, or gVisor).
- **Per-IP limits are only as good as `TRUST_PROXY_HOPS` matching the topology.** Set too low behind
  a proxy, every client shares the proxy's one address and one bucket; set higher than the number
  of proxies really in front, a client-written `X-Forwarded-For` entry is trusted again, which is the
  bypass ADR-112 closed. Configuration checks only that it is an integer from 0 to 10; it cannot
  know the deployment. Terraform's 1 for Cloud Run is unverified live. The account-deletion limit is
  keyed per user and does not depend on it.
- **Work already running when an account is deleted cannot be stopped.** Queued jobs for the deleted
  projects are cancelled; a job that has already started carries on. When it writes its output, the
  row insert fails at the foreign key to the deleted project and both asset stores remove the bytes
  they wrote, so no file is left behind — but whatever that job already did, including any provider
  call, has happened.
- **No SSO/OIDC, no MFA, no password reset flow, no email verification.** Sessions and API keys
  only.
- **SSRF is guarded, not eliminated.** `web.fetch` (ADR-104) exists now, so the protections it
  used to be exempt from are implemented: http(s) only, every resolved address checked against the
  private/loopback/link-local/carrier-NAT/multicast/reserved ranges in both IP families (including
  the `::ffff:` mapped, SIIT-translated, NAT64, 6to4 and Teredo forms, and site-local), the socket
  pinned to the validated address so DNS
  rebinding cannot redirect it, redirects followed by hand with every hop revalidated, and a byte
  cap. Verified by refusing `169.254.169.254`, `localhost` (via `::1`), `10.0.0.1` and `file://`
  against a live process. What remains: a host on a public address that PROXIES to a private one
  is indistinguishable from any other public host, and `WEB_FETCH_ALLOWLIST` is the answer for a
  deployment that needs certainty rather than a heuristic.
- **`web.fetch` is an exfiltration channel for a prompt-injected agent, and the SSRF guard does
  not address that.** The guard decides which HOST may be contacted; the data leaves in the URL.
  An agent that has read untrusted content and been persuaded by it can put anything it can see
  into a query string and fetch a host that is perfectly public. This is a direct consequence of
  giving an agent network egress and is named here rather than implied by the section above:
  before ADR-104 the worst outcome of prompt injection was a wrong answer, and now it is a
  disclosure. The mitigation that actually works is `WEB_FETCH_ALLOWLIST` — a deployment that
  handles anything sensitive should set it to the hosts it genuinely needs, which turns the
  channel off for every other destination. Egress is also not metered or quota-counted per
  project, so it is not visible in the usage ledger the way a model call is.
- **Prompt injection is mitigated, not solved.** Untrusted content is structurally delimited and
  carries a trust-boundary system message; provenance tracking is not implemented, so a tool call
  that *results from* untrusted content is not automatically escalated for approval.
- **The malware scanner has only been run against a one-signature EICAR database**, never the
  official signature set, and never as a Cloud Run sidecar.
- **Six moderate dependency advisories are accepted, with reasons.** `npm audit` reports six and
  `npm audit --audit-level=high` exits 0. Four are one chain — `esbuild` <=0.24.2 via
  `@esbuild-kit/*` via `drizzle-kit` — and `npm ls esbuild --omit=dev` is EMPTY, so that chain is
  not in any production dependency path; the advisory itself concerns a running esbuild dev
  server, which nothing here starts. The other two are `gaxios` and its transitive `uuid` <11.1.1,
  reached only through `@google-cloud/storage`; the advisory is a missing buffer bounds check in
  uuid v3/v5/v6 when a buffer is supplied, which that path does not do. This repository's own
  `uuid` is 11.1.1. `npm audit fix` resolves none of them without `--force`, which would move
  `drizzle-kit` across a major version — a migration tool is the wrong place to take an unforced
  breaking change, so they are accepted and recorded here instead of silently carried.
- **Terraform grants `allUsers` invoker on the API service.** That is now an authenticated API, so
  it is no longer an open door — but it is still a public endpoint and should be reviewed against
  your own exposure requirements before `terraform apply`.

## Reporting

This is a single-tenant self-hosted platform with no vendor. Treat findings as you would for any
self-hosted service you operate.
