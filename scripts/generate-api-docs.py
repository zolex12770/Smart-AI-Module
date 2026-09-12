# -*- coding: utf-8 -*-
"""Generate docs/API.md from the ACTUAL route registrations.

Written as a generator rather than hand-authored prose because a hand-written API document is
wrong the moment a route changes, and this repository has already been bitten twice by
documentation that described a shape the code did not have.
"""
import io, os, re, glob, json

ROOT = r"C:\Users\Saurabh.kumar\Desktop\AI"
os.chdir(ROOT)

ROUTE_RE = re.compile(
    r"app\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*\"([^\"]+)\"", re.S
)

routes = []
for path in sorted(glob.glob("backend/src/routes/**/*.ts", recursive=True)):
    if ".test." in path:
        continue
    src = io.open(path, encoding="utf-8").read()
    for m in ROUTE_RE.finditer(src):
        method, url = m.group(1).upper(), m.group(2)
        # The permission / auth posture is stated by the guard called inside the handler.
        tail = src[m.end(): m.end() + 1400]
        if "requireSystemAdmin" in tail:
            auth = "system administrator"
        else:
            perm = re.search(r'requireProject\([^,]+,[^,]+,\s*"([^"]+)"', tail)
            if perm:
                auth = f"session or API key · `{perm.group(1)}`"
            elif "requireUser" in tail:
                auth = "session or API key"
            else:
                auth = "public"
        rl = re.search(r"rateLimit:\s*\{\s*max:\s*([^,]+),\s*timeWindow:\s*\"([^\"]+)\"", tail)
        rate = f"{rl.group(1).strip()} / {rl.group(2)}" if rl else "global (300/min)"
        routes.append({"method": method, "url": url, "auth": auth, "rate": rate,
                       "file": path.replace("\\", "/")})

# Drop the fixed-UUID literals the tests use as "definitely absent" ids.
routes = [r for r in routes if "00000000-0000-0000-0000-000000000000" not in r["url"]
          and r["url"] not in ("/api/v1/memory/some-id",)]

groups = {}
for r in routes:
    key = "/".join(r["url"].split("/")[:4]) or r["url"]
    groups.setdefault(key, []).append(r)

out = []
out.append("# API Reference\n")
out.append("**Generated from the route registrations in `backend/src/routes/` — do not hand-edit.**")
out.append("Regenerate with `npm run docs:api`. A hand-written API document is wrong the moment a")
out.append("route changes, and this repository has twice shipped documentation describing a shape the")
out.append("code did not have.\n")
out.append(f"**{len(routes)} routes.** Base URL is the backend origin (`NEXT_PUBLIC_API_URL` for the frontend).\n")
out.append("## Conventions\n")
out.append("""
**Authentication.** Two credentials are accepted: a session cookie (`aip_session`, httpOnly) or a
bearer API key. Everything except the four public paths below requires one, and the auth plugin
grants nothing by itself — each route names the single permission it needs.

**Project scope.** Every content route is scoped to one project. A session-authenticated caller
names it with the `x-project-id` header, or `?projectId=` where a header is impossible (SSE, and
`<img src>`). An API key is bound to its project and cannot act outside it.

**A resource in another tenant returns 404, never 403.** Confirming that an id exists is itself a
disclosure. The same rule makes every administrator-only route answer 404 to everyone else.

**CSRF.** A mutating request authenticated by cookie must echo the `aip_csrf` cookie in the
`x-csrf-token` header (double-submit). API-key callers are exempt — they are not browsers.

**Errors.** Every error is `{ "error": { "code", "message", "requestId" } }`. Codes:
`VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `PERMISSION_DENIED` (403), `NOT_FOUND` (404),
`CONFLICT` (409), `RATE_LIMITED` (429), `QUOTA_EXCEEDED` (429), `CAPABILITY_UNAVAILABLE` (501),
`SERVICE_UNAVAILABLE` (503).

`CAPABILITY_UNAVAILABLE` is distinct on purpose: it means the request was correct and this
deployment has no provider that can serve it. A 503 would invite a retry that can never succeed,
and nothing is ever substituted with a fake result (ADR-050).

**Public paths:** `GET /api/health`, `POST /api/v1/auth/signup`, `POST /api/v1/auth/login`,
`POST /api/v1/auth/logout`.
""")

for key in sorted(groups):
    out.append(f"\n## `{key}`\n")
    out.append("| Method | Path | Auth / permission | Rate limit |")
    out.append("|---|---|---|---|")
    for r in sorted(groups[key], key=lambda x: (x["url"], x["method"])):
        out.append(f"| `{r['method']}` | `{r['url']}` | {r['auth']} | {r['rate']} |")

out.append("\n## Streaming\n")
out.append("""
`POST /api/v1/chat` and `GET /api/v1/agent/tasks/:id/events` stream Server-Sent Events framed as
`event: <type>\\ndata: <json>\\n\\n`. Parsers must accept all three spec separators (`\\n\\n`,
`\\r\\n\\r\\n`, `\\r\\r`) — assuming only the first was a real bug on both sides of the wire.

Chat events: `token` (a delta), `tool_call`, `done` (the terminal event, carrying the assembled
message, usage, provider, model and `finishReason`), `error`.

An `EventSource` cannot set headers, so the agent event stream takes `?projectId=` and relies on
`withCredentials` for the session cookie.
""")

io.open("docs/API.md", "w", encoding="utf-8").write("\n".join(out) + "\n")
print(f"docs/API.md generated: {len(routes)} routes in {len(groups)} groups")
