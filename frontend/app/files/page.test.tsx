import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FilesPage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/files",
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const SAMPLE_DOC = {
  id: "doc-1",
  filename: "policy.pdf",
  sourcePath: null,
  assetId: "asset-12345678",
  status: "ready" as const,
  scanStatus: "clean" as const,
  errorMessage: null,
  createdAt: new Date().toISOString(),
};

describe("Files page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.setItem("ai-platform.projectId", "project-1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("renders honest document parsing and embedding disclosures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ documents: [] })));
    render(<FilesPage />);
    expect(screen.getByText(/Real native extraction for \.pdf \(pdfjs-dist\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Token-aware sliding chunker/i)).toBeInTheDocument();
    expect(screen.getByText(/Lexical feature-hash vector space/i)).toBeInTheDocument();
    expect(screen.getByText(/Project-scoped pgvector PostgreSQL storage/i)).toBeInTheDocument();
  });

  it("renders listed documents with status badge and remove button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ documents: [SAMPLE_DOC] })));
    render(<FilesPage />);

    expect(await screen.findByText("policy.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
  });

  it("calls delete endpoint when remove button is clicked", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return json({ ok: true });
      return json({ documents: [SAMPLE_DOC] });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<FilesPage />);
    await user.click(await screen.findByRole("button", { name: /remove/i }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "DELETE");
      expect(del).toBeTruthy();
      expect(String(del?.[0])).toContain("/api/v1/files/doc-1");
    });
  });
});
