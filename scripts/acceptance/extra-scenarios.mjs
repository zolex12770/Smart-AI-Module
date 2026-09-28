#!/usr/bin/env node
/**
 * The scenarios the main acceptance run does not cover, against a RUNNING stack with real models:
 *
 *   CODING-SECOND       a second, unrelated coding task (slugify), verified by running its test here
 *   CODING-BAD-PATCH    a task where a naive patch is wrong (duration parsing): whatever the model
 *                       does, the task's verdict must agree with an independent run of the test,
 *                       and the test file must be untouched — never COMPLETED over a failing test
 *   IMAGE-NEGATIVE      invalid image requests are refused before anything is queued or charged
 *   IMAGE-REPRODUCIBLE  the same prompt and seed give byte-identical images; another seed differs
 *
 *   ACCEPT_API_URL=http://127.0.0.1:8787 ACCEPT_OUT=./acceptance-out node scripts/acceptance/extra-scenarios.mjs
 *
 * EXTRA_ONLY=ID,ID runs a subset. Results: $ACCEPT_OUT/extra-scenarios.json and .md.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, Client, waitFor } from "../lib/acceptance.mjs";
import { inspectPng } from "./media-checks.mjs";

const PASS = "PASS";
const FAIL = "FAIL";
const BLOCKED = "BLOCKED_EXTERNAL";
const OUT = process.env.ACCEPT_OUT ?? "acceptance-results";
const only = process.env.EXTRA_ONLY ? new Set(process.env.EXTRA_ONLY.split(",").map((s) => s.trim())) : null;
const AGENT_TIMEOUT_MS = Number(process.env.ACCEPT_AGENT_TIMEOUT_MS ?? 40 * 60_000);
const IMAGE_TIMEOUT_MS = Number(process.env.ACCEPT_IMAGE_TIMEOUT_MS ?? 30 * 60_000);
const results = [];
const started = Date.now();

async function check(id, title, fn) {
  if (only && !only.has(id)) return;
  const t = Date.now();
  let outcome;
  try {
    outcome = await fn();
  } catch (err) {
    outcome = { status: FAIL, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const row = { id, title, status: outcome.status, seconds: Math.round((Date.now() - t) / 1000), detail: outcome.detail, evidence: outcome.evidence ?? null };
  results.push(row);
  process.stdout.write(`  ${row.status.padEnd(17)} ${id.padEnd(19)} ${row.detail} (${row.seconds}s)\n`);
}

const user = new Client("extra");
await user.signUp("extra");

/** Seeds a workspace, runs `fix_failing_test`, and re-runs the test HERE on the files the API serves. */
async function codingTask({ files, testFile }) {
  for (const [path, content] of Object.entries(files)) {
    const w = await user.call("POST", "/api/v1/workspace/files", { path, content });
    if (w.status !== 201) throw new Error(`writing ${path} -> ${w.status}`);
  }
  const created = await user.call("POST", "/api/v1/agent/tasks", { taskType: "fix_failing_test", input: { testFile } });
  if (created.status !== 201 && created.status !== 202) throw new Error(`POST /agent/tasks -> ${created.status}: ${created.text.slice(0, 160)}`);
  const taskId = created.body.task.id;
  const final = await waitFor(
    async () => {
      const r = await user.call("GET", `/api/v1/agent/tasks/${taskId}`);
      const waiting = (r.body.nodes ?? []).find((n) => n.status === "waiting_approval");
      if (waiting) await user.call("POST", `/api/v1/agent/tasks/${taskId}/approve`, { nodeId: waiting.id });
      return ["COMPLETED", "FAILED", "CANCELLED"].includes(r.body.task?.state) ? r.body : null;
    },
    { timeoutMs: AGENT_TIMEOUT_MS, everyMs: 5_000, label: "the coding task" }
  );
  const dir = mkdtempSync(join(tmpdir(), "extra-coding-"));
  try {
    const served = {};
    for (const path of Object.keys(files)) {
      const r = await user.call("GET", `/api/v1/workspace/file?path=${encodeURIComponent(path)}`);
      served[path] = r.body?.content ?? "";
      writeFileSync(join(dir, path), served[path]);
    }
    let exit = 0;
    let output = "";
    try {
      output = execFileSync(process.execPath, [testFile], { cwd: dir, timeout: 30_000 }).toString().trim();
    } catch (err) {
      exit = err.status ?? 1;
      output = String(err.stderr ?? err.message).split("\n").find((l) => l.trim()) ?? "";
    }
    return { final, served, exit, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await check("CODING-SECOND", "A second, unrelated coding task: the source is fixed and the test passes, verified here", async () => {
  const SOURCE =
    "function slugify(title) {\n  return title.trim().replace(' ', '-');\n}\n\nmodule.exports = { slugify };\n";
  const TEST =
    "const assert = require('node:assert');\nconst { slugify } = require('./slugify.js');\n" +
    "assert.strictEqual(slugify('Hello World'), 'hello-world');\n" +
    "assert.strictEqual(slugify('  The Keeper of the Light  '), 'the-keeper-of-the-light');\n" +
    "assert.strictEqual(slugify('Fog, Rain & Wind!'), 'fog-rain-wind');\nconsole.log('ok');\n";
  const { final, served, exit, output } = await codingTask({ files: { "slugify.js": SOURCE, "slugify.test.cjs": TEST }, testFile: "slugify.test.cjs" });
  const testUntouched = served["slugify.test.cjs"] === TEST;
  const ok = final.task.state === "COMPLETED" && exit === 0 && testUntouched && served["slugify.js"] !== SOURCE;
  return {
    status: ok ? PASS : FAIL,
    detail: `task ${final.task.state}; independent run: ${exit === 0 ? `"${output}" (exit 0)` : `exit ${exit}: ${output}`}; test untouched: ${testUntouched}`,
    evidence: { source: served["slugify.js"] },
  };
});

await check("CODING-BAD-PATCH", "Where a naive patch is wrong, the task's verdict agrees with the test, and the test is not edited", async () => {
  // A plausible first fix (parse the digits and multiply by 60) passes the first assertion and
  // fails the rest, so the run either corrects itself or must end FAILED. What may never happen:
  // COMPLETED over a failing test, or a "fix" that edits the test.
  const SOURCE =
    "// Returns the duration in seconds: '90s', '2m', '1h30m', '1h 5m 10s'.\n" +
    "function parseDuration(text) {\n  return parseInt(text, 10);\n}\n\nmodule.exports = { parseDuration };\n";
  const TEST =
    "const assert = require('node:assert');\nconst { parseDuration } = require('./duration.js');\n" +
    "assert.strictEqual(parseDuration('2m'), 120);\n" +
    "assert.strictEqual(parseDuration('90s'), 90);\n" +
    "assert.strictEqual(parseDuration('1h30m'), 5400);\n" +
    "assert.strictEqual(parseDuration('1h 5m 10s'), 3910);\n" +
    "assert.throws(() => parseDuration('soon'));\nconsole.log('ok');\n";
  const { final, served, exit, output } = await codingTask({ files: { "duration.js": SOURCE, "duration.test.cjs": TEST }, testFile: "duration.test.cjs" });
  const testUntouched = served["duration.test.cjs"] === TEST;
  const agrees = (final.task.state === "COMPLETED") === (exit === 0);
  const node = (final.nodes ?? []).find((n) => n.kind === "reasoning") ?? (final.nodes ?? [])[0] ?? {};
  const verification = node.output?.verification;
  return {
    status: agrees && testUntouched ? PASS : FAIL,
    detail:
      `task ${final.task.state}; independent run: ${exit === 0 ? "exit 0" : `exit ${exit}: ${output.slice(0, 80)}`}; ` +
      `verdict agrees with the test: ${agrees}; test untouched: ${testUntouched}` +
      (verification ? `; in-loop verification: ${verification.ok ? "ok" : "failed"}${verification.inconclusive ? " (inconclusive)" : ""}` : "") +
      (node.errorMessage ? `; reason: ${node.errorMessage.slice(0, 100)}` : ""),
    evidence: { source: served["duration.js"], state: final.task.state },
  };
});

await check("IMAGE-NEGATIVE", "Invalid image requests are refused before anything is queued", async () => {
  const before = (await user.call("GET", "/api/v1/images")).body?.generations?.length ?? 0;
  const failures = [];
  const cases = [
    [{ prompt: "" }, "empty prompt"],
    [{}, "no prompt"],
    [{ prompt: "a harbour", aspectRatio: "5:4" }, "unsupported aspect ratio"],
    [{ prompt: "a harbour", quality: "ultra" }, "unknown quality"],
    [{ prompt: "a harbour", seed: 1.5 }, "non-integer seed"],
  ];
  for (const [body, label] of cases) {
    const res = await user.call("POST", "/api/v1/images", body);
    if (res.status === 501) return { status: BLOCKED, detail: "no image provider configured" };
    if (res.status !== 400) failures.push(`${label} → ${res.status}`);
  }
  const after = (await user.call("GET", "/api/v1/images")).body?.generations?.length ?? 0;
  if (after !== before) failures.push(`${after - before} generation(s) were created by refused requests`);
  return failures.length
    ? { status: FAIL, detail: failures.join(" | ") }
    : { status: PASS, detail: `${cases.length} invalid requests, each 400; no generation created` };
});

async function generate(prompt, seed) {
  const created = await user.call("POST", "/api/v1/images", { prompt, seed, aspectRatio: "1:1", quality: "fast" });
  if (created.status !== 202) throw new Error(`POST /images -> ${created.status}: ${created.text.slice(0, 120)}`);
  const id = created.body.generation.id;
  const done = await waitFor(
    async () => {
      const r = await user.call("GET", `/api/v1/images/${id}`);
      return ["succeeded", "failed", "cancelled"].includes(r.body.generation?.status) ? r.body.generation : null;
    },
    { timeoutMs: IMAGE_TIMEOUT_MS, everyMs: 10_000, label: `image ${seed}` }
  );
  if (done.status !== "succeeded") throw new Error(`image with seed ${seed} ended ${done.status}: ${done.errorMessage ?? ""}`);
  const bytes = (await user.download(`/api/v1/assets/${done.resultAssetId}`)).bytes;
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex"), png: inspectPng(bytes) };
}

await check("IMAGE-REPRODUCIBLE", "The same prompt and seed give the same image, byte for byte; another seed gives another", async () => {
  const providers = await user.call("GET", "/api/v1/providers");
  if (!providers.body?.image?.available || providers.body?.image?.isMock) return { status: BLOCKED, detail: "no real image provider configured" };
  const prompt = "a red lighthouse on a rocky shore under a clear sky";
  const a = await generate(prompt, 4242);
  const b = await generate(prompt, 4242);
  const c = await generate(prompt, 777);
  const failures = [];
  if (!a.png.ok) failures.push(`first image is not a valid PNG: ${a.png.reason}`);
  if (a.sha !== b.sha) failures.push(`seed 4242 twice gave different bytes (${a.sha.slice(0, 12)} vs ${b.sha.slice(0, 12)})`);
  if (a.sha === c.sha) failures.push("seed 777 gave the same bytes as seed 4242");
  return failures.length
    ? { status: FAIL, detail: failures.join(" | ") }
    : {
        status: PASS,
        detail: `seed 4242 twice → identical sha256 ${a.sha.slice(0, 16)}… (${a.bytes.length} bytes, ${a.png.width}×${a.png.height}); seed 777 → ${c.sha.slice(0, 16)}…`,
      };
});

const counts = { PASS: 0, FAIL: 0, BLOCKED_EXTERNAL: 0 };
for (const r of results) counts[r.status]++;
const summary = `${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.BLOCKED_EXTERNAL} BLOCKED_EXTERNAL in ${Math.round((Date.now() - started) / 1000)} s`;
process.stdout.write(`\n  ${summary}\n`);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "extra-scenarios.json"), JSON.stringify({ api: API, startedAt: new Date(started).toISOString(), counts, results }, null, 2));
writeFileSync(
  join(OUT, "extra-scenarios.md"),
  [
    "# Extra scenarios",
    "",
    `- API: \`${API}\``,
    `- Started: ${new Date(started).toISOString()}`,
    `- **${summary}**`,
    "",
    "| Check | Status | Seconds | Observed |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} — ${r.title} | ${r.status} | ${r.seconds} | ${r.detail.replace(/\|/g, "\\|")} |`),
    "",
  ].join("\n")
);
process.exit(counts.FAIL > 0 ? 1 : 0);
