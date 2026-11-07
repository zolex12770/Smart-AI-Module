import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Authoritative workspace test accounting.
 *
 * Every npm workspace is inventoried, including packages that intentionally have no test script.
 * A timed-out Vitest process is never reported as a passing zero-test workspace. Completed test
 * summaries contribute to the aggregate; incomplete workspaces remain explicit in the JSON report.
 */
const ROOT = process.cwd();
const OUT = join(ROOT, "test-accounting");
const TIMEOUT_MS = 900_000;
mkdirSync(OUT, { recursive: true });

const workspaceDirs = [
  "backend/packages/agent-core",
  "backend/packages/database",
  "backend/packages/embeddings",
  "backend/packages/jobs",
  "backend/packages/mcp",
  "backend/packages/media",
  "backend/packages/memory",
  "backend/packages/model-router",
  "backend/packages/observability",
  "backend/packages/quota",
  "backend/packages/rag",
  "backend/packages/scanning",
  "backend/packages/security",
  "backend/packages/tools",
  "shared",
  "frontend",
  "backend",
];

const providersRoot = join(ROOT, "backend/packages/providers");
if (existsSync(providersRoot)) {
  const { readdirSync } = await import("node:fs");
  for (const name of readdirSync(providersRoot).sort()) {
    const dir = `backend/packages/providers/${name}`;
    if (existsSync(join(ROOT, dir, "package.json"))) workspaceDirs.push(dir);
  }
}

const workspaces = workspaceDirs.map((dir) => {
  const manifestPath = join(ROOT, dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return { dir, name: manifest.name ?? dir, hasTestScript: typeof manifest.scripts?.test === "string" };
});

const startedAt = new Date().toISOString();
console.log(`Starting authoritative accounting across ${workspaces.length} workspaces...`);
console.log(`Per-workspace timeout: ${TIMEOUT_MS / 1000}s`);

const results = [];
const aggregate = {
  discoveredWorkspaces: workspaces.length,
  testWorkspaces: workspaces.filter((ws) => ws.hasTestScript).length,
  notApplicableWorkspaces: 0,
  passedWorkspaces: 0,
  failedWorkspaces: 0,
  timedOutWorkspaces: 0,
  errorWorkspaces: 0,
  testFiles: 0,
  tests: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
};

for (const ws of workspaces) {
  const slug = ws.dir.replaceAll("/", "__");
  const logPath = join(OUT, `${slug}.log`);
  const workspaceStartedAt = new Date().toISOString();
  process.stdout.write(`Running ${ws.name.padEnd(38)} ... `);

  if (!ws.hasTestScript) {
    aggregate.notApplicableWorkspaces++;
    const result = {
      ...ws,
      status: "NOT_APPLICABLE",
      reason: "workspace has no test script",
      startedAt: workspaceStartedAt,
      finishedAt: new Date().toISOString(),
      durationSeconds: "0.0",
      logPath: null,
      files: null,
      total: null,
      passed: null,
      failed: null,
      skipped: null,
    };
    results.push(result);
    console.log("NOT_APPLICABLE (no test script)");
    continue;
  }

  const startedMs = Date.now();
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npx";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npx vitest run"] : ["vitest", "run"];
  const run = spawnSync(command, args, {
    cwd: join(ROOT, ws.dir),
    env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  const finishedAt = new Date().toISOString();
  const durationSeconds = ((Date.now() - startedMs) / 1000).toFixed(1);
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  writeFileSync(logPath, `$ ${command} ${args.join(" ")}\n\n${output}`);

  const fileMatches = [...output.matchAll(/Test Files\s+([^\r\n]+)/g)];
  const testMatches = [...output.matchAll(/Tests\s+([^\r\n]+)/g)];
  const fileSummary = fileMatches.at(-1)?.[1] ?? "";
  const testSummary = testMatches.at(-1)?.[1] ?? "";
  const files = parseSummary(fileSummary);
  const tests = parseSummary(testSummary);
  const timedOut = run.error?.code === "ETIMEDOUT" || run.signal === "SIGTERM";
  const status = timedOut ? "TIMEOUT" : run.error ? "ERROR" : run.status === 0 ? "PASS" : "FAIL";

  if (status === "PASS") aggregate.passedWorkspaces++;
  else if (status === "FAIL") aggregate.failedWorkspaces++;
  else if (status === "TIMEOUT") aggregate.timedOutWorkspaces++;
  else if (status === "ERROR") aggregate.errorWorkspaces++;
  if (status === "PASS" && tests.total !== null) {
    aggregate.testFiles += files.total ?? 0;
    aggregate.tests += tests.total ?? 0;
    aggregate.passed += tests.passed ?? 0;
    aggregate.failed += tests.failed ?? 0;
    aggregate.skipped += tests.skipped ?? 0;
  }

  const result = {
    ...ws,
    status,
    exitCode: run.status,
    signal: run.signal,
    error: run.error ? String(run.error.message ?? run.error) : null,
    startedAt: workspaceStartedAt,
    finishedAt,
    durationSeconds,
    logPath: logPath.replace(`${ROOT}\\`, "").replaceAll("\\", "/"),
    files: files.total,
    total: tests.total,
    passed: tests.passed,
    failed: tests.failed,
    skipped: tests.skipped,
  };
  results.push(result);
  console.log(`${status} [${format(files.total)} files, ${format(tests.passed)} pass, ${format(tests.skipped)} skip, ${format(tests.failed)} fail] in ${durationSeconds}s`);
}

const finishedAt = new Date().toISOString();
const report = {
  startedAt,
  finishedAt,
  timeoutMs: TIMEOUT_MS,
  command: "node scripts/reconcile-test-accounting.mjs",
  aggregate,
  results,
};
writeFileSync(join(ROOT, "test-accounting.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log("\n========================================================================");
console.log("AUTHORITATIVE MONOREPO TEST ACCOUNTING SUMMARY");
console.log("========================================================================");
console.log(`Workspaces:       ${aggregate.discoveredWorkspaces} discovered / ${aggregate.testWorkspaces} test / ${aggregate.notApplicableWorkspaces} not applicable`);
console.log(`Workspace status: ${aggregate.passedWorkspaces} pass · ${aggregate.failedWorkspaces} fail · ${aggregate.timedOutWorkspaces} timeout · ${aggregate.errorWorkspaces} error`);
console.log(`Test Files:       ${aggregate.testFiles}`);
console.log(`Unique Tests:     ${aggregate.tests}`);
console.log(`Passed:           ${aggregate.passed}`);
console.log(`Skipped:          ${aggregate.skipped}`);
console.log(`Failed:           ${aggregate.failed}`);
console.log(`Artifact:         test-accounting.json`);
console.log("========================================================================");

process.exitCode = aggregate.failedWorkspaces || aggregate.timedOutWorkspaces || aggregate.errorWorkspaces ? 1 : 0;

function parseSummary(line) {
  const total = line.match(/\((\d+)\)/)?.[1];
  return {
    total: total === undefined ? null : Number(total),
    passed: numberBefore(line, "passed"),
    failed: numberBefore(line, "failed"),
    skipped: numberBefore(line, "skipped"),
  };
}

function numberBefore(line, word) {
  const match = line.match(new RegExp(`(\\d+)\\s+${word}`));
  return match ? Number(match[1]) : 0;
}

function format(value) {
  return value === null ? "n/a" : String(value);
}
