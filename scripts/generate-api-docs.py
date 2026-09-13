# -*- coding: utf-8 -*-
"""Generate docs/API.md from the ACTUAL route registrations — docs/26_DECISIONS.md ADR-112.

Written as a generator rather than hand-authored prose because a hand-written API document is
wrong the moment a route changes. The first version of this generator was wrong as well, in a way
worth recording: it labelled each route from a fixed 1400-character window after its path, so a
route inherited its NEIGHBOUR's guard and rate limit. Dead-letter replay was published as
administrator-only because `const requireSystemAdmin = ...` sat 23 lines below it; login and
logout as needing a credential; `me` and `projects` as `project:admin`; a 300/minute route as 30.

Every label is now read from the route's own registration only — its options object for the rate
limit, its handler up to the next registration for the guard, the earliest guard call winning —
and the public paths come from server.ts rather than from the absence of a guard. A route with no
guard that is not public stops the generator instead of being labelled by guesswork.

And the output is checked against real requests (backend/src/routes/api-contract.test.ts), because
a scraper can be wrong while agreeing perfectly with itself.
"""
import glob
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

ROUTE_RE = re.compile(r"app\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*\"([^\"]+)\"", re.S)
GUARDS = [
    (re.compile(r"requireSystemAdmin\(request\)"), "admin"),
    (re.compile(r"requireProject\(\s*request,\s*ctx\.auth,\s*\"([^\"]+)\"\s*\)"), "permission"),
    (re.compile(r"requireUser\(request\)"), "user"),
]
# The fixed-UUID literals the tests use as "definitely absent" ids are not routes.
NOT_ROUTES = ("00000000-0000-0000-0000-000000000000", "/api/v1/memory/some-id")


def read(path):
    return io.open(path, encoding="utf-8").read()


def fail(message):
    print("generate-api-docs: " + message, file=sys.stderr)
    sys.exit(1)


server = read("backend/src/server.ts")
public_match = re.search(r"const PUBLIC_PATHS = \[(.*?)\];", server, re.S)
if not public_match:
    fail("PUBLIC_PATHS was not found in backend/src/server.ts")
PUBLIC = re.findall(r'"([^"]+)"', public_match.group(1))

global_match = re.search(r"app\.register\(rateLimit,\s*\{.*?max:\s*(\d+),\s*timeWindow:\s*\"([^\"]+)\"", server, re.S)
if not global_match:
    fail("the global rate limit was not found in backend/src/server.ts")
GLOBAL_RATE = f"global ({global_match.group(1)} / {global_match.group(2)})"


def rate_expression(expr):
    expr = expr.strip()
    if expr.isdigit():
        return expr
    configured = re.fullmatch(r"ctx\.authRateLimitMax(?:\s*\*\s*(\d+))?", expr)
    if configured:
        return (configured.group(1) + " × " if configured.group(1) else "") + "`AUTH_RATE_LIMIT_MAX`"
    fail(f"unrecognised rate-limit expression {expr!r}: teach rate_expression() what it means")


routes = []
for path in sorted(glob.glob("backend/src/routes/**/*.ts", recursive=True)):
    if ".test." in path:
        continue
    src = read(path)
    matches = list(ROUTE_RE.finditer(src))
    for i, m in enumerate(matches):
        method, url = m.group(1).upper(), m.group(2)
        if any(literal in url for literal in NOT_ROUTES):
            continue
        # This route's registration and nothing after it.
        end = matches[i + 1].start() if i + 1 < len(matches) else len(src)
        window = src[m.end():end]
        handler_at = window.find("async (")
        if handler_at == -1:
            fail(f"{method} {url} ({path}): no `async (` handler found")
        options, body = window[:handler_at], window[handler_at:]

        guards = sorted(
            (g.start(), kind, g.group(1) if kind == "permission" else None)
            for rx, kind in GUARDS
            for g in rx.finditer(body)
        )
        if url in PUBLIC:
            auth = "public"
        elif not guards:
            fail(f"{method} {url} ({path}) calls no guard and is not in PUBLIC_PATHS")
        else:
            _, kind, permission = guards[0]
            if kind == "admin":
                auth = "system administrator"
            elif kind == "permission":
                auth = f"session or API key · `{permission}`"
            elif re.search(r'request\.auth\?\.method !== "session"', body):
                auth = "session only · authentication only"
            else:
                auth = "session or API key · authentication only"

        limit = re.search(r"rateLimit:\s*\{\s*max:\s*([^,]+?),\s*timeWindow:\s*\"([^\"]+)\"", options, re.S)
        if limit:
            rate = f"{rate_expression(limit.group(1))} / {limit.group(2)}"
            if "keyGenerator" in options:
                rate += " per user"
        else:
            rate = GLOBAL_RATE
        routes.append({"method": method, "url": url, "auth": auth, "rate": rate})

