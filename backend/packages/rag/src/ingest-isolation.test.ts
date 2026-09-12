import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Document } from "@ai-platform/database";
import { processDocumentIngestion, type IngestDeps } from "./ingest.js";

/**
 * Tenant isolation for the sandbox-PATH ingestion flow — docs/26_DECISIONS.md ADR-095.
 *
 * ADR-090 moved every native filesystem tool into a per-project workspace. This flow was
 * missed: it resolved `document.sourcePath` against the DEPLOYMENT root, so
 * `POST /api/v1/files` with `{"path": "<other-tenant-id>/notes.txt"}` read another tenant's
 * workspace and indexed it — chunk by chunk, retrievable by RAG — under the caller's project.
 * Containment was in place and did its job; it was pointed at the wrong root.
 *
 * The same omission was live in `fs.search`/`fs.glob`. Three call sites, one ADR, two of them
 * left behind: which is why this is tested per flow rather than argued once.
 */
describe("sandbox-path ingestion is scoped to the document's own project", () => {
  let root: string;
  let deps: IngestDeps;
  let updates: Array<{ id: string; status: string; error: string | null }>;

  const VICTIM = "tenant-a";
  const ATTACKER = "tenant-b";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ingest-iso-"));
    mkdirSync(join(root, VICTIM), { recursive: true });
    writeFileSync(join(root, VICTIM, "secrets.txt"), "TENANT A CONFIDENTIAL BOARD MINUTES\n");
    mkdirSync(join(root, ATTACKER), { recursive: true });
    writeFileSync(join(root, ATTACKER, "own.txt"), "tenant b's own document text\n");

    updates = [];
    const chunks: unknown[] = [];
    deps = {
      documentRepo: {
        updateStatus: async (_projectId: string, id: string, status: string, error: string | null) => {
          updates.push({ id, status, error });
        },
      } as unknown as IngestDeps["documentRepo"],
      chunkRepo: {
        replaceForDocument: async (_documentId: string, _projectId: string, rows: unknown[]) => {
          chunks.push(...rows);
          updates.push({ id: _documentId, status: "ready", error: null });
        },
      } as unknown as IngestDeps["chunkRepo"],
      embeddings: {
        embed: async (texts: string[]) => texts.map(() => ({ vector: [0.1, 0.2], model: "test", dimensions: 2 })),
      } as unknown as IngestDeps["embeddings"],
      sandboxRoot: root,
    };
    Object.defineProperty(deps, "__chunks", { value: chunks, enumerable: false });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const doc = (projectId: string, sourcePath: string): Document =>
    ({
      id: "doc-1",
      projectId,
      filename: sourcePath.split("/").pop() ?? sourcePath,
      sourcePath,
      assetId: null,
      scanStatus: "clean",
    }) as unknown as Document;

  it("refuses a sourcePath that names another tenant's workspace", async () => {
    await expect(processDocumentIngestion(deps, doc(ATTACKER, `${VICTIM}/secrets.txt`))).rejects.toThrow();
    // The refusal is also recorded on the row, so an operator sees why the index is stale.
    expect(updates.at(-1)?.status).toBe("failed");
    expect(String(updates.at(-1)?.error)).toMatch(/outside the sandboxed root|ENOENT|no such file/i);
    const stored = (deps as unknown as { __chunks: Array<{ content: string }> }).__chunks;
    expect(JSON.stringify(stored)).not.toContain("CONFIDENTIAL");
  });

  it("still ingests a path inside the caller's own workspace", async () => {
    await processDocumentIngestion(deps, doc(ATTACKER, "own.txt"));
    expect(updates.at(-1)?.status).toBe("ready");
    const stored = (deps as unknown as { __chunks: Array<{ content: string }> }).__chunks;
    expect(JSON.stringify(stored)).toContain("tenant b's own document text");
  });

  it("refuses a traversal out of the project workspace", async () => {
    await expect(processDocumentIngestion(deps, doc(ATTACKER, `../${VICTIM}/secrets.txt`))).rejects.toThrow();
    expect(updates.at(-1)?.status).toBe("failed");
    const stored = (deps as unknown as { __chunks: Array<{ content: string }> }).__chunks;
    expect(JSON.stringify(stored)).not.toContain("CONFIDENTIAL");
  });
});
