import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Frontend test configuration — docs/26_DECISIONS.md ADR-068.
 *
 * The ADR-047 audit's largest single coverage gap was that `frontend` had no test script at
 * all: no component tests, no hook tests, nothing. Every claim about the UI rested on a
 * one-off manual browser session recorded in prose.
 *
 * jsdom rather than a real browser here, deliberately: these cover component logic, hooks and
 * the API client contract, which is where the bugs the audit found actually live (an
 * unhandled rejection in the chat submit path, a client SSE parser that only accepts LF).
 * Real-browser behaviour is the E2E suite's job.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["app/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    // E2E lives in its own runner; including it here would try to drive Playwright in jsdom.
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**"],
  },
});
