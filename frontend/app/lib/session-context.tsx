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

/**
 * The routes only a SYSTEM ADMINISTRATOR may call — docs/26_DECISIONS.md ADR-144.
 *
 * This list is the frontend's half of a boundary the backend already enforces
 * (`requireSystemAdmin` in `backend/src/routes/v1/platform.ts`, and the authority table
 * `PLATFORM_ROUTE_PERMISSIONS` beside it). It exists so a control that calls one of these can be
 * found mechanically rather than by remembering — `session-context.admin.test.tsx` walks every
 * screen, finds the calls, and fails if one is rendered outside `SystemAdminOnly`.
 *
 * The prompt for that test was a real defect: ADR-136 added an Enable button for MCP tools and
 * offered it to every user, while the endpoint answers 404 to anyone who is not an administrator.
 * Its component test passed because it mocked the API, which is where the refusal lives.
 */
export const SYSTEM_ADMIN_ONLY_ROUTES = [
  "/api/v1/tools/:id/enable",
  "/api/v1/mcp/:id/reconnect",
  "/api/v1/admin/health",
  "/api/v1/admin/metrics",
  "/api/v1/admin/stats",
] as const;

/** The client functions that call them. Kept beside the routes so the pair cannot drift. */
export const SYSTEM_ADMIN_ONLY_CLIENTS = ["setToolEnabled", "reconnectMcpServer"] as const;

/**
 * Renders its children only for a system administrator — ADR-144.
 *
 * `fallback` is for saying WHOSE decision something is. A control that simply vanishes teaches a
 * user that the feature does not exist; one that explains who can use it is the difference between
 * a missing button and an answered question.
 *
 * This is deliberately not a security control — the backend is, and it refuses regardless. It is
 * how the interface stops offering an action the person looking at it cannot take.
 */
export function SystemAdminOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { user } = useSession();
  return <>{user?.isSystemAdmin ? children : fallback}</>;
}

/**
 * What the signed-in user may do in the SELECTED project — docs/26_DECISIONS.md ADR-148.
 *
 * The agent screen offered Approve, Reject and Cancel to everyone who could open a task, and the
 * task is readable with `project:read` while those three need `agent:approve` and `agent:run`.
 * A viewer saw three fully-enabled buttons on the approval gate the whole trust boundary rests
 * on, pressed one, got a 403 nobody rendered, and watched the card not move.
 *
 * The permissions come from the API, computed by the same `resolvePermissions` the request path
 * authorizes with, so this cannot drift from what the server will do. It is not a security
 * control — the server refuses regardless — it is how the interface stops offering an action the
 * person looking at it cannot take, and says who can.
 */
export function useProjectPermissions(): readonly string[] {
  const { projects, projectId } = useSession();
  return projects.find((p) => p.id === projectId)?.permissions ?? [];
}

export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const permissions = useProjectPermissions();
  return <>{permissions.includes(permission) ? children : fallback}</>;
}
