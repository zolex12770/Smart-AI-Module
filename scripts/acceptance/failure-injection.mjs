#!/usr/bin/env node
/**
 * Failure injection against the Docker Compose stack — break one dependency at a time, for real,
 * and check the platform fails HONESTLY (a clear error, never a hang, never a fabricated success,
 * never a charge for work that did not happen) and RECOVERS when the dependency comes back.
 *
 *   ACCEPT_API_URL=http://127.0.0.1:8787 ACCEPT_ADMIN_EMAIL=… ACCEPT_ADMIN_PASSWORD=… \
 *   COMPOSE="docker compose --env-file compose.env -f docker-compose.yml -f docker-compose.sdcpp.yml" \
 *   node scripts/acceptance/failure-injection.mjs
 *
 * Every scenario restores what it broke in a `finally`, even when it fails. INJECT_ONLY=ID,ID runs
 * a subset. Results: $ACCEPT_OUT/failure-injection.json and .md; exit 1 on any FAIL.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API, Client } from "../lib/acceptance.mjs";

const PASS = "PASS";
const FAIL = "FAIL";
const BLOCKED = "BLOCKED_EXTERNAL";
const OUT = process.env.ACCEPT_OUT ?? "acceptance-results";
const COMPOSE = process.env.COMPOSE ?? "docker compose";
const only = process.env.INJECT_ONLY ? new Set(process.env.INJECT_ONLY.split(",").map((s) => s.trim())) : null;
const results = [];
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const compose = (args) => execSync(`${COMPOSE} ${args}`, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const container = (service) => compose(`ps -q ${service}`).trim();

async function check(id, title, fn) {
  if (only && !only.has(id)) return;
  const t = Date.now();
  let outcome;
  try {
    outcome = await fn();
  } catch (err) {
    outcome = { status: FAIL, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const row = { id, title, status: outcome.status, seconds: Math.round((Date.now() - t) / 1000), detail: outcome.detail };
  results.push(row);
  process.stdout.write(`  ${row.status.padEnd(17)} ${id.padEnd(16)} ${row.detail} (${row.seconds}s)\n`);
}

async function until(fn, { timeoutMs, everyMs = 2000 }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) return undefined;
    await sleep(everyMs);
  }
}

const verdict = (failures, pass) => (failures.length ? { status: FAIL, detail: failures.join(" | ") } : { status: PASS, detail: pass });

try {
  compose("ps");
} catch (err) {
  process.stdout.write(`BLOCKED_EXTERNAL  no Docker Compose stack reachable through \`${COMPOSE}\`: ${err.message}\n`);
  process.exit(0);
}

const user = new Client("injector");
await user.signUp("inject");
const chat = (content) => user.stream("/api/v1/chat", { messages: [{ role: "user", content }], maxOutputTokens: 64 });
const usageRows = async () => (await user.call("GET", "/api/v1/usage")).body?.projectUsage?.llm?.tokensThisMonth ?? 0;

// --- The model runtime (chat AND embeddings: both are Ollama here) ------------------------------
await check("LLM-DOWN", "Model runtime stopped: chat and RAG fail fast with a clear error, then recover", async () => {
  const failures = [];
  const before = await usageRows();
  let chatFailure = "";
  compose("stop ollama");
  try {
    const t = Date.now();
    const turn = await chat("Say hello.");
    const seconds = Math.round((Date.now() - t) / 1000);
    const error = turn.events.find((e) => e.type === "error");
    const done = turn.events.find((e) => e.type === "done");
    if (done) failures.push("chat produced a `done` answer with the model runtime stopped");
    if (!error && turn.status < 500) failures.push(`chat: no error event and HTTP ${turn.status}`);
    if (seconds > 120) failures.push(`chat took ${seconds}s to fail`);
    if (error && /ECONNREFUSED|ENOTFOUND|http:\/\/|127\.0\.0\.1|ollama:11434/i.test(error.message)) {
      failures.push(`error leaks internals: "${error.message}"`);
    }
    const rag = await user.call("POST", "/api/v1/rag/query", { question: "What does the handbook say?" });
    if (rag.status < 400 || rag.status === 500) failures.push(`RAG with no embedding runtime → ${rag.status}`);
    if ((await usageRows()) !== before) failures.push("tokens were charged for turns no model produced");
    chatFailure = `chat failed in ${seconds}s with "${(error?.message ?? `HTTP ${turn.status}`).slice(0, 80)}"; RAG → ${rag.status}`;
  } finally {
    compose("start ollama");
  }
  const recovered = await until(async () => (await chat("Reply with the single word: ready")).events.some((e) => e.type === "done"), {
    timeoutMs: 10 * 60_000,
    everyMs: 10_000,
  });
  if (!recovered) failures.push("chat did not recover within 10 minutes of the runtime restarting");
  return verdict(failures, `${chatFailure}; nothing charged; chat answered again after restart`);
});

// --- The database ---------------------------------------------------------------------------------
await check("DB-DOWN", "Postgres stopped: readiness says so, requests fail fast, and the API recovers without a restart", async () => {
  const failures = [];
  let down = "";
  compose("stop postgres");
  try {
    await sleep(3000);
    const t = Date.now();
    const res = await user.call("GET", "/api/v1/memory").catch((err) => ({ status: `network error ${err.message}` }));
    const seconds = Math.round((Date.now() - t) / 1000);
    if (typeof res.status !== "number" || res.status < 500) failures.push(`an authenticated read with no database → ${res.status}`);
    if (seconds > 60) failures.push(`the failing request took ${seconds}s`);
    const health = await user.call("GET", "/api/health");
    if (health.status !== 200) failures.push(`liveness (/api/health) → ${health.status}; it must stay up so the orchestrator does not kill a process that will recover`);
    down = `authenticated read → ${res.status} in ${seconds}s; liveness stayed 200`;
  } finally {
    compose("start postgres");
  }
  const back = await until(async () => (await user.call("GET", "/api/v1/memory")).status === 200, { timeoutMs: 120_000 });
  if (!back) failures.push("the API did not recover within 2 minutes of the database returning");
  return verdict(failures, `${down}; recovered without restarting the API`);
});

// --- The job worker (the queue itself lives in Postgres) --------------------------------------------
await check("WORKER-DOWN", "Worker stopped: queued work waits, durably, and completes when a worker returns", async () => {
  const failures = [];
  compose("stop worker");
  let id;
  try {
    const created = await user.call("POST", "/api/v1/audio", { text: "The harbour lights are lit at dusk." });
    if (created.status === 501) return { status: BLOCKED, detail: "no speech provider configured" };
    id = created.body?.generation?.id;
    if (!id) return { status: FAIL, detail: `audio create → ${created.status}` };
    await sleep(20_000);
    const waiting = await user.call("GET", `/api/v1/audio/${id}`);
    if (waiting.body?.generation?.status !== "pending") failures.push(`with no worker the job is "${waiting.body?.generation?.status}", not pending`);
  } finally {
    compose("start worker");
  }
  const done = await until(async () => {
    const r = await user.call("GET", `/api/v1/audio/${id}`);
    return ["succeeded", "failed"].includes(r.body?.generation?.status) ? r.body.generation.status : undefined;
  }, { timeoutMs: 5 * 60_000, everyMs: 5000 });
  if (done !== "succeeded") failures.push(`after the worker returned, the job ended "${done ?? "still pending"}"`);
  return verdict(failures, "pending for 20 s with no worker; succeeded after the worker restarted");
});

// --- A media provider dying mid-generation ------------------------------------------------------------
await check("MEDIA-CRASH", "The image process killed mid-generation: the image fails honestly and is not charged", async () => {
  const providers = await user.call("GET", "/api/v1/providers");
  // The body is `{ providers: { image, video, speech } }`.
  const image = providers.body?.providers?.image;
  if (!image?.available) return { status: BLOCKED, detail: "no image provider is configured on this deployment" };
  if (image.isMock) return { status: FAIL, detail: `the image provider is a MOCK (${image.name}); a crash of it proves nothing` };
  const before = (await user.call("GET", "/api/v1/usage")).body?.projectUsage?.images?.generatedToday ?? 0;
  const created = await user.call("POST", "/api/v1/images", { prompt: "a lighthouse at dusk", aspectRatio: "1:1", quality: "fast" });
  const id = created.body?.generation?.id;
  if (!id) return { status: FAIL, detail: `image create → ${created.status}` };
  const running = await until(async () => {
    const r = await user.call("GET", `/api/v1/images/${id}`);
    return r.body?.generation?.status === "processing";
  }, { timeoutMs: 5 * 60_000 });
  if (!running) return { status: FAIL, detail: "the image never started processing" };
  await sleep(5000);
  const worker = container("worker");
  if (!killInContainer(worker, "sd-cli")) return { status: FAIL, detail: "the image was processing but no sd-cli process was running in the worker" };
  const settled = await until(async () => {
    const r = await user.call("GET", `/api/v1/images/${id}`);
    return ["succeeded", "failed", "cancelled"].includes(r.body?.generation?.status) ? r.body.generation : undefined;
  }, { timeoutMs: 5 * 60_000 });
  const failures = [];
  if (!settled) failures.push("the image never settled after its process was killed");
  else if (settled.status !== "failed") failures.push(`the image settled "${settled.status}" after its process was killed`);
  if (settled?.errorMessage && /\/opt\/|sd-cli|exited with code|signal/i.test(settled.errorMessage)) {
    failures.push(`the error shown to the user leaks internals: "${settled.errorMessage}"`);
  }
  const after = (await user.call("GET", "/api/v1/usage")).body?.projectUsage?.images?.generatedToday ?? 0;
  if (after !== before) failures.push("an image that was never produced was charged");
  return verdict(failures, `settled "failed" with "${settled?.errorMessage ?? ""}"; not charged`);
});

/**
 * SIGKILLs every process in `containerId` whose command line contains `name`; true when one was.
 *
 * No shell, on purpose. The first run used `sh -c 'pkill -9 -f sd-cli'`: the shell's own command
 * line contains "sd-cli", so pkill killed its parent shell and the scenario died before injecting
 * anything. `pkill` never matches itself, and with no shell there is nothing else to match.
 */
