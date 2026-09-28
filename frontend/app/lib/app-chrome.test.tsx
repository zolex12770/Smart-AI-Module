import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary, SessionUser } from "./auth-client";

/**
 * Found by the real-browser acceptance (scripts/acceptance/browser.mjs, LOGOUT-LOGIN): after
 * "Sign out" the chat screen asked for /conversations and /models AGAIN, with no session, and
 * put two 401s in the console. Most screens were not behind `RequireSession`, so they fetched
 * before the session was known and re-fetched when sign-out cleared the project. The chrome now
 * holds every non-public screen until the session is confirmed, and drops it on sign-out.
 */
const pathname = vi.hoisted(() => ({ value: "/chat" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname.value,
}));

const session = vi.hoisted(() => ({
  value: null as { user: SessionUser; projects: ProjectSummary[] } | null,
  resolve: null as null | (() => void),
  logout: null as null | (() => Promise<void>),
}));

vi.mock("./auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-client")>();
  return {
    ...actual,
    fetchSession: () =>
      new Promise((resolve) => {
        session.resolve = () => resolve(session.value);
      }),
    readStoredProjectId: () => null,
    storeProjectId: () => undefined,
    logout: () => (session.logout ? session.logout() : Promise.resolve()),
  };
});

const { SessionProvider, useSession } = await import("./session-context");
const { AppChrome } = await import("./app-chrome");

const fetches: Array<string | null> = [];
/** Stands in for a screen: it loads its data whenever the selected project changes. */
function Screen() {
  const { projectId } = useSession();
  useEffect(() => {
    fetches.push(projectId);
  }, [projectId]);
  return <p>screen body</p>;
}

function mount() {
  return render(
    <SessionProvider>
      <AppChrome>
        <Screen />
      </AppChrome>
    </SessionProvider>
  );
}

const signedIn = {
  user: { id: "u1", email: "a@b.c", displayName: "A", isSystemAdmin: false } as SessionUser,
  projects: [{ id: "p1", name: "P", organizationId: "o1", role: "owner" } as ProjectSummary],
};

describe("AppChrome session gate", () => {
  afterEach(() => {
    fetches.length = 0;
    session.value = null;
    pathname.value = "/chat";
    session.logout = null;
  });

  it("renders no screen, and so fetches nothing, before the session is known", async () => {
    session.value = signedIn;
    mount();
    expect(screen.queryByText("screen body")).toBeNull();
    expect(fetches).toEqual([]);
    await act(async () => session.resolve?.());
    await screen.findByText("screen body");
    expect(fetches).toEqual(["p1"]);
  });

  it("drops the screen on sign-out instead of letting it fetch again without a session", async () => {
    session.value = signedIn;
    mount();
    await act(async () => session.resolve?.());
    await screen.findByText("screen body");
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(screen.queryByText("screen body")).toBeNull());
    expect(fetches).toEqual(["p1"]);
  });

  it("still renders the public screens without a session", async () => {
    pathname.value = "/login";
    mount();
    expect(screen.getByText("screen body")).toBeTruthy();
  });

  it("stays signed in, and says so, when the server refuses the sign-out", async () => {
    // Audit finding 16: a refused logout (a 403, a network error) was swallowed and the screen
    // showed signed-out while the server session stayed valid.
    const { ApiError } = await import("./auth-client");
    session.logout = () => Promise.reject(new ApiError(403, "CSRF_FAILED", "CSRF token missing or invalid."));
    session.value = signedIn;
    mount();
    await act(async () => session.resolve?.());
    await screen.findByText("screen body");
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/still signed in/i);
    expect(screen.getByText("screen body")).toBeTruthy();
  });

  it("signs out locally when the server says there was no session to end", async () => {
    const { ApiError } = await import("./auth-client");
    session.logout = () => Promise.reject(new ApiError(401, "UNAUTHORIZED", "Authentication required."));
    session.value = signedIn;
    mount();
    await act(async () => session.resolve?.());
    await screen.findByText("screen body");
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(screen.queryByText("screen body")).toBeNull());
  });
});
