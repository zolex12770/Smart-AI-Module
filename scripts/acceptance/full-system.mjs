#!/usr/bin/env node
/**
 * The full-system acceptance run — one user's whole journey through a RUNNING platform.
 *
 *   cd backend && npm run dev                    # or docker compose up
 *   node scripts/acceptance/full-system.mjs
 *
 * Every check drives the real HTTP API the way the browser does (cookies, CSRF, streamed bytes,
 * assets fetched through the API) and asserts on what came back — the words of the answer, the
 * pixels of the image, the samples of the audio, the streams of the video — never merely on a
 * status code. Each result is one of:
 *
 *   PASS              observed working, with the measurement that shows it
 *   FAIL              observed not working
 *   BLOCKED_EXTERNAL  cannot be exercised here because something outside the platform is absent
 *                     (no image model configured, no ffprobe on this machine), named in the detail
 *
 * Results are written as JSON and Markdown to $ACCEPT_OUT (default ./acceptance-results).
 *
 * Environment:
 *   ACCEPT_API_URL          the API (default http://127.0.0.1:8787)
 *   ACCEPT_ADMIN_EMAIL      a system administrator, for the metrics check (optional; the
 *   ACCEPT_ADMIN_PASSWORD   backend's BOOTSTRAP_ADMIN_* values)
 *   ACCEPT_ONLY             comma-separated check ids to run, for debugging one area
 *   ACCEPT_AGENT_TIMEOUT_MS how long to wait for the coding agent (default 40 minutes)
 *   ACCEPT_VIDEO_TIMEOUT_MS how long to wait for the video (default 40 minutes)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, Client, requireRunningApi, waitFor } from "../lib/acceptance.mjs";
import { ffprobe, inspectPng, inspectWav } from "./media-checks.mjs";

const PASS = "PASS";
const FAIL = "FAIL";
const BLOCKED = "BLOCKED_EXTERNAL";

const only = process.env.ACCEPT_ONLY ? new Set(process.env.ACCEPT_ONLY.split(",").map((s) => s.trim())) : null;
const OUT = process.env.ACCEPT_OUT ?? "acceptance-results";
const AGENT_TIMEOUT_MS = Number(process.env.ACCEPT_AGENT_TIMEOUT_MS ?? 40 * 60_000);
const VIDEO_TIMEOUT_MS = Number(process.env.ACCEPT_VIDEO_TIMEOUT_MS ?? 40 * 60_000);

const results = [];
const started = Date.now();
const secondsSince = (t) => Math.round((Date.now() - t) / 100) / 10;

/** Runs one check. `fn` returns { status, detail, evidence? }; a throw is a FAIL with the reason. */
async function check(id, title, fn) {
  if (only && !only.has(id)) return null;
  const t = Date.now();
  let outcome;
  try {
    outcome = await fn();
  } catch (err) {
    outcome = { status: FAIL, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!outcome.detail) throw new Error(`${id}: a result needs a detail — a bare verdict is not evidence`);
  const row = { id, title, status: outcome.status, seconds: secondsSince(t), detail: outcome.detail, evidence: outcome.evidence ?? null };
  results.push(row);
  const colour = { PASS: "\x1b[32m", FAIL: "\x1b[31m", BLOCKED_EXTERNAL: "\x1b[33m" }[row.status] ?? "";
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  console.log(`  ${tty ? colour : ""}${row.status.padEnd(16)}${tty ? "\x1b[0m" : ""} ${id.padEnd(22)} ${row.detail}`);
  return row;
}

const passed = (id) => results.find((r) => r.id === id)?.status === PASS;

// ---------------------------------------------------------------------------------------------

await requireRunningApi();
console.log(`\nFull-system acceptance\n----------------------\n  api: ${API}\n`);

const user = new Client("journey");
const password = "a-sufficiently-long-password";
let providers = null;
let chatConversationId = null;

await check("AUTH-SIGNUP", "Create an account", async () => {
  await user.signUp("journey");
  return {
    status: user.projectId && user.role === "admin" ? PASS : FAIL,
    detail: `signed up ${user.email}; default project ${user.projectId.slice(0, 8)}…, role ${user.role}`,
  };
});
if (!user.projectId) {
  console.error("\nSign-up failed; nothing after it can run.");
  finish();
  process.exit(1);
}

await check("AUTH-SESSION", "Logout revokes the session; login restores it", async () => {
  const stolen = user.cookie;
  const out = await user.call("POST", "/api/v1/auth/logout");
  const replay = await fetch(`${API}/api/v1/auth/me`, { headers: { cookie: stolen } });
  await user.login(user.email, password);
  const me = await user.call("GET", "/api/v1/auth/me");
  return {
    status: out.status === 200 && replay.status === 401 && me.status === 200 ? PASS : FAIL,
    detail: `logout ${out.status}; the old cookie replayed -> ${replay.status} (401 = revoked server-side); login again -> /auth/me ${me.status}`,
  };
});

await check("PROJECT-CREATE", "Create a project and work in it", async () => {
  const res = await user.call("POST", "/api/v1/projects", { name: `Acceptance ${new Date().toISOString().slice(0, 10)}` });
  if (res.status !== 201) return { status: FAIL, detail: `POST /projects -> ${res.status}: ${res.text.slice(0, 160)}` };
  user.projectId = res.body.project.id;
  const listed = await user.call("GET", "/api/v1/projects");
  const names = (listed.body.projects ?? []).length;
  return { status: PASS, detail: `created project ${user.projectId.slice(0, 8)}…; the account now lists ${names} project(s); all later checks run in it` };
});

await check("PROVIDERS", "The platform states what it runs", async () => {
  const models = await user.call("GET", "/api/v1/models");
  const media = await user.call("GET", "/api/v1/providers");
  providers = media.body?.providers ?? {};
  const defaultModel = (models.body.models ?? models.body.providers ?? []).find?.((m) => m.isDefault) ?? null;
  const names = JSON.stringify(models.body).match(/"(?:provider|name)":"[^"]+"/g)?.slice(0, 4).join(" ") ?? "";
  const mockLlm = /"isMock":true/.test(JSON.stringify(models.body)) && !/"isMock":false/.test(JSON.stringify(models.body));
  return {
    status: models.status === 200 && media.status === 200 && !mockLlm ? PASS : FAIL,
    detail:
      `models: ${names || "(none)"}${defaultModel ? ` default ${defaultModel.name}` : ""}; ` +
      `image ${providers.image?.available ? providers.image.name + (providers.image.isMock ? " (MOCK)" : "") : "unavailable"}, ` +
      `video ${providers.video?.available ? providers.video.name + (providers.video.isMock ? " (MOCK)" : "") : "unavailable"}, ` +
      `speech ${providers.speech?.available ? providers.speech.name : "unavailable"}`,
    evidence: { models: models.body, media: media.body },
  };
});

// ---- chat ------------------------------------------------------------------------------------

await check("CHAT-STREAM", "A real model answers, streamed progressively", async () => {
  const tokens = [];
  const res = await user.stream(
    "/api/v1/chat",
    { messages: [{ role: "user", content: "In one sentence: what is a unit test?" }] },
    (event, at) => event.type === "token" && tokens.push(at)
  );
  chatConversationId = res.headers.get("x-conversation-id");
  const done = res.events.find((e) => e.type === "done");
  const answer = done?.message?.content ?? "";
  const spread = tokens.length > 1 ? tokens.at(-1) - tokens[0] : 0;
  const ok =
    res.status === 200 &&
    done &&
    done.provider !== "mock" &&
    tokens.length >= 5 &&
    spread > 200 &&
    /test/i.test(answer) &&
    answer.split(/\s+/).length >= 6;
  return {
    status: ok ? PASS : FAIL,
    detail:
      `${done?.provider}/${done?.model}: ${tokens.length} token events, first at ${tokens[0]} ms, last at ${tokens.at(-1)} ms ` +
      `(spread ${spread} ms); ${done?.usage?.inputTokens} in / ${done?.usage?.outputTokens} out; "${answer.slice(0, 80)}"`,
    evidence: { answer, provider: done?.provider, model: done?.model, firstTokenMs: tokens[0], lastTokenMs: tokens.at(-1), tokenEvents: tokens.length },
  };
});

await check("CHAT-HISTORY", "The conversation is stored and continues", async () => {
  if (!chatConversationId) return { status: FAIL, detail: "the chat response carried no X-Conversation-Id header" };
  // A fact planted in one turn and asked for in the next, inside the same conversation: only the
  // conversation's own history can carry it (a colour made up for this run).
  const colour = `vermilion-${Math.floor(Math.random() * 900 + 100)}`;
  await user.stream("/api/v1/chat", {
    conversationId: chatConversationId,
    messages: [{ role: "user", content: `For this conversation, the password word is ${colour}. Reply with just: noted.` }],
  });
  const second = await user.stream("/api/v1/chat", {
    conversationId: chatConversationId,
    messages: [{ role: "user", content: "What is the password word I gave you earlier in this conversation? Reply with just the word." }],
  });
  const answer = second.events.find((e) => e.type === "done")?.message?.content ?? "";
  const stored = await user.call("GET", `/api/v1/conversations/${chatConversationId}/messages`);
  const messages = stored.body?.messages ?? [];
  return {
    status: messages.length >= 6 && answer.includes(colour) ? PASS : FAIL,
    detail: `${messages.length} messages persisted in conversation ${chatConversationId.slice(0, 8)}…; asked for the word planted two turns earlier (${colour}), it answered "${answer.trim().slice(0, 40)}"`,
  };
});

// ---- memory ----------------------------------------------------------------------------------

const codename = `NIGHTHAWK-${Math.floor(Math.random() * 9e5 + 1e5)}`;

await check("MEMORY-FORMATION", "A fact told in one conversation is remembered without being filed by hand", async () => {
  await user.stream("/api/v1/chat", {
    messages: [{ role: "user", content: `Please remember this for later: my project codename is ${codename}.` }],
  });
  // Extraction runs after the response (ADR-141), so it is polled for, not assumed.
  const found = await waitFor(
    async () => {
      const r = await user.call("GET", "/api/v1/memory");
      return (r.body?.items ?? []).find((i) => i.content.includes(codename)) ?? null;
    },
    { timeoutMs: 180_000, everyMs: 3_000, label: "a formed memory" }
  ).catch(() => null);
  return {
    status: found ? PASS : FAIL,
    detail: found
      ? `the model extracted "${found.content.slice(0, 80)}" (scope ${found.scope}) from the turn`
      : `no memory containing ${codename} was formed within 180 s`,
  };
});

await check("MEMORY-RECALL", "A NEW conversation answers from memory", async () => {
  if (!passed("MEMORY-FORMATION")) {
    // Recall is tested on its own merits: file the fact explicitly, as the Memory screen does.
    const stored = await user.call("POST", "/api/v1/memory", { scope: "user", content: `The user's project codename is ${codename}.` });
    if (stored.status !== 201) return { status: FAIL, detail: `POST /memory -> ${stored.status}` };
  }
  const recall = await user.stream("/api/v1/chat", {
    messages: [{ role: "user", content: "What is my project codename? Reply with just the codename." }],
  });
  const answer = recall.events.find((e) => e.type === "done")?.message?.content ?? "";
  return {
    status: answer.includes(codename) ? PASS : FAIL,
    detail: `new conversation (no conversationId) answered "${answer.trim().slice(0, 60)}" — expected ${codename}`,
  };
});

await check("MEMORY-DELETE", "A deleted memory is no longer recalled", async () => {
  const listed = await user.call("GET", "/api/v1/memory");
  const mine = (listed.body?.items ?? []).filter((i) => i.content.includes(codename));
  for (const item of mine) await user.call("DELETE", `/api/v1/memory/${item.id}`);
  const after = await user.call("GET", "/api/v1/memory");
  const left = (after.body?.items ?? []).filter((i) => i.content.includes(codename)).length;
  return { status: mine.length > 0 && left === 0 ? PASS : FAIL, detail: `deleted ${mine.length} memory item(s) holding the codename; ${left} remain` };
});

// ---- RAG -------------------------------------------------------------------------------------

let documentId = null;

await check("RAG-INGEST", "Upload a document; it is parsed, chunked and embedded", async () => {
  const form = new FormData();
  form.append(
    "file",
    new Blob(
      [
        "Employee Handbook\n\nAn engineer receives 27 days of paid leave per calendar year.\n" +
          "Leave requests go to the people team at least two weeks in advance.\n\n" +
          "The on-call rotation is weekly and begins each Wednesday at 10:00 UTC.\n",
      ],
      { type: "text/plain" }
    ),
    "handbook.txt"
  );
  const res = await fetch(`${API}/api/v1/files/upload`, {
    method: "POST",
    headers: { cookie: user.cookie, "x-csrf-token": user.csrf, "x-project-id": user.projectId },
    body: form,
  });
  const body = await res.json();
  if (res.status !== 202 && res.status !== 201) return { status: FAIL, detail: `upload -> ${res.status}: ${JSON.stringify(body).slice(0, 160)}` };
  documentId = body.document.id;
  const doc = await waitFor(
    async () => {
      const r = await user.call("GET", `/api/v1/files/${documentId}`);
      if (r.body?.document?.status === "failed") throw new Error(`ingestion failed: ${r.body.document.errorMessage}`);
      return r.body?.document?.status === "ready" ? r.body.document : null;
    },
    { timeoutMs: 300_000, label: "ingestion" }
  );
  return { status: PASS, detail: `document ${doc.id.slice(0, 8)}… reached "ready" (scan: ${doc.scanStatus ?? "n/a"})` };
});

await check("RAG-ANSWER", "A grounded answer, with a real citation", async () => {
  const res = await user.call("POST", "/api/v1/rag/query", { question: "How many days of paid leave does an engineer receive?" });
  const b = res.body ?? {};
  const cited = (b.sources ?? []).some((s) => s.documentId === documentId && /27 days/.test(s.excerpt));
  const ok = res.status === 200 && b.grounded === true && b.outcome === "grounded" && /\b27\b/.test(b.answer ?? "") && /\[\d+\]/.test(b.answer ?? "") && cited;
  return {
    status: ok ? PASS : FAIL,
    detail: `grounded=${b.grounded} outcome=${b.outcome}; "${(b.answer ?? "").slice(0, 90)}"; ${b.sources?.length ?? 0} source(s), the handbook's excerpt cited: ${cited}`,
    evidence: b,
  };
});

await check("RAG-REFUSAL", "No evidence, no answer — and a refusal is never called grounded", async () => {
  const res = await user.call("POST", "/api/v1/rag/query", { question: "What is the company's policy on adopting a pet at the office?" });
  const b = res.body ?? {};
  const ok = res.status === 200 && b.grounded === false && (b.outcome === "refused" || b.outcome === "violation") && !/\bpet policy is\b/i.test(b.answer ?? "");
  return { status: ok ? PASS : FAIL, detail: `grounded=${b.grounded} outcome=${b.outcome}${b.groundingViolation ? ` (${b.groundingViolation})` : ""}; "${(b.answer ?? "").slice(0, 90)}"`, evidence: b };
});

// ---- media -----------------------------------------------------------------------------------

async function pollGeneration(path, key, timeoutMs) {
  return waitFor(
    async () => {
      const r = await user.call("GET", path);
      const g = r.body?.[key] ?? r.body;
      return ["succeeded", "failed", "cancelled"].includes(g?.status) ? g : null;
    },
    { timeoutMs, everyMs: 3_000, label: path }
  );
}

await check("IMAGE", "Generate a 512×512 image of a red apple on a wooden table", async () => {
  if (!providers?.image?.available) {
    return { status: BLOCKED, detail: "no image provider is configured on this deployment (GET /api/v1/providers: image unavailable) — see docs/MEDIA.md" };
  }
  if (providers.image.isMock) return { status: FAIL, detail: `the image provider is a MOCK (${providers.image.name}); a placeholder is not a generated image` };
  const t = Date.now();
  const created = await user.call("POST", "/api/v1/images", { prompt: "a red apple on a wooden table, photograph", aspectRatio: "1:1" });
  if (created.status !== 202 && created.status !== 201) return { status: FAIL, detail: `POST /images -> ${created.status}: ${created.text.slice(0, 160)}` };
  const id = created.body.generation?.id ?? created.body.id;
  const g = await pollGeneration(`/api/v1/images/${id}`, "generation", 30 * 60_000);
  if (g.status !== "succeeded") return { status: FAIL, detail: `generation ended ${g.status}: ${g.errorMessage}` };
  const file = await user.download(`/api/v1/assets/${g.resultAssetId}?projectId=${user.projectId}`);
  const png = inspectPng(file.bytes);
  const ok =
    file.status === 200 && png.ok && png.width >= 256 && png.height >= 256 && file.bytes.length > 20_000 && png.pixelsMeasured && png.luminanceStddev > 15 && png.distinctColours > 200;
  return {
    status: ok ? PASS : FAIL,
    detail:
      `${providers.image.name} in ${secondsSince(t)} s: ${file.contentType}, ${file.bytes.length} bytes, ${png.width}×${png.height}; ` +
      `luminance stddev ${png.luminanceStddev}, ${png.distinctColours} distinct colours, red-dominant pixels ${Math.round((png.reddishShare ?? 0) * 100)}%`,
    evidence: { png, bytes: file.bytes.length },
  };
});

await check("AUDIO", "Synthesise speech and play it back", async () => {
  if (!providers?.speech?.available) {
    return { status: BLOCKED, detail: "no speech provider is configured (GET /api/v1/providers: speech unavailable) — see docs/MEDIA.md" };
  }
  const t = Date.now();
  const created = await user.call("POST", "/api/v1/audio", { text: "This narration was generated on this machine, without a hosted service." });
  if (created.status !== 202 && created.status !== 201) return { status: FAIL, detail: `POST /audio -> ${created.status}: ${created.text.slice(0, 160)}` };
  const g = await pollGeneration(`/api/v1/audio/${created.body.generation.id}`, "generation", 10 * 60_000);
  if (g.status !== "succeeded") return { status: FAIL, detail: `synthesis ended ${g.status}: ${g.errorMessage}` };
  const file = await user.download(`/api/v1/assets/${g.resultAssetId}?projectId=${user.projectId}`);
  const wav = inspectWav(file.bytes);
  const ok = file.status === 200 && wav.ok && wav.durationSeconds > 1 && wav.rms > 0.01;
  return {
    status: ok ? PASS : FAIL,
    detail: `${g.providerName} in ${secondsSince(t)} s: ${file.contentType}, ${file.bytes.length} bytes, ${wav.sampleRate} Hz, ${wav.durationSeconds} s, RMS ${wav.rms} (0 = silence)`,
    evidence: { wav },
  };
});

await check("VIDEO", "Prompt → script → storyboard → narration → subtitles → visuals → MP4", async () => {
  if (!providers?.video?.available) {
    return { status: BLOCKED, detail: "no video provider is configured (GET /api/v1/providers: video unavailable) — it needs a real image provider plus ffmpeg, or a hosted video provider; see docs/MEDIA.md" };
  }
  if (providers.video.isMock) return { status: FAIL, detail: `the video provider is a MOCK (${providers.video.name}); a placeholder GIF is not a video` };
  const t = Date.now();
  const created = await user.call("POST", "/api/v1/videos", { prompt: "A short explainer about how bees make honey", targetDurationSeconds: 8, sceneClipSeconds: 4 });
  if (created.status !== 202 && created.status !== 201) return { status: FAIL, detail: `POST /videos -> ${created.status}: ${created.text.slice(0, 160)}` };
  const id = created.body.project?.id ?? created.body.id;
  const finalState = await waitFor(
    async () => {
      const r = await user.call("GET", `/api/v1/videos/${id}`);
      const p = r.body?.project;
      const settled = ["succeeded", "partially_succeeded", "failed"].includes(p?.status) && !["pending", "processing"].includes(p?.renderStatus);
      return settled ? r.body : null;
    },
    { timeoutMs: VIDEO_TIMEOUT_MS, everyMs: 5_000, label: "video" }
  );
  const p = finalState.project;
  const narrated = finalState.scenes.filter((s) => s.audioAssetId).length;
  if (p.renderStatus !== "succeeded" || !p.renderAssetId) {
    return { status: FAIL, detail: `project ${p.status}, render ${p.renderStatus}: ${p.renderError ?? p.errorMessage ?? "no render"}` };
  }
  const file = await user.download(`/api/v1/assets/${p.renderAssetId}?projectId=${user.projectId}`);
  const vtt = p.subtitleVttAssetId ? await user.download(`/api/v1/assets/${p.subtitleVttAssetId}?projectId=${user.projectId}`) : null;
  const probe = ffprobe(file.bytes, "mp4");
  const scriptLines = (p.script?.scenes ?? finalState.scenes).length;
  if (!probe) {
    return { status: BLOCKED, detail: `MP4 of ${file.bytes.length} bytes produced in ${secondsSince(t)} s, but ffprobe is not installed on the machine running this check, so its streams cannot be verified` };
  }
  const streams = probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`);
  const has = (type, codec) => probe.streams.some((s) => s.codec_type === type && (!codec || s.codec_name === codec));
  const duration = Number(probe.format.duration);
  const vttOk = vtt ? vtt.status === 200 && vtt.bytes.toString("utf8").startsWith("WEBVTT") && /-->/.test(vtt.bytes.toString("utf8")) : false;
  const ok = has("video", "h264") && has("audio", "aac") && has("subtitle") && duration >= 4 && vttOk && narrated > 0 && p.status === "succeeded";
  return {
    status: ok ? PASS : FAIL,
    detail:
      `${p.status} in ${secondsSince(t)} s: ${scriptLines} scene(s), ${narrated} narrated; MP4 ${file.bytes.length} bytes, ${duration.toFixed(1)} s, ` +
      `streams [${streams.join(", ")}]; WebVTT ${vttOk ? "valid" : "missing/invalid"}`,
    evidence: { probe, scenes: finalState.scenes.map((s) => ({ index: s.sceneIndex, status: s.status, narration: s.narration })) },
  };
});

// ---- the coding agent ------------------------------------------------------------------------

await check("CODING-AGENT", "The agent fixes the SOURCE so the test passes, and the fix is verified independently", async () => {
  const SOURCE = "function sum(a, b) {\n  return a - b;\n}\n\nmodule.exports = { sum };\n";
  const TEST =
    "const assert = require('node:assert');\nconst { sum } = require('./sum.js');\n" +
    "assert.strictEqual(sum(2, 3), 5);\nassert.strictEqual(sum(-1, 1), 0);\nconsole.log('ok');\n";
  for (const [path, content] of [["sum.js", SOURCE], ["sum.test.cjs", TEST]]) {
    const w = await user.call("POST", "/api/v1/workspace/files", { path, content });
    if (w.status !== 201) return { status: FAIL, detail: `writing ${path} -> ${w.status}` };
  }
  const t = Date.now();
  const created = await user.call("POST", "/api/v1/agent/tasks", { taskType: "fix_failing_test", input: { testFile: "sum.test.cjs" } });
  if (created.status !== 201 && created.status !== 202) return { status: FAIL, detail: `POST /agent/tasks -> ${created.status}: ${created.text.slice(0, 160)}` };
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

  // Independent verification: the files as the API serves them, the test run by THIS process.
  const dir = mkdtempSync(join(tmpdir(), "accept-coding-"));
  try {
    for (const f of ["sum.js", "sum.test.cjs"]) {
      const r = await user.call("GET", `/api/v1/workspace/file?path=${encodeURIComponent(f)}`);
      writeFileSync(join(dir, f), r.body?.content ?? r.body?.file?.content ?? "");
    }
    const testUntouched = readFileSync(join(dir, "sum.test.cjs"), "utf8") === TEST;
    const sourceChanged = readFileSync(join(dir, "sum.js"), "utf8") !== SOURCE;
    let independent = "not run";
    try {
      independent = execFileSync(process.execPath, ["sum.test.cjs"], { cwd: dir, timeout: 30_000 }).toString().trim() + " (exit 0)";
    } catch (err) {
      independent = `exit ${err.status}: ${String(err.stderr ?? "").split("\n")[0]}`;
    }
    const node = (final.nodes ?? [])[0] ?? {};
    const ok = final.task.state === "COMPLETED" && testUntouched && sourceChanged && independent.endsWith("(exit 0)");
    return {
      status: ok ? PASS : FAIL,
      detail:
        `task ${final.task.state} in ${secondsSince(t)} s${node.errorMessage ? ` (${node.errorMessage.slice(0, 80)})` : ""}; ` +
        `source changed: ${sourceChanged}; test file untouched: ${testUntouched}; independent run: ${independent}`,
      evidence: { task: final.task, source: readFileSync(join(dir, "sum.js"), "utf8") },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- accounting, audit, isolation --------------------------------------------------------------

await check("USAGE", "Tokens spent are metered", async () => {
  const res = await user.call("GET", "/api/v1/usage");
  const tokens = res.body?.projectUsage?.llm?.tokensToday ?? 0;
  return { status: res.status === 200 && tokens > 0 ? PASS : FAIL, detail: `this project spent ${tokens} tokens today across the calls above (scope ${res.body?.usageScope})` };
});

await check("AUDIT", "Security-relevant actions are in the audit trail", async () => {
  const res = await user.call("GET", "/api/v1/audit");
  const entries = res.body?.entries ?? [];
  const actions = [...new Set(entries.map((e) => e.action))];
  const hasLogin = actions.some((a) => /login/.test(a));
  const hasTool = actions.some((a) => /tool/.test(a));
  return {
    status: res.status === 200 && hasLogin && (hasTool || !passed("CODING-AGENT")) ? PASS : FAIL,
    detail: `${entries.length} entries; actions: ${actions.slice(0, 8).join(", ")}`,
  };
});

await check("TENANT-ISOLATION", "Another tenant cannot read this one's data", async () => {
  const other = new Client("intruder");
  await other.signUp("journey-intruder");
  const probes = [
    ["GET", `/api/v1/conversations/${chatConversationId}/messages`],
    ["GET", `/api/v1/files/${documentId}`],
    ["GET", `/api/v1/workspace/file?path=sum.js`],
  ];
  const codes = [];
  for (const [method, path] of probes) {
    // The intruder names the victim's project explicitly — the strongest form of the attempt.
    const r = await other.call(method, path, undefined, { headers: { "x-project-id": user.projectId } });
    codes.push(r.status);
  }
  const ownWorkspace = await other.call("GET", "/api/v1/workspace/file?path=sum.js");
  return {
    status: codes.every((c) => c === 404 || c === 403) && ownWorkspace.status === 404 ? PASS : FAIL,
    detail: `victim's conversation, document and workspace file -> ${codes.join(", ")}; the intruder's own workspace has no sum.js -> ${ownWorkspace.status}`,
  };
});

await check("METRICS", "Prometheus metrics carry real values", async () => {
  const email = process.env.ACCEPT_ADMIN_EMAIL;
  if (!email) return { status: BLOCKED, detail: "ACCEPT_ADMIN_EMAIL/ACCEPT_ADMIN_PASSWORD not supplied to this run, so the admin-only metrics endpoint cannot be read" };
  const admin = new Client("admin");
  await admin.login(email, process.env.ACCEPT_ADMIN_PASSWORD);
  const res = await admin.raw("GET", "/api/v1/admin/metrics", undefined, { headers: { "x-project-id": "" } });
  const text = await res.text();
  const sample = (name) =>
    text
      .split("\n")
      .filter((l) => l.startsWith(name) && !l.startsWith("#"))
      .reduce((n, l) => n + Number(l.split(" ").at(-1) || 0), 0);
  const requests = sample("http_requests_total") || sample("http_server_requests_total") || sample("api_http_requests_total");
  const llmCalls = sample("llm_provider_calls_total") || sample("provider_calls_total") || sample("llm_request_duration_seconds_count");
  return {
    status: res.status === 200 && text.length > 0 && requests > 0 ? PASS : FAIL,
    detail: `${res.status}, ${text.split("\n").filter((l) => l && !l.startsWith("#")).length} samples; HTTP requests counted: ${requests}; model calls counted: ${llmCalls}`,
  };
});

await check("PERSISTENCE", "Log out, log back in: everything is still there", async () => {
  await user.call("POST", "/api/v1/auth/logout");
  await user.login(user.email, password);
  const conversations = await user.call("GET", "/api/v1/conversations", undefined, { headers: { "x-project-id": user.projectId } });
  const doc = documentId ? await user.call("GET", `/api/v1/files/${documentId}`) : { status: 0 };
  const count = conversations.body?.conversations?.length ?? 0;
  return {
    status: count >= 2 && doc.status === 200 ? PASS : FAIL,
    detail: `after a fresh login: ${count} conversation(s) in the project; the handbook -> ${doc.status}`,
  };
});

await check("RATE-LIMIT", "A route's limit is enforced and says when to retry", async () => {
  let limited = null;
  for (let i = 0; i < 45 && !limited; i++) {
    const r = await user.call("POST", "/api/v1/rag/query", { question: `probe ${i}`, retrieveOnly: true });
    if (r.status === 429) limited = r;
  }
  if (!limited) return { status: FAIL, detail: "45 rapid requests to a 30/min route were all accepted" };
  return {
    status: limited.body?.error?.code === "RATE_LIMITED" && limited.headers.get("retry-after") ? PASS : FAIL,
    detail: `429 ${limited.body?.error?.code}; retry-after ${limited.headers.get("retry-after")} s; limit ${limited.headers.get("x-ratelimit-limit")}`,
  };
});

finish();

function finish() {
  const counts = { PASS: 0, FAIL: 0, BLOCKED_EXTERNAL: 0 };
  for (const r of results) counts[r.status]++;
  const summary = {
    api: API,
    startedAt: new Date(started).toISOString(),
    seconds: secondsSince(started),
    counts,
    results,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "full-system.json"), JSON.stringify(summary, null, 2));
  const md = [
    `# Full-system acceptance`,
    ``,
    `- API: \`${API}\``,
    `- Started: ${summary.startedAt}, ${summary.seconds} s`,
    `- **${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.BLOCKED_EXTERNAL} BLOCKED_EXTERNAL**`,
    ``,
    `| Check | Status | Seconds | Measurement |`,
    `|---|---|---|---|`,
    ...results.map((r) => `| ${r.id} — ${r.title} | ${r.status} | ${r.seconds} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    ``,
  ].join("\n");
  writeFileSync(join(OUT, "full-system.md"), md);
  console.log(`\n  ${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.BLOCKED_EXTERNAL} BLOCKED_EXTERNAL in ${summary.seconds} s`);
  console.log(`  results: ${join(OUT, "full-system.json")} and full-system.md\n`);
  process.exitCode = counts.FAIL === 0 ? 0 : 1;
}
