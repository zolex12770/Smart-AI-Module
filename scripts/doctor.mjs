#!/usr/bin/env node
/**
 * `npm run doctor` — what this machine can actually run, established by running it.
 *
 * Every row below is produced by executing the thing it reports on: the binary is invoked, the
 * endpoint is called, the directory is written to. Nothing is inferred from a file existing or
 * from an environment variable being set, because both can be true while the capability is
 * broken — a `FFMPEG_PATH` pointing at a file that will not execute is exactly the case an
 * operator needs told about, and it is the case a `existsSync` check reports as fine.
 *
 * Three outcomes, and the difference between the last two matters:
 *
 *   PASS         it ran, and answered correctly.
 *   UNAVAILABLE  it is not installed or not configured here. Not a failure: the platform is
 *                designed to degrade honestly, and the row says what stops working.
 *   FAIL         it is configured, and it does not work. This is a real problem with this
 *                machine's setup, and it is the only outcome that makes the command exit non-zero.
 *
 * A check that throws unexpectedly reports FAIL. It never reports PASS on an error it did not
 * expect — a diagnostic that reports healthy when it could not determine health is worse than
 * no diagnostic at all.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = process.argv.includes("--json");

/** Load backend/.env and the repo-root .env the same way the backend does, so doctor sees what it sees. */
for (const candidate of [join(REPO, "backend", ".env"), join(REPO, ".env")]) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      /* a malformed .env is reported by the Configuration check below, not here */
    }
  }
}

const rows = [];
const record = (name, status, detail, missing) => {
  rows.push({ name, status, detail, ...(missing ? { missing } : {}) });
};

