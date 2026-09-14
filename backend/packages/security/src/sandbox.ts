import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

/**
 * Command execution isolation (docs/13_SECURITY_ARCHITECTURE.md §6, ADR-055).
 *
 * The previous implementation spawned a child of the API process with `{ cwd, shell: false }`
 * and no `env`, which meant every command inherited the parent's entire environment —
 * provider API keys, DATABASE_URL, session secrets — and a "timeout" that only rejected a
 * promise while the process kept running. Both are fixed here, and the fix is layered:
 *
 * 1. `DockerSandbox` — the production posture. A container per run with no network, a
 *    read-only root filesystem, a tmpfs `/tmp`, dropped capabilities, `--pids-limit`, and
 *    memory/CPU caps. Selected when `SANDBOX_RUNTIME=docker` and a working docker CLI exists.
 * 2. `ProcessSandbox` — the local-development fallback. Same API, same env scrubbing, same
 *    real process-tree termination and output caps, but isolation is OS-user-level only.
 *    It reports `isolation: "process"` so no caller can mistake it for a container.
 *
 * A sandbox never inherits the parent environment. The child receives exactly the variables
 * it is given, plus a minimal PATH — nothing else crosses the boundary.
 */

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  memoryMb: number;
  cpus: number;
  /** Hard cap on processes, so a fork bomb cannot exhaust the host. */
  pids: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 30_000,
  maxOutputBytes: 1_000_000,
  memoryMb: 512,
  cpus: 1,
  pids: 128,
};

export interface SandboxRunRequest {
  command: string;
  args: string[];
  /** Absolute path to the workspace. Must already exist and be inside the sandbox root. */
  workdir: string;
  /** Extra variables for the child. The parent's environment is NEVER inherited. */
  env?: Record<string, string>;
  limits?: Partial<SandboxLimits>;
  /** Aborts the run early (user cancellation). */
  signal?: AbortSignal;
}

export interface SandboxRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  isolation: "docker" | "process";
}

export interface ExecutionSandbox {
  readonly isolation: "docker" | "process";
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

/**
 * The minimal environment every child gets. Deliberately does not include HOME or USER:
 * nothing the coding agent runs should depend on the host account, and PATH is the only
 * variable a process genuinely cannot work without.
 */
function baseEnv(): Record<string, string> {
  const path = process.env.PATH ?? "";
  const env: Record<string, string> = { PATH: path, NODE_ENV: "sandbox", CI: "1" };
  // Windows requires these for the loader itself to function.
  if (process.platform === "win32") {
    for (const key of ["SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }
  return env;
}

/** Rejects a workdir that escapes the sandbox root, following symlinks (docs/13 §11). */
export function assertContained(root: string, workdir: string): string {
  const resolvedRoot = realpathSync(resolve(root));
  const resolvedDir = realpathSync(resolve(workdir));
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + sep)) {
    throw new Error(`Workspace "${workdir}" resolves outside the sandbox root.`);
  }
  return resolvedDir;
}

abstract class BaseSandbox implements ExecutionSandbox {
  abstract readonly isolation: "docker" | "process";
  protected abstract spawnChild(request: SandboxRunRequest, limits: SandboxLimits): ChildProcess;

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...request.limits };
    const startedAt = Date.now();
    const child = this.spawnChild(request, limits);

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    const append = (target: "out" | "err", chunk: Buffer) => {
      const current = target === "out" ? stdout : stderr;
      if (current.length >= limits.maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = limits.maxOutputBytes - current.length;
      const text = chunk.toString("utf8");
      const slice = text.length > room ? text.slice(0, room) : text;
      if (slice.length < text.length) truncated = true;
      if (target === "out") stdout += slice;
      else stderr += slice;
    };

    child.stdout?.on("data", (c: Buffer) => append("out", c));
    child.stderr?.on("data", (c: Buffer) => append("err", c));

    // A timeout that actually terminates. SIGTERM first, then SIGKILL if the process ignores
    // it — the previous implementation only rejected a promise and left the child running.
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, limits.timeoutMs);

    const onAbort = () => {
      cancelled = true;
      terminate(child);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.once("error", () => resolveExit(null));
      child.once("close", (code) => resolveExit(code));
    });

    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);

    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      cancelled,
      truncated,
      durationMs: Date.now() - startedAt,
      isolation: this.isolation,
    };
  }
}

function terminate(child: ChildProcess): void {
  if (child.pid === undefined || child.killed) return;
  try {
    if (process.platform === "win32") {
      // Windows has no process groups; taskkill /T is the only way to reap the tree.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // Negative pid signals the whole process group created by `detached: true`.
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2_000).unref();
    }
  } catch {
    /* already gone */
  }
}

/**
 * Node's permission model, as the containment process isolation previously had none —
 * docs/26_DECISIONS.md ADR-117.
 *
 * `--permission` is stable from Node 23; 20–22 spell it `--experimental-permission`. Deployments
 * on an older runtime get the flag they understand, and one that understands neither gets no
 * containment, which `supportsPermissionModel` reports so the caller can refuse.
 */
function permissionFlagFor(nodeVersion = process.versions.node): string | null {
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major) || major < 20) return null;
  return major >= 23 ? "--permission" : "--experimental-permission";
}

/** True when this runtime can confine a Node child to a directory. */
export function supportsPermissionModel(nodeVersion = process.versions.node): boolean {
  return permissionFlagFor(nodeVersion) !== null;
}

/**
 * The argument vector for a sandboxed command — ADR-117.
 *
 * Exported so the confinement is asserted rather than reviewed: a `node` child is run under the
 * permission model, restricted to the workspace it was given. Anything else is returned unchanged,
 * because the flags are Node's own; the allow-list in `terminal.run_command` is what keeps that
 * case from arising.
 */
