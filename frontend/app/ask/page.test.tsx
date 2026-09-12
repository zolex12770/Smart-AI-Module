import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionProvider } from "../lib/session-context";
import AskPage from "./page";

/**
 * RAG citations, which pointed at the wrong table.
 *
 * `sources[].documentId` is a row in `documents`; `GET /api/v1/assets/:id` resolves a row in
 * `assets`. Linking the citation straight at the document id therefore 404'd every time — the
 * answer looked properly sourced and not one source could be opened, which docs/09 §6 treats
 * as worse than showing no link at all.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/ask",
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ANSWER = {
  question: "What is the rollback procedure?",
  answer: "Roll back with the documented script. [1]",
  grounded: true,
  sources: [
    {
      marker: "[1]",
      documentId: "doc-1",
      filename: "runbook.md",
      chunkIndex: 0,
      distance: 0.12,
      excerpt: "Run ./rollback.sh.",
    },
    {
      marker: "[2]",
      documentId: "doc-2",
      filename: "handbook.txt",
      chunkIndex: 3,
      distance: 0.31,
      excerpt: "Ingested from a sandbox path.",
    },
  ],
};

/** `doc-1` was uploaded and has bytes; `doc-2` came from a sandbox path and has no asset. */
function routedFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/v1/auth/me")) {
      return json({
        user: { id: "u1", email: "a@example.com", displayName: "A", isSystemAdmin: false },
        projects: [{ id: "project-1", name: "Default", organizationId: "org-1", role: "admin" }],
      });
    }
    if (url.includes("/api/v1/rag/query")) return json(ANSWER);
    if (url.includes("/api/v1/files/doc-1")) {
      return json({ document: { id: "doc-1", filename: "runbook.md", sourcePath: null, assetId: "asset-9" } });
    }
    if (url.includes("/api/v1/files/doc-2")) {
      return json({ document: { id: "doc-2", filename: "handbook.txt", sourcePath: "handbook.txt", assetId: null } });
    }
    return json({ error: { code: "NOT_FOUND", message: url } }, 404);
  });
}

async function ask() {
  render(
    <SessionProvider>
      <AskPage />
    </SessionProvider>
  );
  const box = await screen.findByLabelText("Question");
  await userEvent.type(box, "What is the rollback procedure?");
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
}

describe("Ask screen citations", () => {
  beforeEach(() => {
    document.cookie = "aip_csrf=csrf-token-value";
    vi.stubGlobal("fetch", routedFetch());
  });

  afterEach(() => {
    window.localStorage.clear();
    document.cookie = "aip_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  it("links a citation to the document's asset id, not its document id", async () => {
    await ask();

    const link = (await screen.findByRole("link", { name: "runbook.md" })) as HTMLAnchorElement;
    const url = new URL(link.href);
    expect(url.pathname).toBe("/api/v1/assets/asset-9");
    // The old link was `/api/v1/assets/doc-1`, which is not an asset id and never resolved.
    expect(link.href).not.toContain("doc-1");
    // And it carries the scope, or the asset route refuses it for lack of a project.
    expect(url.searchParams.get("projectId")).toBe("project-1");
  });

  it("renders a source with no stored bytes as plain text rather than a dead link", async () => {
    await ask();

    // Waiting on the resolvable link first guarantees the lookup round has finished, so this
    // is asserting a settled state rather than the in-flight one.
    await screen.findByRole("link", { name: "runbook.md" });
    expect(screen.getByText("handbook.txt")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "handbook.txt" })).toBeNull();
  });

  it("shows the answer even when the document lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/auth/me")) {
          return json({
            user: { id: "u1", email: "a@example.com", displayName: "A", isSystemAdmin: false },
            projects: [{ id: "project-1", name: "Default", organizationId: "org-1", role: "admin" }],
          });
        }
        if (url.includes("/api/v1/rag/query")) return json(ANSWER);
        return json({ error: { code: "NOT_FOUND", message: "gone" } }, 404);
      })
    );

    await ask();

    // The answer is what the user asked for; a failed citation lookup must not take it away.
    expect(await screen.findByText("Roll back with the documented script. [1]")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("runbook.md")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "runbook.md" })).toBeNull();
  });
});
