#!/usr/bin/env node
/**
 * Latency of a RUNNING platform, measured rather than asserted — there are no targets here, only
 * numbers, so docs/FINAL_PRODUCTION_READINESS_REPORT.md can quote what was observed.
 *
 *   node scripts/acceptance/latency.mjs
 *
 * Measures, against the API the browser uses:
 *   - liveness            GET /api/health (no auth, no database)
 *   - authenticated read  GET /api/v1/conversations (session lookup + one scoped query)
 *   - readiness           GET /api/v1/admin/health (`select 1`, a queue probe, two counts) — needs
 *                         ACCEPT_ADMIN_EMAIL / ACCEPT_ADMIN_PASSWORD, otherwise reported as skipped
 *   - chat streaming      time to first token and the interval between tokens, per request
 * and, directly against the embedding server the platform is configured with:
 *   - embedding           one ~100-word passage (ACCEPT_EMBEDDING_URL, ACCEPT_EMBEDDING_MODEL)
 *
 * Writes latency.json and latency.md to $ACCEPT_OUT (default ./acceptance-results).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API, Client, requireRunningApi } from "../lib/acceptance.mjs";

const OUT = process.env.ACCEPT_OUT ?? "acceptance-results";
const EMBEDDING_URL = (process.env.ACCEPT_EMBEDDING_URL ?? "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const EMBEDDING_MODEL = process.env.ACCEPT_EMBEDDING_MODEL ?? "nomic-embed-text";
const CHAT_RUNS = Number(process.env.ACCEPT_CHAT_RUNS ?? 3);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const summary = (values) => ({
  n: values.length,
  p50: Math.round(percentile(values, 50) * 10) / 10,
  p95: Math.round(percentile(values, 95) * 10) / 10,
  max: Math.round(Math.max(...values) * 10) / 10,
});

async function time(fn, n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const status = await fn();
    if (status !== 200) throw new Error(`request ${i + 1} answered ${status}`);
    samples.push(performance.now() - t);
  }
  return summary(samples);
}

await requireRunningApi();
const results = { api: API, measuredAt: new Date().toISOString() };

const user = new Client("latency");
await user.signUp("latency");

results.liveness_ms = await time(async () => (await fetch(`${API}/api/health`)).status, 50);
results.authenticated_read_ms = await time(async () => (await user.call("GET", "/api/v1/conversations")).status, 30);

if (process.env.ACCEPT_ADMIN_EMAIL && process.env.ACCEPT_ADMIN_PASSWORD) {
  const admin = new Client("admin");
  await admin.login(process.env.ACCEPT_ADMIN_EMAIL, process.env.ACCEPT_ADMIN_PASSWORD);
  results.readiness_ms = await time(async () => (await admin.call("GET", "/api/v1/admin/health")).status, 20);
} else {
  results.readiness_ms = "skipped: ACCEPT_ADMIN_EMAIL / ACCEPT_ADMIN_PASSWORD not set";
}

const passage =
  "Engineers receive twenty-seven days of paid leave per calendar year. Unused days carry over " +
  "for one quarter and then lapse. Leave is requested through the people portal at least two " +
  "weeks ahead, except in an emergency, when a manager may approve it on the day. Public holidays " +
  "are separate and do not count against the allowance. Part-time staff accrue leave pro rata, " +
  "and anyone who joins mid-year receives the proportion for the months that remain.";
try {
  const embedSamples = [];
  let dimensions = null;
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    const res = await fetch(`${EMBEDDING_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: passage }),
    });
    const body = await res.json();
    if (!res.ok || !body.data?.[0]?.embedding) throw new Error(`embeddings answered ${res.status}`);
    dimensions = body.data[0].embedding.length;
    embedSamples.push(performance.now() - t);
  }
  results.embedding_ms = { ...summary(embedSamples), model: EMBEDDING_MODEL, dimensions };
} catch (error) {
  results.embedding_ms = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
}

const firstTokens = [];
const intervals = [];
for (let i = 0; i < CHAT_RUNS; i++) {
  const at = [];
  const res = await user.stream(
    "/api/v1/chat",
    { messages: [{ role: "user", content: "In two sentences, why do bridges have expansion joints?" }] },
    (event, ms) => event.type === "token" && at.push(ms)
  );
  if (res.status !== 200 || at.length < 2) throw new Error(`chat ${i + 1}: status ${res.status}, ${at.length} token events`);
  firstTokens.push(at[0]);
  for (let k = 1; k < at.length; k++) intervals.push(at[k] - at[k - 1]);
}
results.chat_first_token_ms = summary(firstTokens);
results.chat_token_interval_ms = summary(intervals);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "latency.json"), JSON.stringify(results, null, 2));
const row = (name, v) =>
  typeof v === "string" ? `| ${name} | ${v} | | | |` : `| ${name} | ${v.n} | ${v.p50} | ${v.p95} | ${v.max} |`;
writeFileSync(
  join(OUT, "latency.md"),
  [
    `# Latency — ${results.measuredAt}`,
    "",
    `API: ${API}`,
    "",
    "| Measurement (ms) | n | p50 | p95 | max |",
    "|---|---|---|---|---|",
    row("liveness `GET /api/health`", results.liveness_ms),
    row("authenticated read `GET /api/v1/conversations`", results.authenticated_read_ms),
    row("readiness `GET /api/v1/admin/health` (database + queue)", results.readiness_ms),
    row(`embedding, one passage (${EMBEDDING_MODEL})`, results.embedding_ms),
    row("chat: time to first token", results.chat_first_token_ms),
    row("chat: interval between tokens", results.chat_token_interval_ms),
    "",
  ].join("\n")
);
console.log(JSON.stringify(results, null, 2));
