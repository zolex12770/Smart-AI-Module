"use client";

import { API_URL } from "./api";

/**
 * Browser-side authentication state — docs/26_DECISIONS.md ADR-049.
 *
 * The session itself is an httpOnly cookie the browser holds and this code can never read;
 * that is deliberate, because it means an XSS bug cannot exfiltrate a session. What this
 * module holds is only the *non-secret* half: the current user, their projects, and the CSRF
 * token that must be echoed on every mutating request.
 *
 * Every fetch goes through `apiFetch`, which is the one place that adds `credentials:
 * "include"`, the CSRF header and the selected project — so no page can accidentally make an
 * unauthenticated or unscoped call.
 */

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isSystemAdmin: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  organizationId: string;
  role: string;
  /**
   * What this user may actually do in this project — ADR-148.
   *
   * Sent by the API from `resolvePermissions`, the same function that decides real requests, so
   * a screen never has to guess from `role`. An organization owner holding a `viewer` project
   * row is authorized through their org role; a UI that read `role` alone would hide controls
   * from someone the API obeys. Older servers omit it, so readers treat it as possibly absent.
   */
  permissions?: string[];
}

const CSRF_COOKIE = "aip_csrf";
const PROJECT_STORAGE_KEY = "aip.selectedProjectId";

export function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : null;
}

export function getSelectedProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setSelectedProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
  } catch {
    /* private browsing — the project is still sent per-request from memory */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /**
   * Serialised as JSON, unless it is a `FormData` — see the note on `apiFetch` about why
   * multipart has to pass through untouched.
   */
  body?: unknown;
  /** Overrides the stored selection; most callers should omit it. */
  projectId?: string | null;
  /** Set for endpoints that are genuinely project-independent (login, signup, /me). */
  unscoped?: boolean;
}

/**
 * The single entry point for talking to the backend. The frontend never touches the database
 * and holds no business logic — it calls the API, which owns authorization (product brief §2,
 * §25).
 *
 * A `FormData` body is the one thing that is NOT serialised here, and that exception is what
 * lets the multipart upload (ADR-041) go through this function instead of around it. Two
 * properties have to hold for `POST /api/v1/files/upload` to work at all:
 *
 * - The body must reach `fetch` as the `FormData` object itself. `JSON.stringify(formData)`
 *   produces `"{}"` — the upload would arrive empty and the route would reject it with
 *   "Multipart body must include a file field".
 * - No `Content-Type` header may be set. The multipart content type carries a boundary token
 *   that only the browser knows; declaring `application/json` (or even a bare
 *   `multipart/form-data` without the boundary) makes @fastify/multipart unable to parse the
 *   body. Leaving the header off is what lets `fetch` write the correct one with its boundary.
 *
 * Routing the upload through here rather than a bare `fetch` is the point: credentials, the
 * CSRF header and the project scope are added in exactly one place, and an upload that skips
 * them is a 401 — which is precisely the bug this exception exists to fix.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, projectId, unscoped, headers, ...rest } = options;
  const method = (rest.method ?? "GET").toUpperCase();
  const finalHeaders = new Headers(headers);
  const isMultipart = typeof FormData !== "undefined" && body instanceof FormData;

  if (body !== undefined && !isMultipart) finalHeaders.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = readCsrfToken();
    // Without this the server rejects the request; surfacing it here gives a clearer error
    // than a bare 403 from a cookie-authenticated call.
    if (csrf) finalHeaders.set("x-csrf-token", csrf);
  }
  if (!unscoped) {
    const scope = projectId ?? getSelectedProjectId();
    if (scope) finalHeaders.set("x-project-id", scope);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    method,
    headers: finalHeaders,
    // Sends the httpOnly session cookie cross-origin (the API is a separate deployment).
    credentials: "include",
    body: body === undefined ? undefined : isMultipart ? (body as FormData) : JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? `Request failed (${response.status})`
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- session lifecycle -------------------------------------------------------------------

export async function signup(input: {
  email: string;
  password: string;
  displayName: string;
  organizationName?: string;
}): Promise<{ user: SessionUser; defaultProjectId: string }> {
  const result = await apiFetch<{ user: SessionUser; defaultProjectId: string }>("/api/v1/auth/signup", {
    method: "POST",
    body: input,
    unscoped: true,
  });
  setSelectedProjectId(result.defaultProjectId);
  return result;
}

export async function login(email: string, password: string): Promise<{ user: SessionUser; projects: ProjectSummary[] }> {
  const result = await apiFetch<{ user: SessionUser; projects: ProjectSummary[] }>("/api/v1/auth/login", {
    method: "POST",
    body: { email, password },
    unscoped: true,
  });
  if (result.projects[0]) setSelectedProjectId(result.projects[0].id);
  return result;
}

export async function logout(): Promise<void> {
  await apiFetch("/api/v1/auth/logout", { method: "POST", unscoped: true });
}

export async function fetchSession(): Promise<{ user: SessionUser; projects: ProjectSummary[] } | null> {
  try {
    return await apiFetch<{ user: SessionUser; projects: ProjectSummary[] }>("/api/v1/auth/me", { unscoped: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export async function createProject(name: string, description?: string): Promise<ProjectSummary> {
  const result = await apiFetch<{ project: { id: string; name: string } }>("/api/v1/projects", {
    method: "POST",
    body: { name, description },
    unscoped: true,
  });
  return { ...result.project, organizationId: "", role: "admin" };
}