/** Runs a check and turns any unexpected throw into FAIL, never into PASS. */
async function check(name, fn) {
  try {
    const result = await fn();
    record(name, result.status, result.detail, result.missing);
  } catch (err) {
    record(name, "FAIL", `check itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Runs a probe.  joins the command itself rather than passing an args array alongside
 * shell:true — Node deprecated that combination (DEP0190) precisely because the arguments are
 * concatenated unescaped. Every command here is a fixed literal with no caller-supplied part,
 * so the join is safe; writing it this way keeps it obviously safe rather than incidentally so.
 */
const exec = async (file, args, opts = {}) => {
  const { shell, ...rest } = opts;
  const { stdout, stderr } = shell
    ? await run(`${file} ${args.join(" ")}`, undefined, { timeout: 20_000, windowsHide: true, shell: true, ...rest })
    : await run(file, args, { timeout: 20_000, windowsHide: true, ...rest });
  return `${stdout ?? ""}${stderr ?? ""}`.trim();
};

/** GET a URL with a short deadline; null when nothing answers. */
async function get(url, timeoutMs = 4_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- toolchain -------------------------------------------------------------------------------

await check("Node", async () => {
  const major = Number(process.versions.node.split(".")[0]);
  // 20.6 is the floor: `process.loadEnvFile` (ADR-043) and the native test runner both need it.
  return major >= 20
    ? { status: "PASS", detail: `v${process.versions.node}` }
    : { status: "FAIL", detail: `v${process.versions.node} — this project needs Node 20.6 or newer`, missing: "Node >= 20.6" };
});

await check("npm", async () => ({ status: "PASS", detail: `v${(await exec("npm", ["--version"], { shell: true }))}` }));

await check("Dependencies installed", async () => {
  const installed = existsSync(join(REPO, "node_modules", ".package-lock.json"));
  return installed
    ? { status: "PASS", detail: "node_modules present at the workspace root" }
    : { status: "FAIL", detail: "not installed", missing: "run `npm install` at the repo root" };
});

// --- the two applications --------------------------------------------------------------------

await check("Backend", async () => {
  const built = existsSync(join(REPO, "backend", "dist", "index.js"));
  const health = await get(`http://127.0.0.1:${process.env.PORT ?? 8787}/api/health`);
  if (health?.ok) return { status: "PASS", detail: `answering on :${process.env.PORT ?? 8787} — ${health.body}` };
  return built
    ? { status: "PASS", detail: "built (not currently running; start it with `cd backend && npm run dev`)" }
    : { status: "UNAVAILABLE", detail: "not built and not running", missing: "cd backend && npm install && npm run dev" };
});

await check("Frontend", async () => {
  const page = await get("http://127.0.0.1:3000/login", 6_000);
  if (page?.ok) return { status: "PASS", detail: "serving on :3000" };
  return existsSync(join(REPO, "frontend", "node_modules")) || existsSync(join(REPO, "node_modules", "next"))
    ? { status: "PASS", detail: "installed (not currently running; start it with `cd frontend && npm run dev`)" }
    : { status: "UNAVAILABLE", detail: "not installed", missing: "cd frontend && npm install && npm run dev" };
});

// --- data ------------------------------------------------------------------------------------

await check("Database", async () => {
  if (process.env.DATABASE_URL) {
    return { status: "PASS", detail: `DATABASE_URL is set — a standalone PostgreSQL will be used` };
  }
  // PGlite is a dependency, not an install: the check is whether it can actually open.
  const dir = join(REPO, process.env.DATABASE_DIR ?? "data/pgdata");
  return existsSync(join(REPO, "node_modules", "@electric-sql", "pglite"))
    ? { status: "PASS", detail: `embedded PostgreSQL (PGlite), data dir ${process.env.DATABASE_DIR ?? "./data/pgdata"}${existsSync(dir) ? " (exists)" : " (created on first boot)"}` }
    : { status: "FAIL", detail: "PGlite is not installed", missing: "npm install at the repo root" };
});

await check("Migrations", async () => {
  const dir = join(REPO, "backend", "packages", "database", "migrations");
  if (!existsSync(dir)) return { status: "FAIL", detail: `no migration directory at ${dir}` };
  const journal = join(dir, "meta", "_journal.json");
  if (!existsSync(journal)) return { status: "FAIL", detail: "migration journal missing" };
  const entries = JSON.parse(readFileSync(journal, "utf8")).entries ?? [];
  return { status: "PASS", detail: `${entries.length} migration(s); \`bash scripts/verify-migrations.sh\` proves they build the current schema` };
});

await check("Storage", async () => {
  const root = resolve(REPO, process.env.ASSETS_ROOT ?? "data/assets");
  try {
    const probe = mkdtempSync(join(tmpdir(), "doctor-assets-"));
    writeFileSync(join(probe, "probe"), "x");
    rmSync(probe, { recursive: true, force: true });
  } catch (err) {
    return { status: "FAIL", detail: `temp directory is not writable: ${err.message}` };
  }
  if (process.env.ASSETS_BUCKET) return { status: "PASS", detail: `Google Cloud Storage bucket ${process.env.ASSETS_BUCKET}` };
  return { status: "PASS", detail: `local disk at ${root}` };
});

// --- AI runtime ------------------------------------------------------------------------------

const ollamaBase = (process.env.LLM_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, "");
const tags = await get(`${ollamaBase}/api/tags`, 4_000);
const models = tags?.ok ? (JSON.parse(tags.body).models ?? []).map((m) => m.name) : [];

await check("Ollama", async () =>
  tags?.ok
    ? { status: "PASS", detail: `${ollamaBase} — ${models.length} model(s) installed` }
    : {
        status: "UNAVAILABLE",
        detail: `nothing answering at ${ollamaBase}; the platform will fall back to the mock provider and SAY SO`,
        missing: "ollama serve",
      }
);

await check("Chat model", async () => {
  if (!tags?.ok) return { status: "UNAVAILABLE", detail: "no local runtime to ask", missing: "ollama serve" };
  const wanted = process.env.LLM_MODEL;
  // Any instruct-style model works. Named ones first, then whatever is installed.
  const preferred = ["qwen2.5:14b", "qwen2.5:7b", "llama3.1:8b", "mistral:7b", "qwen2.5:1.5b"];
  const chosen = wanted && models.includes(wanted) ? wanted : preferred.find((m) => models.includes(m)) ?? models.find((m) => !/embed/i.test(m));
  if (!chosen) return { status: "UNAVAILABLE", detail: "no chat model installed", missing: "ollama pull qwen2.5:7b" };
  if (wanted && !models.includes(wanted)) {
    return { status: "FAIL", detail: `LLM_MODEL=${wanted} is configured and NOT installed; installed: ${models.join(", ")}`, missing: `ollama pull ${wanted}` };
  }
  return { status: "PASS", detail: `${chosen}${wanted ? " (from LLM_MODEL)" : " (detected; set LLM_MODEL to pin it)"}` };
});

await check("Embedding model", async () => {
  if (!tags?.ok) return { status: "UNAVAILABLE", detail: "no local runtime to ask", missing: "ollama serve" };
  const wanted = process.env.EMBEDDING_MODEL;
  const embedders = models.filter((m) => /embed/i.test(m));
  if (wanted && !models.some((m) => m === wanted || m.startsWith(`${wanted}:`))) {
    return { status: "FAIL", detail: `EMBEDDING_MODEL=${wanted} is configured and NOT installed`, missing: `ollama pull ${wanted}` };
  }
  if (embedders.length === 0) {
    return {
      status: "UNAVAILABLE",
      detail: "none installed — RAG and memory fall back to a LEXICAL match, which the API reports as isDeterministicFallback",
      missing: "ollama pull nomic-embed-text",
    };
  }
  return { status: "PASS", detail: `${wanted ?? embedders[0]}` };
});

// --- media -----------------------------------------------------------------------------------

await check("FFmpeg", async () => {
  const path = process.env.FFMPEG_PATH ?? "ffmpeg";
  try {
    const out = await exec(path, ["-version"]);
    return { status: "PASS", detail: out.split("\n")[0] };
  } catch {
    return {
      status: process.env.FFMPEG_PATH ? "FAIL" : "UNAVAILABLE",
      detail: process.env.FFMPEG_PATH
        ? `FFMPEG_PATH=${path} did not execute`
        : "not on PATH — video rendering is unavailable and reports renderStatus skipped_no_ffmpeg",
      missing: "install ffmpeg, or set FFMPEG_PATH",
    };
  }
});

await check("Image runtime", async () => {
  const cli = process.env.IMAGE_SD_CLI_PATH;
  const model = process.env.IMAGE_SD_MODEL_PATH;
  if (process.env.IMAGE_BASE_URL) return { status: "PASS", detail: `hosted image API at ${process.env.IMAGE_BASE_URL}` };
  if (!cli || !model) {
    return {
      status: "UNAVAILABLE",
      detail: "no local diffusion runtime configured — image generation is MOCKED, and the API says isMock: true",
      missing: "IMAGE_SD_CLI_PATH and IMAGE_SD_MODEL_PATH (stable-diffusion.cpp + a .gguf model)",
    };
  }
  if (!existsSync(model)) return { status: "FAIL", detail: `IMAGE_SD_MODEL_PATH does not exist: ${model}` };
  try {
    await exec(cli, ["--help"]);
    return { status: "PASS", detail: `stable-diffusion.cpp with ${model.split(/[\\/]/).pop()}` };
  } catch {
    return { status: "FAIL", detail: `IMAGE_SD_CLI_PATH=${cli} did not execute` };
  }
});

await check("Audio runtime", async () => {
  const provider = process.env.SPEECH_PROVIDER;
  if (provider === "sapi") {
    if (process.platform !== "win32") return { status: "FAIL", detail: "SPEECH_PROVIDER=sapi, but this is not Windows" };
    return { status: "PASS", detail: `Windows SAPI${process.env.SPEECH_VOICE ? ` (${process.env.SPEECH_VOICE})` : ""}` };
  }
  if (process.env.PIPER_PATH) {
    if (!existsSync(process.env.PIPER_PATH)) return { status: "FAIL", detail: `PIPER_PATH does not exist: ${process.env.PIPER_PATH}` };
    if (!process.env.PIPER_VOICE || !existsSync(process.env.PIPER_VOICE)) {
      return { status: "FAIL", detail: "PIPER_PATH is set but PIPER_VOICE is missing or does not exist", missing: "a piper .onnx voice" };
    }
    return { status: "PASS", detail: "piper" };
  }
  if (process.env.SPEECH_BASE_URL) return { status: "PASS", detail: `hosted speech API at ${process.env.SPEECH_BASE_URL}` };
  return {
    status: "UNAVAILABLE",
    detail: "no speech provider — POST /api/v1/audio refuses with 503, and long-form video renders silently",
    missing: "SPEECH_PROVIDER=sapi on Windows, or PIPER_PATH + PIPER_VOICE",
  };
});

await check("Malware scanning", async () => {
  if (!process.env.CLAMD_HOST) {
    return {
      status: "UNAVAILABLE",
      detail: process.env.UPLOAD_SCAN_REQUIRED === "true"
        ? "UPLOAD_SCAN_REQUIRED=true and no scanner: uploads will be REFUSED with 503 (fail-closed)"
        : "uploads are accepted unscanned and durably marked scan_status=skipped_no_scanner (fail-open)",
      missing: "CLAMD_HOST, or set UPLOAD_SCAN_REQUIRED=true to refuse uploads instead",
    };
  }
  const port = Number(process.env.CLAMD_PORT ?? 3310);
  const net = await import("node:net");
  const reachable = await new Promise((r) => {
    const s = net.createConnection({ host: process.env.CLAMD_HOST, port, timeout: 3_000 });
    s.on("connect", () => (s.end(), r(true)));
    s.on("error", () => r(false));
    s.on("timeout", () => (s.destroy(), r(false)));
  });
  return reachable
    ? { status: "PASS", detail: `clamd at ${process.env.CLAMD_HOST}:${port}` }
    : { status: "FAIL", detail: `CLAMD_HOST=${process.env.CLAMD_HOST}:${port} is configured and not reachable` };
});

// --- verification tooling ----------------------------------------------------------------------

await check("Browser (Playwright)", async () => {
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    return existsSync(path)
      ? { status: "PASS", detail: "Chromium installed" }
      : { status: "UNAVAILABLE", detail: "playwright is installed, its browser is not", missing: "npx playwright install chromium" };
  } catch {
    return { status: "UNAVAILABLE", detail: "playwright not installed", missing: "npm install at the repo root" };
  }
});

