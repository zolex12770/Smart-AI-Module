#!/usr/bin/env node
/**
 * The product, driven through a REAL browser against a RUNNING stack with real providers.
 *
 *   WEB_URL=http://localhost:3000 node scripts/acceptance/browser.mjs
 *
 * `full-system.mjs` proves the API; this proves what a person sees. Each check asserts on the
 * rendered page — text growing while it streams, an <img> the browser actually decoded, an
 * <audio>/<video> element whose media the browser loaded and measured — and on the browser's own
 * console and network log, which is where a CORS or cookie defect shows up and nowhere else.
 *
 * Environment:
 *   WEB_URL                    the web app (default http://localhost:3000)
 *   PLAYWRIGHT_CHROMIUM_PATH   a Chromium to use instead of Playwright's download
 *   BROWSER_ONLY               comma-separated check ids
 *   BROWSER_SKIP_MEDIA=1       skip IMAGE/AUDIO/VIDEO (they take minutes on a CPU)
 *   ACCEPT_OUT                 where browser.json / browser.md go (default ./acceptance-results)
 *
 * Every result is PASS, FAIL or BLOCKED_EXTERNAL (a capability the deployment does not offer).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const WEB = (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");
const OUT = process.env.ACCEPT_OUT ?? "acceptance-results";
const only = process.env.BROWSER_ONLY ? new Set(process.env.BROWSER_ONLY.split(",").map((s) => s.trim())) : null;
const skipMedia = process.env.BROWSER_SKIP_MEDIA === "1";
const PASS = "PASS";
const FAIL = "FAIL";
const BLOCKED = "BLOCKED_EXTERNAL";
const results = [];
const started = Date.now();

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}
);
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

/** Everything the browser itself complains about, attributed to the check that caused it. */
let consoleErrors = [];
let failedResponses = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("response", (r) => {
  if (r.status() >= 400) failedResponses.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
});
/** Failures that are part of normal operation and say nothing about a defect. */
const EXPECTED = [/^401 GET \/api\/v1\/auth\/me$/];
const unexpected = () => failedResponses.filter((f) => !EXPECTED.some((re) => re.test(f)));

