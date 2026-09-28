import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiFetch,
  fetchSession,
  getSelectedProjectId,
  login,
  logout,
  readCsrfToken,
  setSelectedProjectId,
  signup,
} from "./auth-client";

/**
 * ADR-068. `apiFetch` is the single place the browser talks to the backend, so every
 * authorization property the API relies on is a property of this function: the session cookie
 * must be sent cross-origin, mutating requests must carry the CSRF token, and every request
 * must carry the selected project or the server has no scope to authorize against.
 *
 * These are the frontend half of ADR-049 — a bug here presents as "the whole app is 401" or,
 * worse, as requests silently landing in the wrong project.
 */
describe("apiFetch", () => {
  beforeEach(() => {
    document.cookie = "aip_csrf=token-abc";
    window.localStorage.setItem("aip.selectedProjectId", "project-1");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.cookie = "aip_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  const ok = (body: unknown = { ok: true }, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  it("always sends credentials, so the httpOnly session cookie reaches a cross-origin API", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/v1/files");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("sends the project scope on every request", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/v1/files");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("x-project-id")).toBe("project-1");
  });

  it("adds the CSRF token to mutating requests but not to reads", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/v1/files");
    await apiFetch("/api/v1/files", { method: "POST", body: { path: "a.txt" } });

    const [, read] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, write] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    // A GET cannot be forged cross-site in a way CSRF protects against, and requiring the
    // header there would only break reads on a page loaded before the cookie was set.
    expect((read.headers as Headers).get("x-csrf-token")).toBeNull();
    expect((write.headers as Headers).get("x-csrf-token")).toBe("token-abc");
  });

  it("omits the project scope for genuinely project-independent endpoints", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/v1/auth/me", { unscoped: true });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("x-project-id")).toBeNull();
  });

  it("throws a typed ApiError carrying the server's code and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "PERMISSION_DENIED", message: "Needs chat:write." } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          })
      )
    );

    const error = await apiFetch("/api/v1/chat", { method: "POST", body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(403);
    expect(apiError.code).toBe("PERMISSION_DENIED");
    expect(apiError.message).toBe("Needs chat:write.");
  });

  it("falls back to a status message when the body is not the error envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    const error = (await apiFetch("/api/v1/files").catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("UNKNOWN");
    expect(error.message).toMatch(/502/);
  });

  it("serialises a body as JSON and sets the content type only when there is one", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/v1/memory", { method: "POST", body: { scope: "user", content: "x" } });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ scope: "user", content: "x" }));
  });
});

describe("session lifecycle", () => {
  afterEach(() => window.localStorage.clear());

  it("selects the new account's default project on signup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ user: { id: "u1" }, defaultProjectId: "p-new" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    await signup({ email: "a@example.com", password: "a-sufficiently-long-password", displayName: "A" });
    expect(getSelectedProjectId()).toBe("p-new");
  });

  it("selects the first project on login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ user: { id: "u1" }, projects: [{ id: "p-a" }, { id: "p-b" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );
    await login("a@example.com", "a-sufficiently-long-password");
    expect(getSelectedProjectId()).toBe("p-a");
  });

  it("treats a 401 from /me as anonymous rather than an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no" } }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    expect(await fetchSession()).toBeNull();
  });

  it("propagates a non-401 failure from /me instead of silently signing the user out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    // A server error is not the same as "you are logged out"; conflating them would log
    // everyone out during an incident.
    await expect(fetchSession()).rejects.toBeInstanceOf(ApiError);
  });

  it("posts to logout without requiring a project scope", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await logout();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/auth\/logout$/);
    expect(init.method).toBe("POST");
  });
});

describe("csrf and project storage helpers", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.cookie = "aip_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  it("reads the CSRF token from the non-httpOnly cookie", () => {
    document.cookie = "aip_csrf=abc123";
    expect(readCsrfToken()).toBe("abc123");
  });

  it("returns null when no CSRF cookie is present", () => {
    expect(readCsrfToken()).toBeNull();
  });

  it("round-trips the selected project", () => {
    setSelectedProjectId("p-42");
    expect(getSelectedProjectId()).toBe("p-42");
  });
});

/**
 * ADR-091 — the three frontend contract defects the final audit found. Each is a claim about a
 * REQUEST the browser makes, so each is asserted on the request that actually went out.
 */
describe("requests the API will actually accept", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.cookie = "aip_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  it("uploads through apiFetch with credentials, CSRF and project scope", async () => {
    document.cookie = "aip_csrf=tok";
    window.localStorage.setItem("aip.selectedProjectId", "project-1");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ document: { id: "d1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "a.txt");
    await apiFetch("/api/v1/files/upload", { method: "POST", body: form });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // POST /api/v1/files/upload calls requireProject before reading a byte, and a cookie-
    // authenticated mutation also needs the CSRF token. uploadFile used to call `fetch` directly
    // and send none of the three, so every upload was refused.
    expect(init.credentials).toBe("include");
    expect((init.headers as Headers).get("x-csrf-token")).toBe("tok");
    expect((init.headers as Headers).get("x-project-id")).toBe("project-1");
    // And the multipart body must reach fetch untouched, with NO content type — the browser
    // supplies one carrying the boundary token, and setting our own would corrupt the request.
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Headers).get("Content-Type")).toBeNull();
  });
});

/**
 * The web app and the API on DIFFERENT hosts (the Cloud Run topology). The API's aip_csrf cookie
 * is then not readable from this page, and every mutating request failed the double-submit check.
 * The token the API returns at login is what a mutating request must carry instead.
 */
describe("CSRF when the API is on another host", () => {
  afterEach(() => window.localStorage.clear());

  it("sends the token the login response carried, with no readable cookie", async () => {
    expect(document.cookie).not.toMatch(/aip_csrf=/);
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/auth/login")
        ? new Response(JSON.stringify({ user: { id: "u1" }, projects: [{ id: "p-a" }], csrfToken: "issued-token-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    await login("a@example.com", "a-sufficiently-long-password");
    await apiFetch("/api/v1/memory", { method: "POST", body: { content: "x" } });
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("issued-token-123");
  });
});