export function processSandboxArgs(
  command: string,
  args: string[],
  workdir: string,
  nodeVersion = process.versions.node
): string[] {
  const executable = basename(command).toLowerCase();
  if (executable !== "node" && executable !== "node.exe") return args;
  const flag = permissionFlagFor(nodeVersion);
  if (!flag) return args;
  // Read and write are granted for the workspace only. Everything else the model could reach —
  // the API's .env, the PGlite data directory, another tenant's workspace, the user's home — is
  // denied by the runtime, as are child processes, worker threads and native addons.
  return [flag, `--allow-fs-read=${workdir}`, `--allow-fs-read=${workdir}/*`, `--allow-fs-write=${workdir}/*`, ...args];
}

/**
 * Local-development isolation: scrubbed env, real termination, output caps, and — since ADR-117 —
 * a filesystem boundary the child cannot cross.
 *
 * WHAT THIS USED TO BE. `spawnChild` set `cwd` and an environment and nothing else, so "sandbox"
 * meant only "a different working directory". An audit proved the consequence end to end through
 * the real tools: `fs.write_file` wrote a script, `terminal.run_command` ran `node` on it, and the
 * script read a host file outside the root, wrote a new one beside it, listed every tenant's
 * workspace under the deployment root, and resolved DNS. Both tools are `write_local`, whose
 * default approval is `never`, so no human gate was crossed. `SANDBOX_RUNTIME=process` is the
 * default and the only mode available without Docker, so that was the normal local posture.
 *
 * WHAT IT DOES NOT DO. The permission model has no network dimension: a script can still open
 * sockets. Docker remains the production posture (`--network none`), and `docs/13` says so.
 */
export class ProcessSandbox extends BaseSandbox {
  readonly isolation = "process" as const;

  constructor(private readonly root: string) {
    super();
  }

  protected spawnChild(request: SandboxRunRequest, _limits: SandboxLimits): ChildProcess {
    const workdir = assertContained(this.root, request.workdir);
    return spawn(request.command, processSandboxArgs(request.command, request.args, workdir), {
      cwd: workdir,
      env: { ...baseEnv(), ...(request.env ?? {}) },
      shell: false,
      // Own process group so a timeout can kill the whole tree, not just the direct child.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

/**
 * The exact `docker run` argument vector for one sandboxed command — docs/26_DECISIONS.md
 * ADR-111.
 *
 * Extracted so the isolation flags are ASSERTED rather than reviewed. The status documents
 * claimed "flag construction verified" and "unit only" for the Docker sandbox while no test
 * constructed a DockerSandbox at all; the documented verification command passed on a machine
 * with no Docker installed. Every flag below is now pinned by a test, and the real-container
 * behaviour by a separate suite that fails, rather than skips, when docker is unusable.
 */
export function dockerRunArgs(
  root: string,
  image: string,
  request: SandboxRunRequest,
  limits: SandboxLimits
): string[] {
  const workdir = assertContained(root, request.workdir);
  const envArgs = Object.entries(request.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(limits.pids),
    "-m",
    `${limits.memoryMb}m`,
    "--cpus",
    String(limits.cpus),
    "--user",
    "1000:1000",
    "-v",
    `${workdir}:/workspace:rw`,
    "-w",
    "/workspace",
    ...envArgs,
    image,
    request.command,
    ...request.args,
  ];
}

/**
 * Production isolation. Every flag here is a deliberate control:
 * `--network none` (no egress at all), `--read-only` with a tmpfs `/tmp` (no host writes
 * outside the mounted workspace), `--cap-drop ALL` and `--security-opt no-new-privileges`
 * (no privilege escalation), `--pids-limit` (no fork bomb), `-m`/`--cpus` (no resource
 * exhaustion), and `--user` (never root inside the container).
 */
export class DockerSandbox extends BaseSandbox {
  readonly isolation = "docker" as const;

  constructor(
    private readonly root: string,
    private readonly image: string,
    private readonly dockerPath = "docker"
  ) {
    super();
  }

  protected spawnChild(request: SandboxRunRequest, limits: SandboxLimits): ChildProcess {
    const args = dockerRunArgs(this.root, this.image, request, limits);
    return spawn(this.dockerPath, args, {
      env: baseEnv(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

/**
 * Chooses the strongest sandbox actually available. Never silently downgrades in production:
 * when `SANDBOX_RUNTIME=docker` is requested and docker is unusable, the caller gets an error
 * rather than a weaker sandbox it did not ask for.
 */
export async function createSandbox(options: {
  root: string;
  runtime: "docker" | "process";
  image?: string;
  dockerPath?: string;
}): Promise<ExecutionSandbox> {
  if (options.runtime === "docker") {
    const ok = await dockerAvailable(options.dockerPath ?? "docker");
    if (!ok) {
      throw new Error(
        "SANDBOX_RUNTIME=docker was requested but the docker CLI is not usable. Refusing to fall back to " +
          "process-level isolation, which does not provide the network/filesystem containment docker does."
      );
    }
    return new DockerSandbox(options.root, options.image ?? "node:22-alpine", options.dockerPath);
  }
  return new ProcessSandbox(options.root);
}

export async function dockerAvailable(dockerPath = "docker"): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const probe = spawn(dockerPath, ["version", "--format", "{{.Server.Version}}"], {
      stdio: "ignore",
      shell: false,
    });
    const timer = setTimeout(() => {
      probe.kill();
      resolveAvailable(false);
    }, 5_000);
    probe.once("error", () => {
      clearTimeout(timer);
      resolveAvailable(false);
    });
    probe.once("close", (code) => {
      clearTimeout(timer);
      resolveAvailable(code === 0);
    });
  });
}
