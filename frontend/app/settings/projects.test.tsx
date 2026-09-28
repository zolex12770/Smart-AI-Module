import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Deleting a project from Settings — audit finding 18: the route had no caller anywhere. */
const deleteProject = vi.hoisted(() => vi.fn());
vi.mock("../lib/auth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth-client")>()),
  deleteProject: (id: string) => deleteProject(id),
}));
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  listApiKeys: async () => ({ apiKeys: [] }),
  listSessions: async () => ({ sessions: [] }),
  listAudit: async () => ({ entries: [] }),
  listMyInvitations: async () => ({ invitations: [] }),
  listProjectInvitations: async () => ({ invitations: [] }),
  listProjectMembers: async () => ({ members: [] }),
}));
const refresh = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/session-context", () => ({
  useSession: () => ({
    user: { id: "u1", email: "a@b.c", displayName: "A", isSystemAdmin: false },
    projects: [
      { id: "p1", name: "Main", organizationId: "o1", role: "admin" },
      { id: "p2", name: "Scratch", organizationId: "o1", role: "admin" },
      { id: "p3", name: "Shared", organizationId: "o2", role: "viewer" },
    ],
    projectId: "p1",
    selectProject: vi.fn(),
    refresh,
    signOut: vi.fn(),
  }),
  RequireSession: ({ children }: { children: ReactNode }) => <>{children}</>,
  Can: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import SettingsPage from "./page";

describe("Settings project deletion", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("offers Delete only on projects the user administers, and deletes after confirmation", async () => {
    deleteProject.mockResolvedValue({ ok: true, notStopped: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage />);
    expect(screen.queryByRole("button", { name: /delete project shared/i })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /delete project scratch/i }));
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p2"));
    expect(await screen.findByText(/"Scratch" was deleted\./)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    const { ApiError } = await import("../lib/auth-client");
    deleteProject.mockRejectedValue(new ApiError(400, "VALIDATION_ERROR", "This is the organization's last project."));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /delete project main/i }));
    expect(await screen.findByText(/last project/i)).toBeTruthy();
  });
});
