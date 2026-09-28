#!/usr/bin/env node
/**
 * `npm run verify` — every release gate, one line each, PASS / FAIL / BLOCKED_EXTERNAL.
 *
 * Exit code: non-zero when any gate FAILs. BLOCKED_EXTERNAL does not fail the run (it names
 * something this machine cannot provide: a cloud account, a model runtime, a network registry),
 * unless VERIFY_STRICT=1, where it does. A gate is never reported PASS without having run.
 *
 * Gates:
 *   BUILD, TYPECHECK, LINT                  the workspace scripts
 *   UNIT                                    shared, frontend and every backend package
 *   INTEGRATION                             the backend application suite (real PGlite, pg-boss,
 *                                           Fastify inject, spawned processes), minus the contract
 *   API                                     the route-by-route contract test + docs/API.md drift
 *   SECURITY                                npm audit (high), secret scan of tracked files, the
 *                                           no-fake-in-production test
 *   E2E                                     Playwright against a real API (frontend/e2e)
 *   DATABASE                                migrations: empty DB, idempotent, no schema drift
 *   BOUNDARY                                frontend imports nothing from backend (7 rules)
 *   BOOT                                    the built entrypoint in every role and refusal
 *   REAL RUNTIME, MEDIA, AGENT, RAG,        scripts/acceptance/full-system.mjs against a running
 *   MEMORY, MCP                             stack (ACCEPT_API_URL, default http://127.0.0.1:8787)
 *   DOCKER                                  compose file valid + the real-container sandbox suite
 *                                           (+ both image builds with VERIFY_DOCKER_BUILD=1)
 *   TERRAFORM                               fmt -check, init -backend=false, validate
 *
 * Environment:
 *   VERIFY_ONLY=UNIT,LINT        run a subset (only those lines are printed)
 *   VERIFY_STRICT=1              BLOCKED_EXTERNAL also fails the run
 *   ACCEPT_API_URL, ACCEPT_ADMIN_EMAIL, ACCEPT_ADMIN_PASSWORD   the running stack, for the
 *                                runtime gates (see docs/TESTING.md)
 *   OLLAMA_URL                   where to look for a model runtime (default http://127.0.0.1:11434)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.VERIFY_OUT ?? join(ROOT, "verify-results");
const only = process.env.VERIFY_ONLY ? new Set(process.env.VERIFY_ONLY.split(",").map((s) => s.trim().toUpperCase())) : null;
const strict = process.env.VERIFY_STRICT === "1";
const API_URL = (process.env.ACCEPT_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
mkdirSync(OUT, { recursive: true });

const PASS = "PASS";
const FAIL = "FAIL";
const BLOCKED = "BLOCKED_EXTERNAL";
const results = [];

/** Runs a command, streaming nothing; the full output goes to verify-results/<gate>.log. */
function run(gate, command, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}), FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (err) => resolve({ code: 127, output: `${output}\n${err.message}`, seconds: 0 }));
    child.on("close", (code) => {
      const log = join(OUT, `${gate.toLowerCase().replace(/\s+/g, "-")}.log`);
      writeFileSync(log, `$ ${command} ${args.join(" ")}\n\n${output}`, { flag: "a" });
      resolve({ code: code ?? 1, output, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

const vitestSummary = (output) => {
  const lines = [...output.matchAll(/Tests\s+([^\n]+)/g)].map((m) => m[1].trim());
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const line of lines) {
    passed += Number(/(\d+) passed/.exec(line)?.[1] ?? 0);
    failed += Number(/(\d+) failed/.exec(line)?.[1] ?? 0);
    skipped += Number(/(\d+) skipped/.exec(line)?.[1] ?? 0);
  }
  return `${passed} passed, ${failed} failed, ${skipped} skipped`;
};

async function gate(name, fn) {
  if (only && !only.has(name)) return;
  const started = Date.now();
  let status = FAIL;
  let detail = "";
  try {
    ({ status, detail } = await fn());
  } catch (err) {
    status = FAIL;
    detail = `verify itself failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ gate: name, status, detail, seconds });
  process.stdout.write(`${name.padEnd(14)} ${status.padEnd(17)} ${detail} (${seconds}s)\n`);
}

const byExit = (res, detail) => ({ status: res.code === 0 ? PASS : FAIL, detail: res.code === 0 ? detail : `exit ${res.code} — see ${OUT}/` });

// --- static gates ---------------------------------------------------------------------------
await gate("BUILD", async () => byExit(await run("BUILD", "npm", ["run", "build"]), "all workspaces built"));
await gate("TYPECHECK", async () => byExit(await run("TYPECHECK", "npm", ["run", "typecheck"]), "0 errors"));
await gate("LINT", async () => {
  const res = await run("LINT", "npm", ["run", "lint"]);
  const summary = /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(res.output);
  return byExit(res, summary ? `${summary[2]} errors, ${summary[3]} warnings` : "clean");
});

// --- tests ----------------------------------------------------------------------------------
await gate("UNIT", async () => {
  // Every workspace with tests except the backend application, which is INTEGRATION below.
  const dirs = ["shared", "frontend"];
  for (const parent of ["backend/packages", "backend/packages/providers"]) {
    for (const name of readdirSync(join(ROOT, parent))) {
      const pkg = join(ROOT, parent, name, "package.json");
      if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).scripts?.test) dirs.push(`${parent}/${name}`);
    }
  }
  const res = await run("UNIT", "npm", ["run", "test", "--if-present", ...dirs.flatMap((d) => ["-w", d])]);
  return { status: res.code === 0 ? PASS : FAIL, detail: `${vitestSummary(res.output)} (${dirs.length} workspaces)` };
});
await gate("INTEGRATION", async () => {
  const res = await run("INTEGRATION", "npx", ["vitest", "run", "--exclude", "src/routes/api-contract.test.ts"], {
    cwd: join(ROOT, "backend"),
  });
  return { status: res.code === 0 ? PASS : FAIL, detail: vitestSummary(res.output) + " (backend application)" };
});
await gate("API", async () => {
  const contract = await run("API", "npx", ["vitest", "run", "src/routes/api-contract.test.ts"], { cwd: join(ROOT, "backend") });
  const docs = await run("API", "npm", ["run", "docs:api"]);
  const drift = await run("API", "git", ["diff", "--exit-code", "--", "docs/API.md"]);
  const routes = /generated: (\d+) routes/.exec(docs.output)?.[1];
  if (contract.code !== 0) return { status: FAIL, detail: `contract test failed: ${vitestSummary(contract.output)}` };
  if (docs.code !== 0) return { status: FAIL, detail: "docs/API.md could not be generated" };
  if (drift.code !== 0) return { status: FAIL, detail: "docs/API.md is out of date with the routes (run npm run docs:api)" };
  return { status: PASS, detail: `${routes ?? "?"} routes documented, each requested once; no drift` };
});

await gate("SECURITY", async () => {
  const parts = [];
  let failed = false;
  let blocked = false;
  const audit = await run("SECURITY", "npm", ["audit", "--audit-level=high", "--omit=dev"]);
  if (audit.code === 0) parts.push("npm audit: no high/critical");
  else if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network|audit endpoint returned an error/i.test(audit.output)) {
    blocked = true;
    parts.push("npm audit: registry unreachable");
  } else {
    failed = true;
    parts.push("npm audit: high/critical advisories");
  }
  // Secret scan of tracked files: the shapes of every credential this platform ever handles.
  const files = (await run("SECURITY", "git", ["ls-files"])).output.split("\n").filter(Boolean);
  const patterns = [
    /sk-ant-[A-Za-z0-9_-]{20,}/,
    /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/,
    /AIza[0-9A-Za-z_-]{35}/,
    /\baip_[A-Za-z0-9_-]{30,}/,
    // Assembled from parts so this file is not itself a match for a secret scanner.
    new RegExp(["-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE", "KEY-----"].join(" ")),
    /\bghp_[A-Za-z0-9]{36}\b/,
    /\br8_[A-Za-z0-9]{37}\b/,
  ];
  const hits = [];
  for (const file of files) {
    if (/\.(png|jpg|jpeg|gif|mp4|wav|webm|gguf|onnx|ico|woff2?)$/i.test(file) || file.includes("package-lock")) continue;
    let text;
    try {
      text = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const p of patterns) if (p.test(text)) hits.push(file);
  }
  if (hits.length) {
    failed = true;
    parts.push(`possible secrets in ${[...new Set(hits)].join(", ")}`);
  } else parts.push(`secret scan: ${files.length} tracked files clean`);
  const noFake = await run("SECURITY", "npx", ["vitest", "run", "src/no-fake-in-production.test.ts"], { cwd: join(ROOT, "backend") });
  if (noFake.code !== 0) {
    failed = true;
    parts.push("no-fake-in-production: FAILED");
  } else parts.push("no mock serves production");
  return { status: failed ? FAIL : blocked ? BLOCKED : PASS, detail: parts.join("; ") };
});

await gate("E2E", async () => {
  const res = await run("E2E", "npm", ["run", "test:e2e"]);
  const passed = /(\d+) passed/.exec(res.output)?.[1];
  const failedCount = /(\d+) failed/.exec(res.output)?.[1];
  return { status: res.code === 0 ? PASS : FAIL, detail: `Playwright: ${passed ?? 0} passed${failedCount ? `, ${failedCount} failed` : ""}` };
});
await gate("DATABASE", async () => byExit(await run("DATABASE", "bash", ["scripts/verify-migrations.sh"]), "migrations apply to an empty DB, re-apply cleanly, match the schema"));
await gate("BOUNDARY", async () => {
  const res = await run("BOUNDARY", "bash", ["scripts/verify-boundary.sh"]);
  const count = /(\d+)\/(\d+)/.exec(res.output.split("\n").reverse().find((l) => /\d+\/\d+/.test(l)) ?? "");
  return byExit(res, count ? `${count[0]} checks` : "frontend/backend boundary holds");
});
await gate("BOOT", async () => {
  const res = await run("BOOT", "bash", ["scripts/verify-boot.sh"]);
  const count = /(\d+)\/(\d+)/.exec(res.output.split("\n").reverse().find((l) => /\d+\/\d+/.test(l)) ?? "");
  return byExit(res, count ? `${count[0]} roles and refusals` : "every role boots");
});

// --- runtime gates: one acceptance run, six verdicts ------------------------------------------
const RUNTIME_GATES = {
  "REAL RUNTIME": ["PROVIDERS", "CHAT-STREAM", "CHAT-HISTORY", "USAGE", "TENANT-ISOLATION", "PERSISTENCE", "AUTH-SIGNUP", "AUTH-SESSION"],
  MEDIA: ["IMAGE", "AUDIO", "VIDEO"],
  AGENT: ["CODING-AGENT"],
  RAG: ["RAG-INGEST", "RAG-ANSWER", "RAG-REFUSAL"],
  MEMORY: ["MEMORY-FORMATION", "MEMORY-RECALL", "MEMORY-DELETE"],
  MCP: ["MCP"],
};
let acceptance = null;
const wantsRuntime = !only || Object.keys(RUNTIME_GATES).some((g) => only.has(g));
if (wantsRuntime) {
  const apiUp = await reachable(`${API_URL}/api/health`);
  const modelUp = await reachable(`${OLLAMA_URL}/api/tags`);
  if (apiUp) {
    const out = join(OUT, "acceptance");
    const resultFile = join(out, "full-system.json");
    // A previous run's results must never stand in for this one's (audit follow-up, DL-18): the
    // file is removed first, and what is read back must have started after this verify did.
    rmSync(resultFile, { force: true });
    const runStarted = Date.now();
    const res = await run("REAL RUNTIME", "node", ["scripts/acceptance/full-system.mjs"], {
      env: { ACCEPT_API_URL: API_URL, ACCEPT_OUT: out },
    });
    try {
      acceptance = JSON.parse(readFileSync(resultFile, "utf8"));
      if (!(Date.parse(acceptance.startedAt) >= runStarted - 1000)) {
        acceptance = { error: `the acceptance results predate this run (exit ${res.code})` };
      }
    } catch {
      acceptance = { error: `the acceptance run produced no results (exit ${res.code})` };
    }
  } else {
    acceptance = {
      unavailable: modelUp
        ? { status: FAIL, detail: `a model runtime is at ${OLLAMA_URL} but no API answers at ${API_URL}: start the stack (docker compose up -d, or cd backend && npm run dev)` }
        : { status: BLOCKED, detail: `no model runtime at ${OLLAMA_URL} and no API at ${API_URL}: this machine cannot run the real providers (docs/LOCAL_SETUP.md)` },
    };
  }
}
for (const [name, ids] of Object.entries(RUNTIME_GATES)) {
  await gate(name, async () => {
    if (acceptance?.unavailable) return acceptance.unavailable;
    if (acceptance?.error) return { status: FAIL, detail: acceptance.error };
    const checks = (acceptance.results ?? acceptance.checks ?? []).filter((c) => ids.includes(c.id));
    // Every check the gate stands for must have run; a subset is not the gate (DL-18).
    const missing = ids.filter((id) => !checks.some((c) => c.id === id));
    if (missing.length) return { status: FAIL, detail: `did not run: ${missing.join(", ")}` };
    const failedChecks = checks.filter((c) => c.status === FAIL);
    const blockedChecks = checks.filter((c) => c.status === BLOCKED);
    const summary = checks.map((c) => `${c.id}=${c.status === PASS ? "PASS" : c.status}`).join(" ");
    if (failedChecks.length) return { status: FAIL, detail: summary };
    if (blockedChecks.length) return { status: BLOCKED, detail: summary };
    return { status: PASS, detail: summary };
  });
}

// --- deployment gates -------------------------------------------------------------------------
await gate("DOCKER", async () => {
  const version = await run("DOCKER", "docker", ["version", "--format", "{{.Server.Version}}"]);
  if (version.code !== 0) return { status: BLOCKED, detail: "no Docker daemon on this machine" };
  const compose = await run("DOCKER", "docker", ["compose", "config", "--quiet"]);
  if (compose.code !== 0) return { status: FAIL, detail: "docker-compose.yml is invalid" };
  const sandbox = await run("DOCKER", "npm", ["run", "test:docker", "-w", "@ai-platform/security"]);
  if (sandbox.code !== 0) return { status: FAIL, detail: `real-container sandbox suite failed: ${vitestSummary(sandbox.output)}` };
  let built = "";
  if (process.env.VERIFY_DOCKER_BUILD === "1") {
    for (const file of ["backend/Dockerfile", "frontend/Dockerfile"]) {
      const res = await run("DOCKER", "docker", ["build", "-f", file, "-t", `verify-${file.split("/")[0]}`, "."]);
      if (res.code !== 0) return { status: FAIL, detail: `${file} did not build` };
    }
    built = "; both images built";
  }
  return { status: PASS, detail: `Docker ${version.output.trim().split("\n").pop()}; compose valid; sandbox ${vitestSummary(sandbox.output)}${built}` };
});
await gate("TERRAFORM", async () => {
  const cwd = join(ROOT, "infrastructure/terraform");
  const version = await run("TERRAFORM", "terraform", ["version"], { cwd });
  if (version.code !== 0) return { status: FAIL, detail: "terraform is not installed (https://developer.hashicorp.com/terraform/install)" };
  const fmt = await run("TERRAFORM", "terraform", ["fmt", "-check", "-recursive"], { cwd });
  if (fmt.code !== 0) return { status: FAIL, detail: "terraform fmt -check found unformatted files" };
  // -lockfile=readonly: a gate must not rewrite a tracked file. An init against a local provider
  // mirror added this platform's hashes to .terraform.lock.hcl, and the change got committed.
  const init = await run("TERRAFORM", "terraform", ["init", "-backend=false", "-input=false", "-lockfile=readonly"], { cwd });
  if (init.code !== 0) {
    if (/registry\.terraform\.io|Forbidden|could not connect|timeout|no such host/i.test(init.output) && !existsSync(join(cwd, ".terraform"))) {
      return { status: BLOCKED, detail: "providers cannot be downloaded (registry unreachable); set TF_CLI_CONFIG_FILE to a filesystem mirror" };
    }
    if (!existsSync(join(cwd, ".terraform/providers"))) return { status: FAIL, detail: "terraform init failed" };
  }
  const validate = await run("TERRAFORM", "terraform", ["validate"], { cwd });
  if (validate.code !== 0) return { status: FAIL, detail: "terraform validate failed" };
  return { status: PASS, detail: "fmt, init, validate pass (plan/apply need GCP credentials: docs/PRODUCTION_DEPLOYMENT_BLOCKER.md)" };
});

// --- summary ----------------------------------------------------------------------------------
const counts = { [PASS]: 0, [FAIL]: 0, [BLOCKED]: 0 };
for (const r of results) counts[r.status]++;
const summary = `${counts[PASS]} PASS · ${counts[FAIL]} FAIL · ${counts[BLOCKED]} BLOCKED_EXTERNAL`;
process.stdout.write(`\n${summary}\n`);
writeFileSync(join(OUT, "verify.json"), JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2));
const exitCode = counts[FAIL] > 0 || (strict && counts[BLOCKED] > 0) ? 1 : 0;
process.exit(exitCode);
