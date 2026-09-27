import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpManager } from "@ai-platform/mcp";
import { ToolRegistry } from "@ai-platform/tools";

/**
 * The bundled MCP filesystem server is confined to the CALLER'S project workspace.
 *
 * `@modelcontextprotocol/server-filesystem` is launched once, over the whole `SANDBOX_ROOT`, and
 * every project's workspace is a subdirectory of that root (ADR-090). The server cannot know who
 * is calling, so before `workspaceScope` an enabled `read_text_file` given
 * `../<another project>/secret.txt` read another tenant's file. The control case below runs the
 * same call without the scope and shows it doing exactly that, against the real server.
 */

const SERVER = fileURLToPath(import.meta.resolve("@modelcontextprotocol/server-filesystem/dist/index.js"));
const READ = "mcp.reference-filesystem.read_text_file";
const READ_MANY = "mcp.reference-filesystem.read_multiple_files";
const A = { projectId: "project-a", userId: "user-a" };
const B = { projectId: "project-b", userId: "user-b" };

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-scope-"));
  mkdirSync(join(root, A.projectId));
  mkdirSync(join(root, B.projectId));
  writeFileSync(join(root, A.projectId, "note.txt"), "project A's own note");
  writeFileSync(join(root, B.projectId, "secret.txt"), "PROJECT B SECRET");
  // A link an agent could create with the write tools it holds, pointing at the other tenant.
  symlinkSync(join(root, B.projectId, "secret.txt"), join(root, A.projectId, "link.txt"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function withServer(scoped: boolean, fn: (registry: ToolRegistry) => Promise<void>) {
  const registry = new ToolRegistry();
  const manager = new McpManager(registry, { sleep: async () => undefined, healthIntervalMs: 0 });
  try {
    const [state] = await manager.startAll([
      {
        id: "reference-filesystem",
        command: process.execPath,
        args: [SERVER, root],
        cwd: root,
        ...(scoped ? { workspaceScope: { root } } : {}),
      },
    ]);
    expect(state.status).toBe("connected");
    registry.setEnabled(READ, true);
    registry.setEnabled(READ_MANY, true);
    await fn(registry);
  } finally {
    await manager.stopAll();
  }
}

describe("the bundled MCP filesystem server, scoped to the caller's workspace", () => {
  it("reads the caller's own file by a workspace-relative path", async () => {
    await withServer(true, async (registry) => {
      const result = await registry.call(READ, { path: "note.txt" }, A);
      expect(result.ok).toBe(true);
      expect(result.output?.content).toBe("project A's own note");
    });
  });

  it("refuses a traversal into another project, an absolute path to it, and a symlink to it", async () => {
    await withServer(true, async (registry) => {
      for (const path of [`../${B.projectId}/secret.txt`, join(root, B.projectId, "secret.txt"), "link.txt"]) {
        const result = await registry.call(READ, { path }, A);
        expect(result.ok, path).toBe(false);
        expect(JSON.stringify(result)).not.toContain("PROJECT B SECRET");
      }
    });
  });

  it("scopes every entry of a multi-path call", async () => {
    await withServer(true, async (registry) => {
      const result = await registry.call(READ_MANY, { paths: ["note.txt", `../${B.projectId}/secret.txt`] }, A);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("PROJECT B SECRET");
    });
  });

  it("refuses a call with no project scope rather than guessing a directory", async () => {
    await withServer(true, async (registry) => {
      const result = await registry.call(READ, { path: "note.txt" }, { userId: "user-a" } as never);
      expect(result.ok).toBe(false);
    });
  });

  it("CONTROL: without the scope, the same call reads the other tenant's file", async () => {
    // Proves the refusals above come from the scope, not from the server or the test setup.
    await withServer(false, async (registry) => {
      const result = await registry.call(READ, { path: join(root, B.projectId, "secret.txt") }, A);
      expect(result.ok).toBe(true);
      expect(result.output?.content).toBe("PROJECT B SECRET");
    });
  });
});
