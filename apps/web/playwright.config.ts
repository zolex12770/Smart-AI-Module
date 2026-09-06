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
  webServer: [
    {
      command: "npm run start:e2e --workspace=@ai-platform/api",
      url: "http://127.0.0.1:8790/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run start:e2e --workspace=@ai-platform/web",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
