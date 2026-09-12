import { defineConfig } from "vitest/config";

// Every other package in this monorepo relies on vitest's own default test-file
// discovery, which is safe because none of them have a runtime data directory. backend
// does (./data/sandbox, .../coding-demo/math.test.js — a real fixture the coding-agent
// tests write to and run against, not a vitest test) — found the hard way when vitest's
// default glob picked it up as an actual test file and failed on its `process.exit(0)`.
// Scoping `include` to real source test files avoids ever touching `./data` again.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
