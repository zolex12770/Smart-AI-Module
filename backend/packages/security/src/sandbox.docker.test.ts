import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandbox, dockerAvailable, type ExecutionSandbox } from "./sandbox.js";

/**
 * DockerSandbox against a REAL container runtime — docs/26_DECISIONS.md ADR-111.
 *
 * Excluded from the default `npm test` (see vitest.config.ts) and run only by
 * `npm run test:docker --workspace=@ai-platform/security`. When that command is run, docker being
 * unusable is a FAILURE, not a skip: the documented verification step used to pass on a machine with
 * no docker at all, because nothing in the suite it named ever built a DockerSandbox.
 *
 * Each case asserts the property a flag exists for, observed from inside the container, rather than
 * the flag itself — that is sandbox-docker.test.ts's job.
 */
describe("DockerSandbox in a real container", () => {
  let root: string;
  let workdir: string;
  let sandbox: ExecutionSandbox;

  beforeAll(async () => {
    if (!(await dockerAvailable())) {
      throw new Error(
        "docker is not usable on this machine. This suite requires a container runtime and FAILS rather than " +
          "skipping, so that running it can never report isolation as verified when it was not exercised."
      );
    }
    root = mkdtempSync(join(tmpdir(), "docker-real-"));
    workdir = join(root, "project-1");
    mkdirSync(workdir, { recursive: true });
    sandbox = await createSandbox({ root, runtime: "docker", image: "node:22-alpine" });
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("has no network access", async () => {
    const result = await sandbox.run({
      command: "node",
      args: ["-e", "fetch('https://example.com').then(() => process.exit(0), () => process.exit(3))"],
      workdir,
    });
    expect(result.exitCode).toBe(3);
  });

  it("cannot write outside /workspace and /tmp, but can write inside them", async () => {
    const outside = await sandbox.run({ command: "sh", args: ["-c", "touch /etc/sandbox-probe"], workdir });
    expect(outside.exitCode).not.toBe(0);
    // The container runs as uid 1000. On Linux a bind mount keeps host ownership, so a directory
    // created by a runner with another uid is not writable from inside. Production creates
    // workspaces as the API's own user (uid 1000 in the image); the test grants it explicitly.
    chmodSync(workdir, 0o777);
    const inside = await sandbox.run({ command: "sh", args: ["-c", "touch /workspace/ok && touch /tmp/ok"], workdir });
    expect(inside.exitCode).toBe(0);
  });

  it("does not run as root", async () => {
    const result = await sandbox.run({ command: "id", args: ["-u"], workdir });
    expect(result.stdout.trim()).toBe("1000");
  });

  it("does not see the parent's environment", async () => {
    process.env.SANDBOX_CANARY_SECRET = "sk-canary-must-not-leak";
    try {
      const result = await sandbox.run({ command: "sh", args: ["-c", "env"], workdir });
      expect(result.stdout).not.toContain("sk-canary-must-not-leak");
    } finally {
      delete process.env.SANDBOX_CANARY_SECRET;
    }
  });
});
