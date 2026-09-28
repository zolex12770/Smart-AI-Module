import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Invitations in Settings — docs/DECISION_LOG.md DL-7. Adding a member used to attach an existing
 * account at once; it now sends an invitation, and the invitee accepts from their own Settings.
 */
const api = vi.hoisted(() => ({
  addProjectMember: vi.fn(),
  answerInvitation: vi.fn(async () => ({ ok: true })),
  listMyInvitations: vi.fn(),
  listProjectInvitations: vi.fn(async () => ({ invitations: [] })),
  listProjectMembers: vi.fn(async () => ({
    members: [{ userId: "u1", email: "a@b.c", displayName: "A", role: "admin" }],
  })),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  ...api,
  listApiKeys: async () => ({ apiKeys: [] }),
  listSessions: async () => ({ sessions: [] }),
  listAudit: async () => ({ entries: [] }),
}));

const session = vi.hoisted(() => ({ refresh: vi.fn(async () => undefined), selectProject: vi.fn() }));
vi.mock("../lib/session-context", () => ({
  useSession: () => ({
    user: { id: "u1", email: "a@b.c", displayName: "A", isSystemAdmin: false },
    projects: [{ id: "p1", name: "P", organizationId: "o1", role: "admin", permissions: ["project:admin"] }],
    projectId: "p1",
    selectProject: session.selectProject,
    refresh: session.refresh,
    signOut: vi.fn(),
  }),
  RequireSession: ({ children }: { children: ReactNode }) => <>{children}</>,
  Can: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import SettingsPage from "./page";

describe("Settings invitations", () => {
  afterEach(() => vi.clearAllMocks());

  it("tells the admin an invitation was sent, not that someone was added", async () => {
    api.listMyInvitations.mockResolvedValue({ invitations: [] });
    api.addProjectMember.mockResolvedValue({
      status: "invited",
      email: "new@example.test",
      role: "editor",
      expiresAt: "2026-10-12T00:00:00.000Z",
    });
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText(/invite by email/i), { target: { value: "new@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: /^invite$/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/invitation sent to new@example.test as editor/i);
    expect(api.addProjectMember).toHaveBeenCalledWith("p1", "new@example.test", "editor");
  });

  it("lets the invitee accept, then switches to the project they joined", async () => {
    api.listMyInvitations
      .mockResolvedValueOnce({
        invitations: [
          { id: "inv1", projectId: "p9", projectName: "Harbour", role: "viewer", invitedBy: "Ada", expiresAt: "2026-10-12T00:00:00.000Z" },
        ],
      })
      .mockResolvedValue({ invitations: [] });
    render(<SettingsPage />);
    expect(await screen.findByText("Harbour")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^accept$/i }));
    await waitFor(() => expect(api.answerInvitation).toHaveBeenCalledWith("inv1", "accept"));
    await waitFor(() => expect(session.selectProject).toHaveBeenCalledWith("p9"));
    expect(session.refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Harbour")).toBeNull());
  });
});
