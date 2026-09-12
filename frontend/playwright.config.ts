import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration — docs/26_DECISIONS.md ADR-068.
 *
 * These drive a real browser against a real API and a real database, which is the only level
 * at which the claims that matter can be checked: that a signed-out visitor cannot see
 * anything, that signing up works, and that one tenant's browser cannot reach another's data.
 *
 * `PLAYWRIGHT_CHROMIUM_PATH` exists because a machine may have a cached Chromium that does not
 * match the version this Playwright release would download. Pointing at it is better than
 * failing to run E2E at all.
 */
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  /**
   * Both applications, started for real. The web app is built and served rather than run in
   * dev mode so that what is tested is what would be deployed; the API runs against its own
   * throwaway database directory so an E2E run never touches development data.
   *
   * `start:e2e` REBUILDS the web app rather than reusing whatever build happens to be on disk.
   * That is not wasted work: `NEXT_PUBLIC_API_URL` is inlined by Next at build time, so a build
   * made without it points the browser at the development port, and every test then fails with
   * an opaque "Could not reach the server" that says nothing about the real cause. Found the
   * hard way after an unrelated rebuild. Making the suite build what it runs is what stops the
   * result from depending on who last ran `npm run build` and with which environment.
   */
  /**
   * Both servers are ALWAYS started fresh — ADR-105.
   *
   * This was `reuseExistingServer: !process.env.CI`, a real local convenience that turned out
   * to be a gate defect: a backend left listening on 8790 by an earlier session was silently
   * reused, so a full E2E run exercised code from before the day's changes. Six of seven tests
   * failed against a contract that no longer existed, and the diagnosis cost more than every
   * boot the reuse had ever saved.
   *
   * The failure direction that matters is the other one. A stale server can just as easily
   * PASS — reporting green for code that is not the code under test — and an E2E suite exists
   * precisely to be the thing that cannot be fooled that way.
   */
  webServer: [
    {
      command: "npm run start:e2e --workspace=@ai-platform/api",
      url: "http://127.0.0.1:8790/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run start:e2e --workspace=@ai-platform/web",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