groups = {}
for r in routes:
    key = "/".join(r["url"].split("/")[:4]) or r["url"]
    groups.setdefault(key, []).append(r)

public_list = ", ".join(
    f"`{r['method']} {r['url']}`" for r in sorted(routes, key=lambda x: x["url"]) if r["auth"] == "public"
)

out = []
out.append("# API Reference\n")
out.append("**Generated from the route registrations in `backend/src/routes/` — do not hand-edit.**")
out.append("Regenerate with `npm run docs:api`; CI fails if this file differs from what the generator")
out.append("produces, and `backend/src/routes/api-contract.test.ts` sends a real request for every row")
out.append("below to check that the documented access and rate limit are the ones the server applies.\n")
out.append(f"**{len(routes)} routes.** Base URL is the backend origin (`NEXT_PUBLIC_API_URL` for the frontend).\n")
out.append("## Conventions\n")
out.append(f"""
**Authentication.** Two credentials are accepted: a session cookie (`aip_session`, httpOnly) or a
bearer API key. Every path except the public ones requires one, and authenticating grants nothing
by itself — each route names what it needs, in the Auth column:

- `public` — no credential.
- `session or API key · authentication only` — any signed-in caller; no project permission.
- `session only` — an API key is refused with 403. Deleting an account is not something a
  project-scoped automation credential may do.
- `session or API key · `permission`` — the caller's role in the project must grant it. Roles and
  what they grant are one static table: `PROJECT_ROLE_PERMISSIONS` and `ORG_ROLE_PERMISSIONS` in
  `shared/src/auth.ts`. A missing permission is 403 `PERMISSION_DENIED`.
- `system administrator` — platform-wide rather than project-wide, and 404 to anyone else.

**Project scope.** Every content route is scoped to one project. A session-authenticated caller
names it with the `x-project-id` header, or `?projectId=` where a header is impossible (SSE, and
`<img src>`). An API key is bound to its project.

**Tenant isolation: 404, with one 403.** A project the caller has no membership in returns 404,
exactly like one that does not exist, so an id confirms nothing. Membership is the only way into a
project: a system administrator has no implicit access to any tenant's project (ADR-108). The one
403 is an API key naming a project other than the one it is bound to — the answer is the same for
every other id, real or not, so it confirms nothing either.

**CSRF.** A mutating request authenticated by cookie must echo the `aip_csrf` cookie in the
`x-csrf-token` header (double-submit). API-key callers are exempt — they are not browsers.

**Client address.** Per-IP rate limits and audit rows use the connection's address, or the entry
the deployment's own proxies appended to `X-Forwarded-For` when `TRUST_PROXY_HOPS` says there are
any (ADR-112). A caller cannot choose its address by sending the header.

**Errors.** Every error is `{{ "error": {{ "code", "message", "requestId" }} }}`. Codes:
`VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `PERMISSION_DENIED` (403), `NOT_FOUND` (404),
`CONFLICT` (409), `RATE_LIMITED` (429), `QUOTA_EXCEEDED` (429), `CAPABILITY_UNAVAILABLE` (501),
`SERVICE_UNAVAILABLE` (503).

`CAPABILITY_UNAVAILABLE` is distinct on purpose: it means the request was correct and this
deployment has no provider that can serve it. A 503 would invite a retry that can never succeed,
and nothing is ever substituted with a fake result (ADR-050).

**Public paths:** {public_list}.
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
message, usage, provider, model and `finishReason`), `error`. The conversation id is the
`X-Conversation-Id` response header, not a field of any event.

An `EventSource` cannot set headers, so the agent event stream takes `?projectId=` and relies on
`withCredentials` for the session cookie.
""")

# LF on every platform, so the CI drift check compares like with like.
io.open("docs/API.md", "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
print(f"docs/API.md generated: {len(routes)} routes in {len(groups)} groups")
