/**
 * The shared half of the acceptance scripts — `scripts/accept-*.mjs`.
 *
 * These scripts drive a RUNNING platform through its real HTTP API, as a real client does:
 * they sign up, they get cookies, they send the CSRF token back, they read streamed bytes off
 * the wire and they fetch generated assets through the API rather than off the disk. Nothing
 * here imports application code, and nothing here can see the database. That is the point: a
 * check that reaches past the API can pass while the product is broken for everyone who cannot.
 *
 * Every check records a MEASUREMENT, not a verdict on its own. "PASS" with no number beside it
 * is the shape of a test that proves nothing, so `record` requires the detail string.
 */
import { setTimeout as delay } from "node:timers/promises";

export const API = (process.env.ACCEPT_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

/** ANSI, but only when someone is watching; a redirected log stays clean. */
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);

/**
 * One authenticated tenant, with its own cookie jar.
 *
 * Separate instances do not share state, which is what makes the cross-tenant checks real: the
 * second tenant is a genuinely different session, not the first one with a header changed.
 */
export class Client {
  constructor(label = "client") {
    this.label = label;
    this.cookie = "";
    this.csrf = "";
    this.projectId = "";
    this.userId = "";
    this.email = "";
  }

  /** The raw Response, cookies absorbed. Use this when you need headers or bytes. */
  async raw(method, path, body, extra = {}) {
    const headers = { "Content-Type": "application/json", ...(extra.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers["x-csrf-token"] = this.csrf;
    if (this.projectId && !("x-project-id" in headers)) headers["x-project-id"] = this.projectId;
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [name, value] = c.split(";")[0].split("=");
      if (name === "aip_session") this.session = value;
      if (name === "aip_csrf") this.csrf = value;
    }
    if (this.session) this.cookie = `aip_session=${this.session}${this.csrf ? `; aip_csrf=${this.csrf}` : ""}`;
    return res;
  }

  async call(method, path, body, extra) {
    const res = await this.raw(method, path, body, extra);
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  }

  /** Bytes, through the API — never off the filesystem. */
  async download(path) {
    const res = await this.raw("GET", path);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  }

  /**
   * A streamed POST, parsed into events as they arrive.
   *
   * `onEvent` is called with (event, msSinceRequestStart) so a caller can assert on DELIVERY and
   * not merely on content: a response that arrives in one chunk at the end is indistinguishable
   * from a streamed one once you have the final text, and it is a different product.
   */
  async stream(path, payload, onEvent) {
    const started = performance.now();
    const res = await this.raw("POST", path, payload);
    const events = [];
    if (!res.body) return { status: res.status, events, raw: "", headers: res.headers };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let raw = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          const event = JSON.parse(line.slice(6));
          const at = Math.round(performance.now() - started);
          events.push({ ...event, at });
          onEvent?.(event, at);
        } catch {
          /* a partial frame; the next chunk completes it */
        }
      }
    }
    return { status: res.status, events, raw, headers: res.headers, totalMs: Math.round(performance.now() - started) };
  }

  /** Signs up a brand-new tenant and selects its default project. */
  async signUp(prefix = "accept") {
    this.email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const res = await this.call("POST", "/api/v1/auth/signup", {
      email: this.email,
      password: "a-sufficiently-long-password",
      displayName: `Acceptance ${this.label}`,
    });
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      throw new Error(
        `signup refused with 429 — the rate limiter working correctly, not a defect. ` +
          `Wait ${retry ?? "the window"}s, or start the backend with a higher AUTH_RATE_LIMIT_MAX for this run.`
      );
    }
    if (res.status !== 201) throw new Error(`signup ${res.status}: ${res.text.slice(0, 200)}`);
    const me = await this.call("GET", "/api/v1/auth/me");
    if (me.status !== 200) throw new Error(`GET /auth/me ${me.status}: ${me.text.slice(0, 200)}`);
    this.userId = me.body.user.id;
    this.projectId = me.body.projects[0].id;
    this.permissions = me.body.projects[0].permissions ?? [];
    this.role = me.body.projects[0].role;
    return me.body;
  }
}

/** Polls until `fn` returns something truthy, or gives up loudly with how long it waited. */
export async function waitFor(fn, { timeoutMs = 240_000, everyMs = 2_000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    const waited = Date.now() - started;
    if (waited > timeoutMs) throw new Error(`timed out after ${Math.round(waited / 1000)}s waiting for ${label}`);
    await delay(everyMs);
  }
}

/** A run's results, printed as they happen so a long run is watchable. */
export class Report {
  constructor(title) {
    this.title = title;
    this.rows = [];
    this.started = Date.now();
    console.log(`\n${title}\n${"-".repeat(title.length)}`);
    console.log(dim(`  api: ${API}`));
  }

  /** `detail` is required: a PASS with no measurement beside it is the shape that proves nothing. */
  record(id, ok, detail) {
    if (!detail) throw new Error(`record("${id}") needs a detail string — a bare PASS is not evidence`);
    this.rows.push({ id, ok, detail });
    console.log(`  ${ok ? green("PASS") : red("FAIL")}  ${id.padEnd(18)} ${detail}`);
    return ok;
  }

  /** Runs one check, turning a throw into a FAIL rather than ending the whole run. */
  async check(id, fn) {
    try {
      const { ok, detail } = await fn();
      return this.record(id, ok, detail);
    } catch (err) {
      return this.record(id, false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  finish() {
    const failed = this.rows.filter((r) => !r.ok);
    const seconds = Math.round((Date.now() - this.started) / 1000);
    console.log(
      `\n  ${this.rows.length - failed.length}/${this.rows.length} passed in ${seconds}s` +
        (failed.length ? ` — failed: ${failed.map((f) => f.id).join(", ")}` : "")
    );
    if (process.env.ACCEPT_JSON) {
      console.log(JSON.stringify({ title: this.title, api: API, seconds, rows: this.rows }, null, 2));
    }
    process.exitCode = failed.length === 0 ? 0 : 1;
    return failed.length === 0;
  }
}

/** Refuses to run against a platform that is not there, rather than reporting 12 confusing failures. */
export async function requireRunningApi() {
  try {
    const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) return;
    throw new Error(`GET /api/health answered ${res.status}`);
  } catch (err) {
    console.error(
      `\nNothing is serving the API at ${API}.\n` +
        `Start it first:  cd backend && npm run dev\n` +
        `Or point these checks elsewhere:  ACCEPT_API_URL=http://host:port npm run accept:local\n` +
        `(${err instanceof Error ? err.message : String(err)})\n`
    );
    process.exit(1);
  }
}

/** What the platform says it is running, so a report can name the provider that answered. */
export async function providers(client) {
  const res = await client.call("GET", "/api/v1/providers");
  return res.status === 200 ? res.body : null;
}
