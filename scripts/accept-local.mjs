#!/usr/bin/env node
/**
 * `npm run accept:local` — the core platform, against a running backend.
 *
 * Auth, permissions, chat, streaming, memory, RAG, usage, quotas, multi-tenancy. Each check
 * drives the real HTTP API and asserts on what came back, including how it arrived: the
 * streaming check measures the spread between the first and last token, because a response
 * that arrives in one chunk at the end is a different product from a streamed one and the
 * final text cannot tell them apart.
 *
 *   cd backend && npm run dev          # in another terminal
 *   npm run accept:local
 *
 * Point it elsewhere with ACCEPT_API_URL. Set ACCEPT_JSON=1 for machine-readable output.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Report, requireRunningApi, waitFor, providers, API } from "./lib/acceptance.mjs";

await requireRunningApi();
const report = new Report("Local acceptance — core platform");
const alice = new Client("alice");

// ---- identity -----------------------------------------------------------------------------

await report.check("AUTH", async () => {
  const me = await alice.signUp("accept-local");
  return {
    ok: Boolean(alice.projectId) && alice.role === "admin",
    detail: `signed up ${alice.email.split("@")[0]}, project ${alice.projectId.slice(0, 8)}…, role ${alice.role}`,
  };
});

await report.check("PERMISSIONS", async () => {
  // ADR-148: the browser is told what the caller may do, so the UI can hide what it may not.
  // A UI that has to guess either offers controls that 403, or hides controls that would work.
  const perms = alice.permissions ?? [];
  return {
    ok: perms.length > 0 && perms.includes("agent:approve"),
    detail: `GET /auth/me returns ${perms.length} effective permission(s): ${perms.slice(0, 4).join(", ")}…`,
  };
});

await report.check("SESSION", async () => {
  // A session that cannot be ended is not a session. Logout must invalidate the token server
  // side, not merely clear a cookie the client could keep using.
  const stolen = alice.cookie;
  const out = await alice.call("POST", "/api/v1/auth/logout");
  const replay = await fetch(`${API}/api/v1/auth/me`, { headers: { cookie: stolen } });
  const back = await alice.call("POST", "/api/v1/auth/login", {
    email: alice.email,
    password: "a-sufficiently-long-password",
  });
  const me = await alice.call("GET", "/api/v1/auth/me");
  alice.projectId = me.body?.projects?.[0]?.id ?? alice.projectId;
  return {
    ok: out.status === 200 && replay.status === 401 && back.status === 200 && me.status === 200,
    detail: `logout ${out.status}, the old cookie replayed -> ${replay.status} (401 = revoked server-side), login back in ${back.status}`,
  };
});

// ---- what is actually running ---------------------------------------------------------------

const running = await providers(alice);
if (running) {
  const chat = running.chat?.find((c) => !c.isMock) ?? running.chat?.[0];
  console.log(
    `  ${" ".repeat(6)}running: chat ${chat?.name}/${chat?.model}${chat?.isMock ? " (MOCK)" : ""}` +
      `, embeddings ${running.embeddings?.model}${running.embeddings?.semantic === false ? " (lexical fallback)" : ""}` +
      `, image ${running.image?.name}${running.image?.isMock ? " (MOCK)" : ""}`
  );
}
const mockChat = running?.chat?.every((c) => c.isMock) ?? false;

// ---- chat ------------------------------------------------------------------------------------

let conversationId;

await report.check("CHAT", async () => {
  const res = await alice.stream("/api/v1/chat", {
    messages: [{ role: "user", content: "In one short sentence, what is a unit test?" }],
  });
  const done = res.events.find((e) => e.type === "done");
  conversationId = res.events.find((e) => e.conversationId)?.conversationId;
  const answer = done?.message?.content ?? "";
  return {
    ok: res.status === 200 && Boolean(done) && answer.trim().length > 10,
    detail: `${done?.provider}/${done?.model} answered in ${res.totalMs}ms, ${done?.usage?.inputTokens} in / ${done?.usage?.outputTokens} out: "${answer.slice(0, 70).replace(/\s+/g, " ")}…"`,
  };
});

await report.check("STREAMING", async () => {
  const res = await alice.stream("/api/v1/chat", {
    messages: [{ role: "user", content: "Count from one to ten, one number per line." }],
  });
  const tokens = res.events.filter((e) => e.type === "token");
  const done = res.events.find((e) => e.type === "done");
  const spread = tokens.length > 1 ? tokens[tokens.length - 1].at - tokens[0].at : 0;
  // The load-bearing assertion. A buffered response delivers every token at the same instant.
  return {
    ok: tokens.length > 1 && spread > 50 && tokens[0].at < (done?.at ?? Infinity) - 50,
    detail: `${tokens.length} token events, first at ${tokens[0]?.at}ms, last at ${tokens[tokens.length - 1]?.at}ms (spread ${spread}ms — progressive, not one chunk at the end)`,
  };
});

await report.check("MULTI-TURN", async () => {
  // The second turn must see the first. A conversation that forgets its own last message is the
  // most common way a chat API is wrong while every single-turn test passes.
  const first = await alice.stream("/api/v1/chat", {
    ...(conversationId ? { conversationId } : {}),
    messages: [{ role: "user", content: "My favourite colour is vermilion. Reply with just: noted." }],
  });
  const cid = first.events.find((e) => e.conversationId)?.conversationId ?? conversationId;
  const second = await alice.stream("/api/v1/chat", {
    conversationId: cid,
    messages: [{ role: "user", content: "What is my favourite colour? One word." }],
  });
  const answer = second.events.find((e) => e.type === "done")?.message?.content ?? "";
  const stored = await alice.call("GET", `/api/v1/conversations/${cid}/messages`);
  const count = (stored.body?.messages ?? []).length;
  return {
    ok: /vermilion/i.test(answer) || mockChat,
    detail: mockChat
      ? `skipped semantic check: the mock provider is answering. ${count} messages persisted in the conversation`
      : `a follow-up turn answered "${answer.trim().slice(0, 40)}" — ${count} messages persisted`,
  };
});

await report.check("CANCELLATION", async () => {
  // An abandoned stream must stop the provider call, not leave it running and billed.
  const controller = new AbortController();
  const started = Date.now();
  const promise = fetch(`${API}/api/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: alice.cookie,
      "x-csrf-token": alice.csrf,
      "x-project-id": alice.projectId,
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "Write a very long essay about the sea." }] }),
    signal: controller.signal,
  });
  await new Promise((r) => setTimeout(r, 800));
  controller.abort();
  let aborted = false;
  try {
    const res = await promise;
    await res.text();
  } catch {
    aborted = true;
  }
  // The platform must still be answering afterwards: a cancelled stream that wedges the server
  // is worse than one that runs to completion.
  const alive = await alice.call("GET", "/api/v1/auth/me");
  return {
    ok: aborted && alive.status === 200,
    detail: `client aborted after ${Date.now() - started}ms; the API still answered /auth/me with ${alive.status}`,
  };
});

// ---- memory ------------------------------------------------------------------------------------

await report.check("MEMORY", async () => {
  // A unique fact, so no amount of model general knowledge can produce the answer.
  const codename = `NIGHTHAWK-${Math.floor(Math.random() * 1e6)}`;
  const stored = await alice.call("POST", "/api/v1/memory", {
    scope: "user",
    content: `The user's preferred project codename is ${codename}.`,
  });
  if (stored.status !== 201) return { ok: false, detail: `POST /memory -> ${stored.status}: ${stored.text.slice(0, 120)}` };

  // A NEW conversation: no conversationId, so nothing but retrieval can carry the fact across.
  const recall = await alice.stream("/api/v1/chat", {
    messages: [{ role: "user", content: "What project codename did I ask you to remember? Reply with just the codename." }],
  });
  const answer = recall.events.find((e) => e.type === "done")?.message?.content ?? "";
  const listed = await alice.call("GET", "/api/v1/memory?scope=user");
  const held = (listed.body?.items ?? []).some((i) => i.content.includes(codename));
  return {
    ok: mockChat ? held : answer.includes(codename),
    detail: mockChat
      ? `skipped semantic check (mock provider); the fact is stored and listed: ${held}`
      : `stored "${codename}", and a NEW conversation answered "${answer.trim().slice(0, 40)}"`,
  };
});

// ---- RAG -----------------------------------------------------------------------------------------

const workspace = join(process.cwd(), process.env.SANDBOX_ROOT ?? "data/sandbox", alice.projectId);

await report.check("RAG-INGEST", async () => {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, "handbook.txt"),
    [
      "ACME ENGINEERING HANDBOOK",
      "",
      "Vacation policy: every engineer receives 27 days of paid leave per calendar year.",
      "Requests go through the people team at least two weeks in advance.",
      "",
      "On-call: the rotation is weekly and begins on Wednesday at 10:00 UTC.",
    ].join("\n")
  );
  const ingest = await alice.call("POST", "/api/v1/files", { path: "handbook.txt" });
  if (ingest.status !== 202 && ingest.status !== 201) {
    return { ok: false, detail: `POST /files -> ${ingest.status}: ${ingest.text.slice(0, 160)}` };
  }
  const id = ingest.body.document.id;
  const doc = await waitFor(
    async () => {
      const r = await alice.call("GET", `/api/v1/files/${id}`);
      if (r.body?.document?.status === "failed") throw new Error(`ingest failed: ${r.body.document.errorMessage}`);
      return r.body?.document?.status === "ready" ? r.body.document : null;
    },
    { label: "ingestion", timeoutMs: 180_000 }
  );
  return { ok: true, detail: `document ${doc.id.slice(0, 8)}… parsed, chunked and embedded` };
});

await report.check("RAG-ANSWER", async () => {
  const res = await alice.call("POST", "/api/v1/rag/query", {
    question: "How many days of paid leave does an engineer get?",
  });
  const sources = res.body?.sources ?? [];
  const answer = String(res.body?.answer ?? "");
  const grounded = res.body?.grounded === true;
  return {
    // The number must be in the answer AND a real source must back it. Either alone is the
    // failure mode: a number with no evidence is a guess, evidence with no number is "[1]".
    ok: res.status === 200 && grounded && sources.length > 0 && (mockChat || /27/.test(answer)),
    detail: `grounded=${grounded}, ${sources.length} source(s) (${sources.map((s) => `${s.filename}#${s.chunkIndex} d=${s.distance}`).join(", ")}): "${answer.slice(0, 80).replace(/\s+/g, " ")}"`,
  };
});

await report.check("RAG-REFUSAL", async () => {
  const res = await alice.call("POST", "/api/v1/rag/query", {
    question: "What is the company policy on submarine maintenance?",
  });
  const answer = String(res.body?.answer ?? "");
  const refused = /do not contain|does not contain|no information|cannot answer|not mention/i.test(answer);
  return {
    ok: refused,
    detail: `retrieved ${res.body?.retrievedCount ?? res.body?.sources?.length ?? 0}, answered "${answer.slice(0, 90).replace(/\s+/g, " ")}"`,
  };
});

await report.check("RAG-CITATION", async () => {
  // ADR-161. A bare marker is not an answer, and the endpoint must not call it grounded.
  // Asserted through the contract rather than by forcing the model: whatever the model said,
  // an answer that survives as `grounded` must carry something besides its citations.
  const res = await alice.call("POST", "/api/v1/rag/query", { question: "When does the on-call rotation begin?" });
  const answer = String(res.body?.answer ?? "");
  const withoutMarkers = answer.replace(/\[\d+\]/g, "").replace(/[\s.,;:!?'"()-]/g, "");
  const ok = res.body?.grounded === false || withoutMarkers.length > 0;
  return {
    ok,
    detail: res.body?.grounded
      ? `grounded answer carries ${withoutMarkers.length} characters besides its citation markers`
      : `not grounded, and said so: violation=${res.body?.groundingViolation}`,
  };
});

// ---- accounting ----------------------------------------------------------------------------------

await report.check("USAGE", async () => {
  const res = await alice.call("GET", "/api/v1/usage");
  const records = res.body?.records ?? res.body?.items ?? [];
  const kinds = [...new Set(records.map((r) => r.kind))];
  const llm = records.filter((r) => r.kind === "llm");
  return {
    ok: res.status === 200 && llm.length > 0,
    detail: `${records.length} ledger row(s) across ${kinds.join(", ") || "(none)"} — ${llm.length} model call(s) recorded for the chat turns above`,
  };
});

await report.check("RATE-LIMIT", async () => {
  // Proven by exhausting a real limit, not by reading a config value.
  let limited;
  for (let i = 0; i < 40 && !limited; i++) {
    const res = await alice.call("POST", "/api/v1/rag/query", { question: `probe ${i}`, retrieveOnly: true });
    if (res.status === 429) limited = res;
  }
  if (!limited) return { ok: false, detail: "40 rapid requests to a 30/min endpoint were all accepted" };
  const body = limited.body?.error ?? {};
  return {
    ok: limited.status === 429 && body.code === "RATE_LIMITED",
    detail: `429 after the documented window; code=${body.code}, retry-after=${limited.headers.get("retry-after")}s, limit=${limited.headers.get("x-ratelimit-limit")}`,
  };
});

// ---- tenancy ---------------------------------------------------------------------------------------

await report.check("TENANT-ISOLATION", async () => {
  const bob = new Client("bob");
  await bob.signUp("accept-local-bob");
  // Bob names Alice's project explicitly. ADR-089: 404, never 403 — a distinguishable 403 would
  // confirm the project exists, which is itself a disclosure.
  const files = await bob.call("GET", "/api/v1/files", undefined, { headers: { "x-project-id": alice.projectId } });
  const chat = await bob.call("POST", "/api/v1/rag/query", { question: "anything" }, {
    headers: { "x-project-id": alice.projectId },
  });
  return {
    ok: files.status === 404 && chat.status === 404,
    detail: `a second tenant naming the first's project id got ${files.status} on /files and ${chat.status} on /rag/query (404 expected, never 403)`,
  };
});

report.finish();
