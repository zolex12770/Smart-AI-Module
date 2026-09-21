import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ProjectSummary, SessionUser } from "./auth-client";

/**
 * What the guards actually RENDER — docs/26_DECISIONS.md ADR-144, closed by ADR-159.
 *
 * `session-context.admin.test.tsx` walks every screen's source and asserts that an admin-only
 * control sits inside `<SystemAdminOnly>`. Every one of its assertions is a regex over another
 * file's text, and it deliberately excludes `lib/session-context.tsx` from the walk — so the
 * module that DEFINES the guard was the one thing never examined. If `SystemAdminOnly` were
 * changed to render its children unconditionally, every test in that suite would still pass and
 * every screen would offer every admin control to everyone.
 *
 * These mount the REAL provider over a stubbed session fetch, and assert on the DOM.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/platform",
}));

const session = vi.hoisted(() => ({
  value: null as { user: SessionUser; projects: ProjectSummary[] } | null,
}));

vi.mock("./auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-client")>();
  return {
    ...actual,
    fetchSession: async () => session.value,
    readStoredProjectId: () => null,
    storeProjectId: () => undefined,
    logout: async () => undefined,
  };
});

const { Can, SessionProvider, SystemAdminOnly } = await import("./session-context");

const user = (isSystemAdmin: boolean): SessionUser =>
  ({ id: "u1", email: "a@b.c", displayName: "A", isSystemAdmin }) as SessionUser;

const project = (permissions?: string[]): ProjectSummary => ({
  id: "p1",
  name: "P",
  organizationId: "o1",
  role: "editor",
  ...(permissions ? { permissions } : {}),
});

async function mount(ui: React.ReactNode) {
  const result = render(<SessionProvider>{ui}</SessionProvider>);
  // The provider starts in "loading" and renders nothing until the session resolves.
  await waitFor(() => expect(result.container.textContent).not.toBe(""));
  return result;
}

describe("SystemAdminOnly", () => {
  afterEach(() => {
    session.value = null;
  });

  it("renders its children for a system administrator", async () => {
    session.value = { user: user(true), projects: [project()] };
    await mount(
      <SystemAdminOnly fallback={<span>not allowed</span>}>
        <button>Enable</button>
      </SystemAdminOnly>
    );
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.queryByText("not allowed")).toBeNull();
  });

  it("renders the fallback, and NOT the control, for everyone else", async () => {
    session.value = { user: user(false), projects: [project()] };
    await mount(
      <SystemAdminOnly fallback={<span>not allowed</span>}>
        <button>Enable</button>
      </SystemAdminOnly>
    );
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    expect(screen.getByText("not allowed")).toBeInTheDocument();
  });
});

describe("Can", () => {
  afterEach(() => {
    session.value = null;
  });

  it("renders its children when the project grants the permission", async () => {
    session.value = { user: user(false), projects: [project(["agent:run", "agent:approve"])] };
    await mount(
      <Can permission="agent:approve" fallback={<span>ask an editor</span>}>
        <button>Approve</button>
      </Can>
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("renders the fallback when it does not", async () => {
    session.value = { user: user(false), projects: [project(["project:read"])] };
    await mount(
      <Can permission="agent:approve" fallback={<span>ask an editor</span>}>
        <button>Approve</button>
      </Can>
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("ask an editor")).toBeInTheDocument();
  });

  it("refuses when the server sent no permissions at all", async () => {
    // An older server omits the field. Failing closed is the only safe reading: the alternative
    // is a screen that offers every control because it could not find out.
    session.value = { user: user(false), projects: [project()] };
    await mount(
      <Can permission="agent:approve" fallback={<span>ask an editor</span>}>
        <button>Approve</button>
      </Can>
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