async function check(id, title, fn) {
  if (only && !only.has(id)) return;
  consoleErrors = [];
  failedResponses = [];
  const t = Date.now();
  let result;
  try {
    result = await fn();
  } catch (error) {
    result = { status: FAIL, detail: `threw: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
    await page.screenshot({ path: join(OUT, `browser-${id}.png`), fullPage: true }).catch(() => {});
  }
  const bad = unexpected();
  // Console errors that are only the expected 401 above are the same event seen twice.
  const errors = consoleErrors.filter((e) => !/status of 401/.test(e) || bad.some((b) => b.startsWith("401")));
  if (result.status === PASS && (bad.length || errors.length)) {
    result = { status: FAIL, detail: `${result.detail}; but the browser logged: ${[...bad, ...errors].slice(0, 4).join(" | ")}` };
  }
  const entry = { id, title, status: result.status, seconds: Math.round((Date.now() - t) / 100) / 10, detail: result.detail };
  results.push(entry);
  console.log(`  ${entry.status.padEnd(16)} ${id.padEnd(18)} ${entry.detail}`);
}

const waitForText = async (locator, re, timeout) => {
  await locator.filter({ hasText: re }).first().waitFor({ timeout });
  return (await locator.filter({ hasText: re }).first().textContent())?.trim() ?? "";
};

mkdirSync(OUT, { recursive: true });
console.log(`\nBrowser acceptance\n------------------\n  web: ${WEB}\n`);

const email = `browser-${Date.now()}@example.com`;
const password = "a-sufficiently-long-password";

await check("SIGNUP", "Sign up in the browser", async () => {
  await page.goto(`${WEB}/signup`);
  await page.getByLabel("Name").fill("Browser Acceptance");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/chat", { timeout: 60_000 });
  return { status: PASS, detail: `signed up ${email}, landed on /chat` };
});

const assistant = () => page.locator(".message.assistant").last();

await check("CHAT-STREAMING", "The answer is rendered progressively, not all at once", async () => {
  // The header is filled from /api/v1/models after the page renders; give it a moment.
  await page.locator(".chat-header").filter({ hasText: /Answers come from|No language model/ }).waitFor({ timeout: 15_000 }).catch(() => {});
  const header = (await page.locator(".chat-header").textContent())?.replace(/\s+/g, " ").trim() ?? "";
  await page.getByPlaceholder(/say something/i).fill("In five short sentences, explain how a lighthouse works.");
  await page.getByRole("button", { name: /^send$/i }).click();
  // Sample the rendered text while it streams: a transport that delivers everything at the end
  // produces one jump from nothing to the whole answer.
  const lengths = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    const text = ((await assistant().textContent()) ?? "").replace("…", "").trim();
    if (lengths.at(-1) !== text.length) lengths.push(text.length);
    const sending = await page.getByRole("button", { name: /^send$/i }).isVisible().catch(() => false);
    if (sending && text.length > 0) break;
    await page.waitForTimeout(150);
  }
  const growth = lengths.filter((n) => n > 0);
  const final = ((await assistant().textContent()) ?? "").trim();
  const ok = growth.length >= 5 && growth.at(-1) === final.length && final.length > 80 && /Answers come from/.test(header);
  return {
    status: ok ? PASS : FAIL,
    detail: `${growth.length} distinct rendered lengths while streaming (${growth.slice(0, 6).join(", ")}…${growth.at(-1)}); header "${header.slice(0, 60)}"; answer ${final.length} chars`,
  };
});

await check("CHAT-MULTI-TURN", "A second message continues the same conversation, and survives a reload", async () => {
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const url = page.url();
  await page.getByPlaceholder(/say something/i).fill("Now say that in one sentence.");
  await page.getByRole("button", { name: /^send$/i }).click();
  await page.getByRole("button", { name: /^send$/i }).waitFor({ timeout: 180_000 });
  await page.waitForTimeout(500);
  const before = await page.locator(".message").count();
  await page.reload();
  await page.locator(".message.assistant").nth(1).waitFor({ timeout: 30_000 });
  const after = await page.locator(".message").count();
  return { status: before === 4 && after === 4 && page.url() === url ? PASS : FAIL, detail: `${before} messages before reload, ${after} after, same URL: ${page.url() === url}` };
});

await check("CHAT-CANCEL", "Stop ends the stream, and the next message still works", async () => {
  await page.getByRole("link", { name: /new chat/i }).click();
  await page.waitForURL(`${WEB}/chat`);
  await page.getByPlaceholder(/say something/i).fill("List forty facts about the ocean, one per line, numbered.");
  await page.getByRole("button", { name: /^send$/i }).click();
  await assistant().filter({ hasText: /\w{3}/ }).waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: /^stop$/i }).click();
  const atStop = ((await assistant().textContent()) ?? "").length;
  await page.waitForTimeout(3_000);
  const later = ((await assistant().textContent()) ?? "").length;
  const sendBack = await page.getByRole("button", { name: /^send$/i }).isVisible();
  // Another message after a stop must work: a stuck controller would leave the page unusable.
  await page.getByPlaceholder(/say something/i).fill("Reply with just the word: ready");
  await page.getByRole("button", { name: /^send$/i }).click();
  const next = await waitForText(page.locator(".message.assistant").last(), /ready/i, 120_000).catch(() => "");
  const ok = sendBack && later - atStop < 40 && /ready/i.test(next);
  return { status: ok ? PASS : FAIL, detail: `stopped at ${atStop} chars, ${later} three seconds later; Send back: ${sendBack}; next answer "${next.slice(0, 30)}"` };
});

await check("MEMORY-UI", "A memory filed on the Memory screen is used by a new conversation", async () => {
  const colour = `teal-${Math.floor(Math.random() * 900 + 100)}`;
  await page.goto(`${WEB}/memory`);
  await page.getByLabel(/remember something/i).fill(`My favourite colour is ${colour}.`);
  await page.getByRole("button", { name: /^remember$/i }).click();
  await page.getByText(colour).first().waitFor({ timeout: 30_000 });
  await page.goto(`${WEB}/chat`);
  await page.getByPlaceholder(/say something/i).fill("What is my favourite colour? Reply with just the colour.");
  await page.getByRole("button", { name: /^send$/i }).click();
  const answer = await waitForText(assistant(), new RegExp(colour), 120_000).catch(async () => (await assistant().textContent()) ?? "");
  return { status: answer.includes(colour) ? PASS : FAIL, detail: `filed "${colour}" on /memory; a new chat answered "${answer.trim().slice(0, 40)}"` };
});

await check("RAG-UI", "Upload a document, ask, see the cited passage; an unanswerable question is refused", async () => {
  await page.goto(`${WEB}/files`);
  const handbook =
    "Harbour Works staff handbook.\n\nEvery diver must log a buddy check before entering the water. " +
    "The night shift at the north pier starts at 22:00 and ends at 06:00. Engineers receive 27 days of paid leave per calendar year.\n";
  await page.locator('input[type="file"]').setInputFiles({ name: "harbour-handbook.txt", mimeType: "text/plain", buffer: Buffer.from(handbook) });
  await page.getByRole("button", { name: /^upload$/i }).click();
  await page.getByText(/harbour-handbook\.txt/).first().waitFor({ timeout: 30_000 });
  await page.getByText(/ready/i).first().waitFor({ timeout: 180_000 });
  await page.goto(`${WEB}/ask`);
  await page.getByLabel(/question/i).fill("When does the night shift at the north pier start?");
  await page.getByRole("button", { name: /^ask$/i }).click();
  const main = page.locator("main");
  await main.getByText(/22:00/).first().waitFor({ timeout: 180_000 });
  const cited = await main.getByText(/harbour-handbook\.txt/).count();
  await page.getByLabel(/question/i).fill("What is the capital city of Mongolia?");
  await page.getByRole("button", { name: /^ask$/i }).click();
  const refusal = await main.getByRole("status").filter({ hasText: /do not answer|do not contain|no evidence|could not find/i }).first().textContent({ timeout: 180_000 }).catch(() => "");
  return {
    status: cited > 0 && refusal ? PASS : FAIL,
    detail: `answered with "22:00", source shown: ${cited > 0}; unanswerable question refused: "${(refusal ?? "").trim().slice(0, 60)}"`,
  };
});

async function mediaAvailable(kind) {
  const r = await page.request.get(`${new URL(WEB).protocol}//${new URL(WEB).hostname}:8787/api/v1/providers`).catch(() => null);
  if (!r || !r.ok()) return null;
  return (await r.json()).providers?.[kind]?.available ?? false;
}

await check("IMAGE-UI", "Generate an image and see the browser decode it", async () => {
  if (skipMedia) return { status: BLOCKED, detail: "BROWSER_SKIP_MEDIA=1" };
  await page.goto(`${WEB}/images`);
  if (await page.getByText(/not configured on this deployment/i).count()) return { status: BLOCKED, detail: "no image provider configured" };
  await page.getByPlaceholder("a lighthouse at dawn").fill("a red kite flying over a green hill, clear sky");
  await page.getByRole("button", { name: /^generate$/i }).click();
  const img = page.locator("main img").first();
  await img.waitFor({ timeout: 1_200_000 });
  await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 60_000 });
  const size = await img.evaluate((el) => `${el.naturalWidth}×${el.naturalHeight}`);
  const download = await page.locator("main a[download]").count();
  return { status: PASS, detail: `the browser decoded the generated image: ${size}; download links: ${download}` };
});

