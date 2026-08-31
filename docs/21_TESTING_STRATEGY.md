# 21. Testing Strategy

This document defines the testing strategy for the platform across the test pyramid, with special
attention to the parts that are unusual for an AI agent platform: testing agent planning/tool-
selection quality, testing provider adapters and their retry/fallback behavior, and — the
centerpiece — a **mock provider architecture that guarantees CI never calls a paid LLM/image/video
API**, ever, by construction rather than by convention.

## 1. Recommended toolchain (Node.js/TypeScript)

| Layer | Tool | Why |
|---|---|---|
| Unit / integration test runner | **Vitest** | Native ESM and TypeScript support with no transform-step overhead (unlike Jest, which needs `ts-jest`/Babel), Jest-compatible API (low switching cost), and materially faster suite runtimes — the 2026 default recommendation for new Node/TS projects. Use `vi.mock`/`vi.fn` for mocking. |
| Ephemeral infra for integration tests | **Testcontainers** (`testcontainers` + `@testcontainers/postgresql`, `@testcontainers/redis` npm packages) | Spins up real, disposable Postgres/Redis containers per test run so integration tests run against the same engine/version as production instead of an in-memory fake with different semantics (transaction behavior, SQL dialect quirks, Redis command behavior). Requires Docker — see §9 for the current local-dev gap this creates. |
| API/HTTP-level tests | **Supertest** (or Vitest + native `fetch` against an ephemeral server instance) | Exercise Express/Fastify routes as black-box HTTP without a browser. |
| Contract/schema tests | **Zod schema assertions** reused from runtime validation code | The same Zod schemas that validate requests/tool-call arguments at runtime double as the source of truth for test assertions — one schema, not two definitions to keep in sync. |
| E2E / browser tests | **Playwright** | Auto-waiting locators (`getByRole`, `getByTestId`), first-class TypeScript support, reliable network mocking/interception (needed to keep even E2E tests off real provider APIs — see §8), and built-in trace/video capture on failure for debugging flaky runs. |
| Load/perf smoke (lightweight) | **k6** (deferred until there's a performance baseline to protect) | Not a day-one requirement; note as a later addition once real traffic patterns exist. |

Sources: Vitest's 2026 positioning vs. Jest (native ESM/TS support, 3-5x typical speedup,
Jest-API-compatible) — see general 2026 framework comparisons such as
https://reintech.io/blog/jest-vs-jest-2026-testing-framework-comparison and
https://testdino.com/blog/javascript-testing-frameworks; Testcontainers for Node.js —
https://testcontainers.com/guides/getting-started-with-testcontainers-for-nodejs/; Playwright 2026
best practices (fresh browser context per test, semantic locators, retrying assertions, preserved
failure traces) — https://qaskills.sh/blog/playwright-e2e-best-practices.

## 2. Test pyramid for this platform

```
                        ▲
                       /E2E\            Playwright — a handful of critical user journeys
                      /------\
                     /Frontend\         Component tests (Vitest + Testing Library)
                    /----------\
                   / Agent-loop \       Planning/tool-selection quality, against mock providers
                  /--------------\
                 /  API / Contract \    Supertest against a running app instance
                /--------------------\
               /  Integration (DB/Q)  \ Testcontainers: Postgres, Redis, queue
              /--------------------------\
             /     Unit (pure logic)      \ Vitest — the largest layer by test count
            /--------------------------------\
```

Guiding rule: **push tests as far down the pyramid as they can go without losing what they're
testing.** Agent planning quality genuinely needs an agent-loop test (mid-pyramid); token counting
math does not — it's a unit test.

### 2.1 Unit tests

Scope: pure functions and isolated modules with no I/O — prompt-template construction, token
counting/cost estimation math (`20_OBSERVABILITY.md` §1.3), tool-call argument schema validation,
retry/backoff calculation, permission-tier classification logic (`13_SECURITY_ARCHITECTURE.md`
§7), path-traversal/SSRF allow-list checks, and the pricing table itself. These are fast,
deterministic, and should make up the bulk of the suite by test count.

