import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  ProcessSandbox,
  createSandbox,
  dockerAvailable,
  dockerRunArgs,
  type SandboxLimits,
} from "./sandbox.js";

/**
 * DockerSandbox, without a container runtime — docs/26_DECISIONS.md ADR-111.
 *
 * The status documents said the Docker sandbox was "unit only" with "flag construction verified",
 * and no test built one. These pin every isolation flag and the provider selection; what the flags
 * actually DO inside a real container is covered by sandbox.docker.test.ts, which runs only through
 * `npm run test:docker` and fails outright when docker is unusable.
 */
const LIMITS: SandboxLimits = { ...DEFAULT_LIMITS, pids: 64, memoryMb: 256, cpus: 0.5 };

describe("dockerRunArgs", () => {
  let root: string;
  let workdir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "docker-args-"));
    workdir = join(root, "project-1");
    mkdirSync(workdir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const argsFor = (env?: Record<string, string>) =>
    dockerRunArgs(root, "node:22-alpine", { command: "node", args: ["-e", "1"], workdir, env }, LIMITS);

  /** Each flag joined to the value after it, so "--network none" is asserted as one unit. */
  const pairs = (args: string[]) => args.map((a, i) => `${a} ${args[i + 1] ?? ""}`);

  it("denies the network, the root filesystem, capabilities and privilege escalation", () => {
    const joined = pairs(argsFor());
    expect(joined).toContain("--network none");
    expect(argsFor()).toContain("--read-only");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--user 1000:1000");
    expect(joined.some((p) => p.startsWith("--tmpfs /tmp:rw,noexec,nosuid"))).toBe(true);
  });

  it("applies the pid, memory and cpu limits it was given", () => {
    const joined = pairs(argsFor());
    expect(joined).toContain("--pids-limit 64");
    expect(joined).toContain("-m 256m");
    expect(joined).toContain("--cpus 0.5");
  });

  it("mounts exactly one volume: the contained workspace, as /workspace", () => {
    const args = argsFor();
    const volumes = args.flatMap((a, i) => (a === "-v" ? [args[i + 1]] : []));
    // The mounted path is the RESOLVED one — symlinks followed — which is what containment checked.
    expect(volumes).toEqual([`${realpathSync(workdir)}:/workspace:rw`]);
    expect(pairs(args)).toContain("-w /workspace");
  });

  it("passes only the variables it was asked to, never the parent environment", () => {
    process.env.SANDBOX_CANARY_SECRET = "sk-canary-must-not-leak";
    try {
      const args = argsFor({ GREETING: "hello" });
      // Only the flags BEFORE the image: after it come the command's own arguments (`node -e 1`).
      const flags = args.slice(0, args.indexOf("node:22-alpine"));
      const envs = flags.flatMap((a, i) => (a === "-e" ? [flags[i + 1]] : []));
      expect(envs).toEqual(["GREETING=hello"]);
      expect(args.join(" ")).not.toContain("sk-canary-must-not-leak");
    } finally {
      delete process.env.SANDBOX_CANARY_SECRET;
    }
  });

  it("ends with the image, the command and its arguments, in that order", () => {
    expect(argsFor().slice(-4)).toEqual(["node:22-alpine", "node", "-e", "1"]);
  });

  it("refuses a workdir outside the sandbox root before any argument is built", () => {
    expect(() =>
      dockerRunArgs(root, "node:22-alpine", { command: "node", args: [], workdir: tmpdir() }, LIMITS)
    ).toThrow();
  });
});

describe("sandbox selection", () => {
  it("returns process isolation when that is what was asked for", async () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-select-"));
    try {
      expect(await createSandbox({ root, runtime: "process" })).toBeInstanceOf(ProcessSandbox);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses, rather than silently downgrading, when docker is requested and unusable", async () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-select-"));
    try {
      await expect(
        createSandbox({ root, runtime: "docker", dockerPath: "definitely-not-a-docker-binary-4f1e" })
      ).rejects.toThrow(/docker CLI is not usable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports docker as unavailable when the binary does not exist", async () => {
    expect(await dockerAvailable("definitely-not-a-docker-binary-4f1e")).toBe(false);
  });
});