await check("AUDIO-UI", "Generate speech and let the browser load and measure it", async () => {
  if (skipMedia) return { status: BLOCKED, detail: "BROWSER_SKIP_MEDIA=1" };
  await page.goto(`${WEB}/audio`);
  if (await page.getByText(/not configured/i).count()) return { status: BLOCKED, detail: "no speech provider configured" };
  await page.getByPlaceholder(/quick brown fox/i).fill("Welcome to the harbour. The tide turns at noon.");
  await page.getByRole("button", { name: /generate speech/i }).click();
  const audio = page.locator("main audio").first();
  await audio.waitFor({ timeout: 300_000 });
  const duration = await audio.evaluate(
    (el) =>
      new Promise((resolve) => {
        if (el.readyState >= 1) return resolve(el.duration);
        el.addEventListener("loadedmetadata", () => resolve(el.duration), { once: true });
        el.addEventListener("error", () => resolve(-1), { once: true });
        el.load();
      })
  );
  return { status: duration > 1 ? PASS : FAIL, detail: `the browser loaded the audio: ${Number(duration).toFixed(2)} s` };
});

await check("VIDEO-UI", "Generate a short video and let the browser load it, with its subtitle track", async () => {
  if (skipMedia) return { status: BLOCKED, detail: "BROWSER_SKIP_MEDIA=1" };
  await page.goto(`${WEB}/videos`);
  if (await page.getByText(/not configured/i).count()) return { status: BLOCKED, detail: "no video provider configured" };
  await page.getByPlaceholder("a lighthouse in a storm").fill("a paper boat sailing down a rainy street");
  const numbers = page.locator('main input[type="number"]');
  await numbers.nth(0).fill("8");
  await numbers.nth(1).fill("4");
  await page.getByRole("button", { name: /^generate$/i }).click();
  await page.locator("main a[href^='/videos/']").first().click();
  const video = page.locator("main video").first();
  await video.waitFor({ timeout: 2_400_000 });
  const info = await video.evaluate(
    (el) =>
      new Promise((resolve) => {
        // Which rendition the browser chose (DL-19), and proof a frame was decoded, not just a
        // header read. A <source> that cannot play fires `error` on itself; the last one failing
        // means the element has nothing left to try.
        const describe = (extra) => ({
          duration: el.duration,
          width: el.videoWidth,
          tracks: el.querySelectorAll("track").length,
          type: [...el.querySelectorAll("source")].find((s) => s.src === el.currentSrc)?.type ?? "",
          mp4: el.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
          ...extra,
        });
        const fail = () => resolve(describe({ duration: -1, width: 0, decoded: false }));
        el.addEventListener("loadeddata", () => resolve(describe({ decoded: el.readyState >= 2 })), { once: true });
        el.addEventListener("error", fail, { once: true });
        const sources = el.querySelectorAll("source");
        if (sources.length) sources[sources.length - 1].addEventListener("error", fail, { once: true });
        el.load();
      })
  );
  const narrated = await page.locator("main audio").count();
  const ok = info.decoded && info.duration >= 4 && info.width > 0 && info.tracks > 0 && narrated > 0;
  return {
    status: ok ? PASS : FAIL,
    detail:
      `the browser decoded the render (${info.type || "no source it could play"}; its H.264 support: "${info.mp4}"): ` +
      `${Number(info.duration).toFixed(1)} s, ${info.width}px wide, ${info.tracks} subtitle track(s); ${narrated} narration player(s)`,
  };
});