### 2.2 Integration tests (database, cache, queue)

Scope: anything that talks to Postgres, Redis, or the job queue. Use **Testcontainers** to run a
real Postgres and Redis per test-suite run (started once in a `beforeAll`, torn down in
`afterAll`, to amortize the ~5-30s container-startup cost across all tests in a file rather than
paying it per test). Run real migrations against the ephemeral container before tests execute, so
schema drift between test and production is caught immediately. Cover: repository/query-layer
correctness, row-level tenant-isolation enforcement (a security-relevant test — verify a query
scoped to org A genuinely cannot read org B's rows even if application code has a bug), and
transaction/rollback behavior for multi-step writes (e.g., recording a tool call and its cost
atomically).

### 2.3 API tests

Scope: HTTP-level behavior of the API service — status codes, auth/permission enforcement (a
request without the right role gets 403, not partial data), input validation error shapes, rate
limiting behavior (assert a 429 with correct headers after exceeding a configured limit in a test
environment with a low limit), and pagination/filtering contracts. Run against an in-process app
instance (no separate deploy needed) using Supertest, backed by the Testcontainers Postgres/Redis
from §2.2.

### 2.4 Database tests

Covered primarily under §2.2, but called out separately for: migration up/down correctness (every
migration must be reversible or explicitly documented as non-reversible with a reason), constraint
enforcement (foreign keys, unique constraints, check constraints actually reject the invalid data
they claim to), and `pgvector` similarity-search correctness for the RAG pipeline (known embeddings
in, expected nearest-neighbor ranking out).

### 2.5 Agent-loop tests (planning/tool-selection quality, without paid APIs)

This is the category unique to an agent platform and the one most likely to be neglected because
it doesn't map cleanly onto a conventional test type. The goal is to verify the **agent loop's
control logic** — does it pick a reasonable tool for a given situation, does it stop when it
should, does it correctly hand off to a fallback provider, does it correctly gate a Tier-2 action
behind human approval — **without asserting on exact model output text**, which is non-deterministic
even from real providers and doubly not the point of these tests.

Design pattern:

1. **Scenario-based tests against the mock provider (§3)**, where the mock is configured with a
   *scripted* sequence of model responses (a fixture) that simulates a specific situation: "model
   requests a Tier-2 tool call," "model's tool call has invalid arguments," "model loops past the
   step limit without producing a final answer," "model requests a tool that isn't in its bound
   tool set for this task." The test then asserts on the **agent loop's behavior**, not the model's
   wording: was the approval gate triggered, was the loop terminated at the step ceiling, was the
   invalid tool call rejected and re-prompted rather than executed, etc.
2. **Do not try to test "is the plan good" via exact-match assertions on natural language.** Where
   genuine output-quality evaluation is wanted (e.g., "does the agent choose search-then-summarize
   over summarize-then-search for this query"), treat it as a separate **eval suite** (LLM-as-judge
   or rubric-scored, run against a real provider on a schedule, e.g. nightly) that is explicitly
   *not* part of the CI gate that blocks merges — it's slower, costs money, and has inherent
   variance, so it belongs in a monitoring/regression-tracking role, not a pass/fail CI check.
3. **Golden-path regression fixtures**: record a small library of realistic multi-step scenarios
   (as mock-provider fixtures) covering the tool types the platform ships, and run them on every
   CI build. These catch control-flow regressions (e.g., a refactor that breaks the step-counter or
   the approval-gate wiring) cheaply and deterministically.

### 2.6 Provider adapter tests

Every provider adapter (chat/completions, image, video, embeddings — real and mock) implements the
same internal interface. Test each real adapter's **request/response mapping and error
normalization** against recorded fixtures of that provider's actual API shapes (captured once,
replayed thereafter — see §3's record-and-replay note) rather than live calls: does the adapter
correctly map a 429 from Provider X into the platform's normalized `RateLimitError`, does it
correctly parse streaming chunks, does it correctly compute token counts from that provider's
usage-reporting fields. Contract-test all adapters (real and mock) against one shared test suite
parametrized over the adapter interface, so a new provider adapter is only "done" when it passes
the same behavioral contract every other adapter does.

### 2.7 Queue / worker tests

Use Testcontainers for the underlying queue-supporting infra (Redis if the queue is Redis-backed;
otherwise a local emulator for the chosen queue technology). Cover: job retry/backoff behavior on
simulated worker failure, idempotency (processing the same job twice — e.g., after an at-least-once
redelivery — doesn't double-charge/double-execute a side effect), per-tenant concurrency limits
actually cap concurrent processing, dead-letter handling after exhausted retries, and — combined
with §2.6's fault injection — that a provider outage correctly triggers fallback rather than
endlessly retrying the same failing provider.

### 2.8 Security tests

A dedicated category (not left implicit inside other layers), directly exercising the controls in
`13_SECURITY_ARCHITECTURE.md`:

- **AuthZ tests**: every protected route/action tested for both "correct role succeeds" and "wrong
  role/tenant is rejected" — the negative case is the one that's easy to skip and most valuable.
- **Injection/traversal tests**: path-traversal payloads against any file-path-accepting endpoint;
  SSRF payloads (internal IPs, metadata-endpoint addresses, redirect chains to internal targets)
  against any URL-fetching tool, asserting rejection.
- **Prompt-injection regression tests**: a maintained fixture set of known injection patterns fed
  through the mock provider as "content the agent reads" (simulating a malicious web page/MCP
  response/RAG document), asserting the platform's provenance-tracking and human-approval-gate
  logic (`13_SECURITY_ARCHITECTURE.md` §9.2) fires as designed — again testing the *architectural
  control*, not asking a real model to resist injection (that's a red-team/eval activity, not a CI
  test).
- **File-upload tests**: reject-by-magic-bytes tests (a `.png`-renamed executable is rejected even
  though the extension/declared MIME type look fine), size-limit enforcement, and quarantine-flow
  tests.
- **Secret-leakage tests**: assert log output never contains values from an denylist of known
  secret-shaped test fixtures injected into a request, and that error responses returned to
  clients never leak stack traces/internal paths in production mode.
- **Dependency/SCA scanning**: run `npm audit`/a dedicated SCA tool (e.g., Snyk or GitHub's
  Dependabot alerts) in CI as a gating check, given supply-chain risk is explicitly called out for
  both the web-app (A08 Software/Data Integrity Failures) and agentic (ASI04 Agentic Supply Chain)
  OWASP lists referenced in `13_SECURITY_ARCHITECTURE.md`.

### 2.9 Frontend tests

- **Component tests**: Vitest + Testing Library for UI logic (does a component render the
  human-approval prompt when a Tier-2 action is pending, does the chat view correctly render
  streamed tokens incrementally) — mock the API layer, don't hit a real backend.
- **Visual/accessibility checks**: lightweight, not a heavy investment day one — basic axe-core
  accessibility assertions folded into existing component/E2E tests rather than a separate visual-
  regression pipeline, which can be added later if the UI surface grows enough to justify it.

### 2.10 End-to-end (E2E) tests

Playwright, covering the small number of genuinely critical user journeys end-to-end through a real
browser against a real running instance of the app: sign-up/login, starting a chat and receiving a
(mocked-provider) response, triggering a tool call that requires human approval and approving it,
and kicking off an image/video generation job and seeing it complete. Per current Playwright
guidance, give each test a fresh browser context, use semantic locators (`getByRole`/
`getByTestId`) instead of brittle CSS selectors, and always preserve traces/videos on failure for
debugging. **E2E tests still route through the mock providers (§3)**, not real ones — E2E means
"real browser, real app, real HTTP," not "real paid API calls." Keep this suite deliberately small;
it is the slowest and most maintenance-heavy layer, reserved for journeys where a regression would
be a serious, user-visible incident.

## 3. Mock provider architecture (the centerpiece: CI never calls a paid API)

### 3.1 Design goal

**No test — unit, integration, agent-loop, or E2E — should ever be capable of reaching a real,
billable LLM, image, or video provider API**, and this should be true by construction (the mock is
the only implementation wired up in the test environment) rather than by discipline (developers
remembering not to call the real one). A real-provider **eval suite** (§2.5 point 2) is the one
deliberate exception, and it is explicitly kept out of the CI merge-gate.

### 3.2 What a good mock provider looks like

1. **Same interface as real adapters.** The mock chat/image/video providers implement the exact
   same internal `ProviderAdapter` interface as the Vertex/OpenAI/Anthropic/real-image-provider
   adapters (§2.6). This is what makes provider-adapter contract tests and agent-loop tests
   meaningful — the rest of the system genuinely cannot tell it's talking to a mock except by
   configuration, which is the point.
2. **Deterministic, fixture-driven responses.** Responses are defined as versioned fixture files
   (JSON) keyed by scenario name or by a matcher against the incoming request (e.g., matching on a
   specific substring in the prompt, or an explicit `x-test-scenario` header/field the test sets),
   not randomly generated — a test must produce the same result every run. Maintain fixtures for:
   normal successful completions (chat, streaming chunks, image URLs, video job status
   transitions), tool-call-requesting responses (including multi-step sequences for agent-loop
   tests), malformed/schema-violating tool-call arguments (to test the platform's re-prompt/reject
   path), and refusal/safety-block responses.
2a. Where feasible, seed part of the fixture library via **record-and-replay**: capture a small
    number of real provider responses once (during manual/adapter-development testing, not in CI)
    and replay them verbatim as fixtures, so the mock's response *shapes* stay realistic and don't
    silently drift from what the real API actually returns. Pair this with an out-of-band (not
    CI-blocking) scheduled job that re-validates a subset of fixtures against the real API
    periodically, to catch upstream API-shape drift within days rather than discovering it in
    production.
3. **Configurable failure injection.** The mock must be able to simulate, on demand per test: HTTP
   429 (with and without a `Retry-After` header), 500/502/503, connection timeout, a response that
   arrives slower than the client's configured timeout, a truncated/malformed JSON body, and a
   stream that terminates mid-message. This is what makes retry/backoff and fallback-provider logic
   (§2.7) actually testable — real providers fail in these specific, well-known ways, and the
   retry logic is only as trustworthy as the failure modes it's been exercised against. This
   pattern (and its rationale — that untested retry logic can itself become expensive, e.g. by
   re-sending large contexts on every retry of a transient error) mirrors current community
   guidance on LLM mock tooling, e.g. the fixture-based failure-injection approach in
   https://github.com/CopilotKit/llmock and the broader practice described at
   https://agiflow.io/blog/mock-llm-server-setup.
4. **Realistic latency simulation.** The mock should support configurable artificial delay
   (including per-fixture overrides — e.g., "image generation takes 3-8 simulated seconds") so that
   timeout handling, loading-state UI, and streaming-consumer code are exercised against realistic
   timing rather than instant in-process resolution, which can hide bugs that only appear under
   real network latency (e.g., a UI race condition, or a timeout set too aggressively).
5. **Token/cost accounting parity.** The mock returns realistic, deterministic token-usage figures
   for its fixtures (not zero) so that cost-estimation, budget-cap enforcement, and the
   observability pipeline's cost fields (`20_OBSERVABILITY.md` §1.3) can be tested end-to-end
   without a real provider ever being involved.
6. **Explicit test-only guard.** The mock provider package/module is only importable/registered in
   `test`/`development` environment configuration; add a startup-time assertion in the provider
   registry that refuses to boot with a mock provider registered when `NODE_ENV=production`, as a
   hard backstop against a misconfiguration accidentally shipping the mock (or, inversely, against
   a test run accidentally picking up real provider credentials from a leaked `.env`).

### 3.3 Where mocks plug in across the pyramid

- **Unit tests**: don't even need the mock provider — they test logic below the provider-adapter
  boundary entirely.
- **Integration/API/agent-loop/E2E tests**: all configured to use the mock provider registry by
  default in the test environment.
- **Provider adapter tests (§2.6)**: the *real* adapters are tested, but against **recorded HTTP
  fixtures** of that specific provider's request/response shapes (using a library like `nock` or
  MSW to intercept the outbound HTTP call at the network layer) rather than the live API — this is
  different from the mock *provider* (which mocks at the internal adapter-interface level) and
  serves a different purpose: verifying the real adapter's HTTP-level parsing/error-mapping code is
  itself correct, still with zero live network calls or cost.
- **Nightly/scheduled eval suite only**: real provider calls, small controlled budget, not part of
  the PR-blocking CI pipeline, results tracked over time for quality regression rather than
  pass/fail per run.

## 4. CI pipeline shape

1. Lint + typecheck (fast fail).
2. Unit tests (Vitest) — no external dependencies, runs on every push.
3. Integration tests (Vitest + Testcontainers: Postgres, Redis) — runs on every push; requires
   Docker in the CI runner (standard on GitHub Actions/most CI providers by default, so this is a
   CI-environment non-issue even though it's a currently-missing piece of the local dev machine,
   per §9).
4. API tests (Supertest) — same job as integration, since they share the Testcontainers-backed
   app instance.
5. Agent-loop and provider-adapter tests (mock provider + recorded HTTP fixtures) — runs on every
   push; zero cost, zero flakiness from real network calls.
6. Security tests (§2.8) — runs on every push; treat as a merge-blocking gate, not advisory.
7. Frontend component tests — runs on every push.
8. E2E (Playwright) — runs on every push against a full local app instance (still mock providers);
   consider restricting to the smallest critical-path set on every push and a broader set on a
   merge-to-main/nightly cadence if suite time becomes a bottleneck.
9. (Separate, non-blocking, scheduled) Real-provider eval suite — nightly, small fixed budget,
   results posted to a dashboard/tracked over time, not a PR check.

## 5. Coverage philosophy

Do not chase a single global coverage percentage as a goal in itself. Instead:

- Require coverage on the control-flow-critical paths called out throughout this document
  specifically: permission-tier gating, the human-approval flow, retry/fallback logic, and
  tenant-isolation query scoping — these are the paths where a regression is a security or cost
  incident, not just a bug.
- Treat coverage tooling (Vitest's built-in `v8` coverage) as a signal for *finding untested
  branches* during development, not as a merge gate number to game.

## 6. Open items to revisit

- Choose and stand up the eval-suite tooling/dashboard for the nightly real-provider quality run
  once there's a real provider budget approved (ties to `18_CLOUD_ARCHITECTURE.md`'s "no budget
  yet" constraint — the eval suite is explicitly deferred until that exists, whereas everything
  else in this document works today with zero cloud spend).
- Revisit E2E suite scope/cadence once the frontend surface grows past the initial critical-path
  set.

## 7. Local-dev dependency this strategy relies on

Testcontainers-based integration/API/queue tests (§2.2, §2.3, §2.7) require a working container
runtime on the machine running them. **Docker Desktop is not currently installed on the
development machine** (noted also in `18_CLOUD_ARCHITECTURE.md` §6) — this is a setup gap to close
before those test layers can run locally, not an assumption this document makes. Until it's
installed:

- Unit tests, agent-loop tests, provider-adapter tests (mock-provider- and recorded-HTTP-fixture-
  based), frontend component tests, and lint/typecheck all run today with no Docker dependency —
  the large majority of the pyramid by test count is unaffected.
- Integration/API/queue tests that need a real Postgres/Redis can temporarily run against a
  manually-installed local Postgres/Redis (or free-tier hosted instances) as a stopgap, but this is
  explicitly a stopgap: it risks schema/behavior drift from the Testcontainers-based approach and
  should be replaced once Docker Desktop is installed.
- E2E (Playwright) tests need a running instance of the full app (API + DB); until Docker is
  available for the Postgres/Redis dependency, they can point at the same stopgap local database
  instances above.
- **Action item**: install Docker Desktop as a development-environment prerequisite before
  investing further in the integration/API/queue/E2E test layers — this document treats it as a
  near-term setup task, consistent with how `18_CLOUD_ARCHITECTURE.md` flags it.
