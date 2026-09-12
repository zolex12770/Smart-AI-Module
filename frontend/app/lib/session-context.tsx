"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  fetchSession,
  getSelectedProjectId,
  logout as apiLogout,
  setSelectedProjectId,
  type ProjectSummary,
  type SessionUser,
} from "./auth-client";

/**
 * The one place the browser knows who is signed in and which project is selected
 * (docs/26_DECISIONS.md ADR-049).
 *
 * Two rules this enforces for every screen:
 *
 * 1. **No page renders user data before the session is known.** `status` starts as
 *    "loading"; a page that renders on "authenticated" only can never flash another
 *    tenant's data or an empty state that looks like "you have nothing".
 * 2. **A project is always selected.** Every API call is project-scoped server-side, so a
 *    screen without a project would just produce 400s. The provider picks the first project
 *    if none is stored, and re-validates the stored one against what the server actually
 *    returns — a project id from a previous account must not survive a re-login.
 */

export type SessionStatus = "loading" | "authenticated" | "anonymous";

interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
  projects: ProjectSummary[];
  projectId: string | null;
  selectProject(projectId: string): void;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/** Screens that must render without a session. Everything else redirects to /login. */
const PUBLIC_PATHS = ["/login", "/signup"];

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const session = await fetchSession();
      if (!session) {
        setStatus("anonymous");
        setUser(null);
        setProjects([]);
        setProjectId(null);
        return;
      }
      setUser(session.user);
      setProjects(session.projects);

      // Re-validate the stored selection against what this account can actually see.
      const stored = getSelectedProjectId();
      const valid = session.projects.find((p) => p.id === stored) ?? session.projects[0] ?? null;
      if (valid) {
        setProjectId(valid.id);
        setSelectedProjectId(valid.id);
      } else {
        setProjectId(null);
      }
      setStatus("authenticated");
    } catch {
      // A network failure is not the same as being signed out; treat it as anonymous for
      // routing purposes but let the screen show its own error state.
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (status === "anonymous" && !PUBLIC_PATHS.includes(pathname)) {
      router.replace("/login");
    }
  }, [status, pathname, router]);

  const selectProject = useCallback((next: string) => {
    setProjectId(next);
    setSelectedProjectId(next);
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout().catch(() => undefined);
    setStatus("anonymous");
    setUser(null);
    setProjects([]);
    setProjectId(null);
    router.replace("/login");
  }, [router]);

  const value = useMemo<SessionState>(
    () => ({ status, user, projects, projectId, selectProject, refresh, signOut }),
    [status, user, projects, projectId, selectProject, refresh, signOut]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>.");
  return ctx;
}

/**
 * Wraps a screen that requires a signed-in user. Renders nothing until the session is
 * resolved, so no authenticated screen ever paints with a null user.
 *
 * `requireProject` is on by default because nearly every screen reads project-scoped data and
 * would only produce 400s without a selection. Settings turns it off: it is the screen the
 * no-project message below sends the user to, so gating it on having a project would make that
 * instruction impossible to follow — the account with no project could never create one.
 */
export function RequireSession({
  children,
  requireProject = true,
}: {
  children: ReactNode;
  requireProject?: boolean;
}) {
  const { status, projectId, projects } = useSession();
  if (status === "loading") {
    return <p className="page-state">Loading your session…</p>;
  }
  if (status === "anonymous") {
    return <p className="page-state">Redirecting to sign in…</p>;
  }
  if (requireProject && !projectId && projects.length === 0) {
    return <p className="page-state">This account has no project yet. Create one from Settings.</p>;
  }
  return <>{children}</>;
}
