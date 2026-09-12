import { defineConfig } from "vitest/config";

/**
 * Shared test timeouts — docs/26_DECISIONS.md ADR-100.
 *
 * Vitest's defaults are 5s per test and 10s per hook. Those are sized for unit tests against
 * fakes, and almost nothing in this repository is that: a typical `beforeEach` here creates an
 * embedded PGlite Postgres and runs every migration against it, and several suites spawn real
 * subprocesses (MCP servers over stdio, sandboxed commands, ffmpeg).
 *
 * On an idle machine that fits inside the defaults, which is why it looked fine. Under load it
 * does not, and two independent audit runs — each with a dozen agents competing for the same
 * cores — hit it: `npm test`, the literal CI gate, exited non-zero with between 1 and 8 failures,
 * every one of them `Hook timed out in 10000ms` or `Test timed out in 5000ms`, with a *variable*
 * count run to run. A hook timeout then cascades into a second spurious failure in `afterEach`
 * (`Cannot read properties of undefined (reading '$client')`), because the fixture it was meant
 * to close never finished being built.
 *
 * Re-running one of those files with a raised hook timeout passed 10/10 in 23.55s. So the product
 * code was fine and the GATE was broken — which is the worse of the two, because a gate that goes
 * red on a busy runner teaches everyone to ignore it. CI runs on a shared runner by definition.
 *
 * These are ceilings for a machine under contention, not budgets to grow into. A genuinely hung
 * test still fails, just later; the alternative — leaving the defaults and accepting a suite that
 * passes only when nothing else is running — is not a suite anyone can trust.
 */
export const TEST_TIMEOUTS = {
  testTimeout: 30_000,
  hookTimeout: 60_000,
} as const;

export default defineConfig({ test: { ...TEST_TIMEOUTS } });