const ROUTES = ["/", "/chat", "/tasks", "/ask", "/files", "/memory", "/images", "/audio", "/videos", "/usage", "/platform", "/settings"];
await check("ROUTES", "Every screen renders without a browser error", async () => {
  const problems = [];
  for (const route of ROUTES) {
    consoleErrors = [];
    failedResponses = [];
    await page.goto(`${WEB}${route}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    const main = ((await page.locator("main").textContent().catch(() => "")) ?? "").trim();
    const issues = [...unexpected(), ...consoleErrors.filter((e) => !/status of 401/.test(e))];
    if (issues.length) problems.push(`${route}: ${issues.slice(0, 2).join(" | ")}`);
    if (main.length < 20) problems.push(`${route}: renders almost nothing (${main.length} chars)`);
    if (/\bTODO\b|lorem ipsum|coming soon/i.test(main)) problems.push(`${route}: placeholder text`);
  }
  consoleErrors = [];
  failedResponses = [];
  return { status: problems.length ? FAIL : PASS, detail: problems.length ? problems.join("; ") : `${ROUTES.length} screens, no browser errors, no placeholders` };
});

await check("LOGOUT-LOGIN", "Sign out, sign back in, and the conversations are still there", async () => {
  await page.goto(`${WEB}/chat`);
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/chat/, { timeout: 30_000 });
  // The sidebar is fetched after the page renders.
  await page.locator(".chat-sidebar-item").first().waitFor({ timeout: 30_000 }).catch(() => {});
  const conversations = await page.locator(".chat-sidebar-item").count();
  return { status: conversations >= 3 ? PASS : FAIL, detail: `${conversations} conversation(s) listed after signing back in` };
});

await browser.close();
const counts = { PASS: 0, FAIL: 0, BLOCKED_EXTERNAL: 0 };
for (const r of results) counts[r.status]++;
const summary = `${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.BLOCKED_EXTERNAL} BLOCKED_EXTERNAL in ${Math.round((Date.now() - started) / 1000)} s`;
console.log(`\n  ${summary}`);
writeFileSync(join(OUT, "browser.json"), JSON.stringify({ web: WEB, startedAt: new Date(started).toISOString(), results }, null, 2));
writeFileSync(
  join(OUT, "browser.md"),
  [`# Browser acceptance`, "", `- Web: \`${WEB}\``, `- Started: ${new Date(started).toISOString()}`, `- **${summary}**`, "", "| Check | Status | Seconds | Observed |", "|---|---|---|---|", ...results.map((r) => `| ${r.id} — ${r.title} | ${r.status} | ${r.seconds} | ${r.detail.replace(/\|/g, "\\|")} |`), ""].join("\n")
);
process.exit(counts.FAIL > 0 ? 1 : 0);
