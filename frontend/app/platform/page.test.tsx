import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The platform screen asked `/api/v1/admin/health` for EVERY member, got the deliberate 404, and so
 * put a failed request in every non-administrator's browser console (found by the real-browser
 * route audit). It now asks only when the signed-in user is a system administrator.
 */
const apiFetch = vi.fn(async (path: string) => {
  if (path === "/api/v1/admin/health") return { status: "ok", checks: { database: "ok" } };
  if (path === "/api/v1/models") return { models: [] };
  if (path === "/api/v1/tools") return { tools: [] };
  if (path === "/api/v1/mcp") return { servers: [] };
  if (path === "/api/v1/jobs") return { jobs: [] };
  if (path === "/api/v1/jobs/dead-letter") return { deadLettered: [] };
  return {};
});
vi.mock("../lib/auth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth-client")>()),
  apiFetch: (path: string) => apiFetch(path),
}));

let isSystemAdmin = false;
vi.mock("../lib/session-context", () => ({
  useSession: () => ({ projectId: "p1", user: { id: "u1", isSystemAdmin } }),
  RequireSession: ({ children }: { children: ReactNode }) => <>{children}</>,
  SystemAdminOnly: ({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) => (
    <>{isSystemAdmin ? children : fallback}</>
  ),
  Can: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import PlatformPage from "./page";

describe("the platform screen", () => {
  afterEach(() => apiFetch.mockClear());

  it("does not ask a member's browser to fetch the admin-only readiness endpoint", async () => {
    isSystemAdmin = false;
    render(<PlatformPage />);
    await screen.findByText(/visible to system administrators only/i);
    expect(apiFetch.mock.calls.map((c) => c[0])).not.toContain("/api/v1/admin/health");
  });

  it("does fetch it for a system administrator", async () => {
    isSystemAdmin = true;
    render(<PlatformPage />);
    await waitFor(() => expect(apiFetch.mock.calls.map((c) => c[0])).toContain("/api/v1/admin/health"));
  });
});