function killInContainer(containerId, name) {
  try {
    execFileSync("docker", ["exec", containerId, "pkill", "-9", "-f", name], { stdio: "ignore" });
    return true;
  } catch {
    return false; // exit 1: nothing matched
  }
}

// --- An MCP server dying ------------------------------------------------------------------------------
await check("MCP-CRASH", "The MCP server process killed: it is marked down and its tools removed; reconnect restores it", async () => {
  const email = process.env.ACCEPT_ADMIN_EMAIL;
  const password = process.env.ACCEPT_ADMIN_PASSWORD;
  if (!email || !password) return { status: BLOCKED, detail: "ACCEPT_ADMIN_EMAIL / ACCEPT_ADMIN_PASSWORD not set (reconnect is a system-admin action)" };
  const admin = new Client("admin");
  await admin.login(email, password);
  const me = await admin.call("GET", "/api/v1/auth/me");
  admin.projectId = me.body.projects[0].id;
  const servers = (await admin.call("GET", "/api/v1/mcp")).body?.servers ?? [];
  const server = servers.find((s) => s.status === "connected");
  if (!server) return { status: BLOCKED, detail: "no connected MCP server on this deployment" };
  const api = container("api");
  if (!killInContainer(api, "server-filesystem")) return { status: FAIL, detail: "the server reported connected but no server-filesystem process was running" };
  const down = await until(async () => {
    const s = ((await admin.call("GET", "/api/v1/mcp")).body?.servers ?? []).find((x) => x.id === server.id);
    return s && s.status !== "connected" ? s : undefined;
  }, { timeoutMs: 150_000, everyMs: 5000 });
  const failures = [];
  if (!down) failures.push("still reported connected 150 s after its process died");
  else if (down.toolCount !== 0) failures.push(`marked ${down.status} but still offers ${down.toolCount} tools`);
  const reconnect = await admin.call("POST", `/api/v1/mcp/${server.id}/reconnect`);
  const back = ((await admin.call("GET", "/api/v1/mcp")).body?.servers ?? []).find((x) => x.id === server.id);
  if (reconnect.status !== 200 || back?.status !== "connected") failures.push(`reconnect → ${reconnect.status}, status ${back?.status}`);
  return verdict(failures, `marked "${down?.status}" with 0 tools ("${(down?.lastError ?? "").slice(0, 60)}"); reconnect restored ${back?.toolCount} tools`);
});

const counts = { PASS: 0, FAIL: 0, BLOCKED_EXTERNAL: 0 };
for (const r of results) counts[r.status]++;
const summary = `${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.BLOCKED_EXTERNAL} BLOCKED_EXTERNAL in ${Math.round((Date.now() - started) / 1000)} s`;
process.stdout.write(`\n  ${summary}\n`);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "failure-injection.json"), JSON.stringify({ api: API, startedAt: new Date(started).toISOString(), counts, results }, null, 2));
writeFileSync(
  join(OUT, "failure-injection.md"),
  [
    "# Failure injection",
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