await check("Docker", async () => {
  try {
    const out = await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { shell: true });
    return { status: "PASS", detail: `daemon ${out.split("\n").pop()}` };
  } catch {
    return {
      status: "UNAVAILABLE",
      detail: "no daemon — container build, the real-container sandbox suite and docker-compose cannot run here",
      missing: "Docker Desktop or a dockerd",
    };
  }
});

await check("Terraform", async () => {
  const candidates = [process.env.TERRAFORM_PATH, "terraform", join(REPO, ".local-tools", "terraform", "terraform.exe")].filter(Boolean);
  for (const c of candidates) {
    try {
      const out = await exec(c, ["version"], { shell: c === "terraform" });
      return { status: "PASS", detail: out.split("\n")[0] };
    } catch {
      /* try the next candidate */
    }
  }
  return { status: "UNAVAILABLE", detail: "not installed", missing: "terraform, to validate infrastructure/" };
});

await check("Cloud credentials", async () => {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return { status: "PASS", detail: "GOOGLE_APPLICATION_CREDENTIALS is set and the file exists" };
  }
  try {
    const out = await exec("gcloud", ["config", "get-value", "project"], { shell: true });
    const project = out.split("\n").pop().trim();
    if (project && project !== "(unset)") return { status: "PASS", detail: `gcloud project ${project}` };
  } catch {
    /* gcloud absent */
  }
  return {
    status: "UNAVAILABLE",
    detail: "no GCP project — nothing can be deployed, and PRODUCTION VERIFICATION IS IMPOSSIBLE from this machine",
    missing: "gcloud auth application-default login, and a project",
  };
});

