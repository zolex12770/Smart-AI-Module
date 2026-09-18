import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Each role, actually booted — docs/26_DECISIONS.md ADR-138.
 *
 * `roleRuns` is a pure decision table and was the only automated coverage the api/worker split
 * had: it asserts which flags a role sets, and nothing asserted what happens when a process
 * starts with them. That gap hid a deployment that could not start at all. `backend/Dockerfile`
 * sets `NODE_ENV=production`, the Terraform api service sets `ROLE=api`, and `index.ts` refuses
 * the HTTP role in production under process-level isolation unless an operator has explicitly
 * accepted it (ADR-055) — so the Cloud Run service as defined would exit on that guard, and no
 * test here could have noticed, because a decision table does not boot anything.
 *
 * These start the REAL compiled entrypoint as a child process, which is the only thing that
 * proves a role boots. They need `npm run build` to have run, and skip loudly rather than
 * silently passing when it has not.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "..");
const ENTRY = join(BACKEND_ROOT, "dist", "index.js");

const BUILT = existsSync(ENTRY);
if (!BUILT) {
  // eslint-disable-next-line no-console
  console.warn(`\n  SKIPPING the role boot tests: ${ENTRY} does not exist. Run \`npm run build\` first.\n`);
}

/** A session secret of the length the config schema requires; not a credential. */
const TEST_SECRET = "0123456789abcdef0123456789abcdef";

interface BootResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Boots the entrypoint and returns when it exits, or kills it after `settleMs` and reports what
 * it had logged by then. A role that stays up is the SUCCESS case for `worker` and `api`, so
 * "still running" has to be an outcome rather than a timeout failure.
 */
function boot(env: Record<string, string>, settleMs: number): Promise<BootResult & { stillRunning: boolean }> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = execFile(process.execPath, [ENTRY], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    child.stdout?.on("data", (c) => (stdout += String(c)));
    child.stderr?.on("data", (c) => (stderr += String(c)));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({ code: null, stdout, stderr, stillRunning: true });
    }, settleMs);

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, stillRunning: false });
    });
  });
}

describe.skipIf(!BUILT)("each role boots the way the deployment assumes", () => {
  let dataRoot: string;
  let port = 8820;

  const baseEnv = () => ({
    DATABASE_DIR: join(dataRoot, `pg-${port}`),
    SANDBOX_ROOT: join(dataRoot, `sbx-${port}`),
    SESSION_SECRET: TEST_SECRET,
    // A base URL that resolves to nothing: this is about BOOT, and no test here should depend on
    // a model server existing.
    LLM_BASE_URL: "http://127.0.0.1:1/v1",
    LLM_MODEL: "unused-for-boot",
    // Keep the runtime probe from adopting a local Ollama and changing what is under test.
    OLLAMA_HOST: "127.0.0.1:1",
  });

  beforeAll(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "role-boot-"));
  });

  afterAll(() => {
    try {
      rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  it("refuses the HTTP role in production under process isolation, naming the remedy", async () => {
    port += 1;
    const result = await boot({ ...baseEnv(), NODE_ENV: "production", ROLE: "api", PORT: String(port) }, 45_000);

    // This is the exact state the container image plus the Terraform api service produced.
    expect(result.stillRunning).toBe(false);
    expect(result.code).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/Refusing to start in production with process-level sandbox isolation/);
    // A refusal that does not say what to do instead is a dead end for whoever reads the logs.
    expect(output).toMatch(/SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true/);
  }, 90_000);

  it("boots the HTTP role in production once that isolation is explicitly accepted", async () => {
    port += 1;
    const result = await boot(
      {
        ...baseEnv(),
        NODE_ENV: "production",
        ROLE: "api",
        PORT: String(port),
        SANDBOX_ALLOW_PROCESS_IN_PRODUCTION: "true",
        CORS_ORIGIN: "https://example.com",
      },
      45_000
    );

    // Still running is the pass: an HTTP role that exits has not started serving.
    expect(result.stillRunning).toBe(true);
    expect(result.stdout).toMatch(/Server listening/);
  }, 90_000);

  it("boots the worker role with no HTTP listener and no chat provider", async () => {
    port += 1;
    // No LLM_* at all: a worker legitimately has no chat provider, and treating that as fatal
    // would make the split unusable. The log says so rather than staying silent.
    const { LLM_BASE_URL: _u, LLM_MODEL: _m, ...envWithoutModel } = baseEnv();
    const result = await boot({ ...envWithoutModel, ROLE: "worker" }, 45_000);

    expect(result.stillRunning).toBe(true);
    expect(result.stdout).toMatch(/job workers registered/);
    expect(result.stdout).toMatch(/worker role: no HTTP listener started/);
    expect(result.stdout).not.toMatch(/Server listening/);
  }, 90_000);

  it("boots the worker role in production without needing the isolation acknowledgement", async () => {
    port += 1;
    // The guard is scoped to the HTTP role on purpose — the worker runs no agent loop — which is
    // why the Terraform worker service sets a sandbox PATH and not the acceptance flag.
    const result = await boot({ ...baseEnv(), NODE_ENV: "production", ROLE: "worker" }, 45_000);

    expect(result.stillRunning).toBe(true);
    expect(result.stdout).not.toMatch(/Refusing to start in production/);
    expect(result.stdout).toMatch(/job workers registered/);
  }, 90_000);
});