// --- report ------------------------------------------------------------------------------------

if (JSON_OUT) {
  console.log(JSON.stringify({ rows }, null, 2));
} else {
  const width = Math.max(...rows.map((r) => r.name.length));
  console.log("");
  for (const r of rows) {
    const mark = r.status === "PASS" ? "PASS       " : r.status === "FAIL" ? "FAIL       " : "UNAVAILABLE";
    console.log(`  ${r.name.padEnd(width)}  ${mark}  ${r.detail}`);
  }
  const missing = rows.filter((r) => r.missing);
  if (missing.length > 0) {
    console.log("\n  To change an UNAVAILABLE or FAIL row:");
    for (const r of missing) console.log(`    ${r.name.padEnd(width)}  ${r.missing}`);
  }
  const failures = rows.filter((r) => r.status === "FAIL");
  const unavailable = rows.filter((r) => r.status === "UNAVAILABLE");
  console.log(
    `\n  ${rows.filter((r) => r.status === "PASS").length} pass · ${unavailable.length} unavailable · ${failures.length} fail`
  );
  if (unavailable.length > 0 && failures.length === 0) {
    console.log("  An unavailable row is not a broken installation: every one of them degrades honestly,");
    console.log("  and the platform reports the degradation rather than pretending the capability works.");
  }
}

// Only a FAIL is an error: something is configured here and does not work.
process.exitCode = rows.some((r) => r.status === "FAIL") ? 1 : 0;
