# API Reference

**Generated from the route registrations in `backend/src/routes/` — do not hand-edit.**
Regenerate with `npm run docs:api`; CI fails if this file differs from what the generator
produces, and `backend/src/routes/api-contract.test.ts` sends a real request for every row
below to check that the documented access and rate limit are the ones the server applies.

**60 routes.** Base URL is the backend origin (`NEXT_PUBLIC_API_URL` for the frontend).

## Conventions


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

**Errors.** Every error is `{ "error": { "code", "message", "requestId" } }`. Codes:
`VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `PERMISSION_DENIED` (403), `NOT_FOUND` (404),
`CONFLICT` (409), `RATE_LIMITED` (429), `QUOTA_EXCEEDED` (429), `CAPABILITY_UNAVAILABLE` (501),
`SERVICE_UNAVAILABLE` (503).

`CAPABILITY_UNAVAILABLE` is distinct on purpose: it means the request was correct and this
deployment has no provider that can serve it. A 503 would invite a retry that can never succeed,
and nothing is ever substituted with a fake result (ADR-050).

**Public paths:** `GET /api/health`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/signup`.


## `/api/health`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/health` | public | global (300 / 1 minute) |

## `/api/v1/admin`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/admin/health` | system administrator | global (300 / 1 minute) |
| `GET` | `/api/v1/admin/metrics` | system administrator | global (300 / 1 minute) |
| `GET` | `/api/v1/admin/stats` | system administrator | global (300 / 1 minute) |

## `/api/v1/agent`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/agent/tasks` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/agent/tasks` | session or API key · `agent:run` | 30 / 1 minute |
| `GET` | `/api/v1/agent/tasks/:id` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/agent/tasks/:id/approve` | session or API key · `agent:approve` | global (300 / 1 minute) |
| `POST` | `/api/v1/agent/tasks/:id/cancel` | session or API key · `agent:run` | global (300 / 1 minute) |
| `GET` | `/api/v1/agent/tasks/:id/events` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/agent/tasks/:id/reject` | session or API key · `agent:approve` | global (300 / 1 minute) |

## `/api/v1/api-keys`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/api-keys` | session or API key · `apikey:manage` | global (300 / 1 minute) |
| `POST` | `/api/v1/api-keys` | session or API key · `apikey:manage` | global (300 / 1 minute) |
| `DELETE` | `/api/v1/api-keys/:id` | session or API key · `apikey:manage` | global (300 / 1 minute) |

## `/api/v1/assets`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/assets/:id` | session or API key · `project:read` | global (300 / 1 minute) |

## `/api/v1/audio`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/audio` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/audio` | session or API key · `media:generate` | 10 / 1 minute |
| `GET` | `/api/v1/audio/:id` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/audio/:id/cancel` | session or API key · `media:generate` | global (300 / 1 minute) |

## `/api/v1/audit`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/audit` | session or API key · `project:admin` | global (300 / 1 minute) |

## `/api/v1/auth`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `DELETE` | `/api/v1/auth/account` | session only · authentication only | 5 / 15 minutes per user |
| `POST` | `/api/v1/auth/login` | public | 2 × `AUTH_RATE_LIMIT_MAX` / 10 minutes |
| `POST` | `/api/v1/auth/logout` | public | global (300 / 1 minute) |
| `GET` | `/api/v1/auth/me` | session or API key · authentication only | global (300 / 1 minute) |
| `POST` | `/api/v1/auth/signup` | public | `AUTH_RATE_LIMIT_MAX` / 10 minutes |

## `/api/v1/chat`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `POST` | `/api/v1/chat` | session or API key · `chat:write` | 30 / 1 minute |

## `/api/v1/conversations`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/conversations` | session or API key · `project:read` | global (300 / 1 minute) |
| `GET` | `/api/v1/conversations/:id/messages` | session or API key · `project:read` | global (300 / 1 minute) |

## `/api/v1/files`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/files` | session or API key · `files:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/files` | session or API key · `files:write` | global (300 / 1 minute) |
| `DELETE` | `/api/v1/files/:id` | session or API key · `files:write` | global (300 / 1 minute) |
| `GET` | `/api/v1/files/:id` | session or API key · `files:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/files/upload` | session or API key · `files:write` | 10 / 1 minute |

## `/api/v1/images`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/images` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/images` | session or API key · `media:generate` | 10 / 1 minute |
| `GET` | `/api/v1/images/:id` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/images/:id/cancel` | session or API key · `media:generate` | global (300 / 1 minute) |

## `/api/v1/jobs`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/jobs` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/jobs/:queue/:id/cancel` | session or API key · `project:write` | global (300 / 1 minute) |
| `GET` | `/api/v1/jobs/dead-letter` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/jobs/dead-letter/:queue/:id/replay` | session or API key · `project:write` | 10 / 1 minute |

## `/api/v1/mcp`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/mcp` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/mcp/:id/reconnect` | system administrator | global (300 / 1 minute) |

## `/api/v1/memory`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/memory` | session or API key · `memory:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/memory` | session or API key · `memory:write` | global (300 / 1 minute) |
| `DELETE` | `/api/v1/memory/:id` | session or API key · `memory:write` | global (300 / 1 minute) |

## `/api/v1/models`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/models` | session or API key · `project:read` | global (300 / 1 minute) |

## `/api/v1/projects`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/projects` | session or API key · authentication only | global (300 / 1 minute) |
| `POST` | `/api/v1/projects` | session or API key · authentication only | global (300 / 1 minute) |
| `POST` | `/api/v1/projects/:projectId/members` | session or API key · `project:admin` | global (300 / 1 minute) |

## `/api/v1/providers`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/providers` | session or API key · `project:read` | global (300 / 1 minute) |

## `/api/v1/rag`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `POST` | `/api/v1/rag/query` | session or API key · `files:read` | 30 / 1 minute |

## `/api/v1/tools`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/tools` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/tools/:id/enable` | system administrator | global (300 / 1 minute) |

## `/api/v1/usage`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/usage` | session or API key · `usage:read` | global (300 / 1 minute) |

## `/api/v1/videos`

| Method | Path | Auth / permission | Rate limit |
|---|---|---|---|
| `GET` | `/api/v1/videos` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/videos` | session or API key · `media:generate` | 5 / 1 minute |
| `GET` | `/api/v1/videos/:id` | session or API key · `project:read` | global (300 / 1 minute) |
| `POST` | `/api/v1/videos/:id/cancel` | session or API key · `media:generate` | global (300 / 1 minute) |
| `POST` | `/api/v1/videos/:id/retry` | session or API key · `media:generate` | 5 / 1 minute |

## Streaming


`POST /api/v1/chat` and `GET /api/v1/agent/tasks/:id/events` stream Server-Sent Events framed as
`event: <type>\ndata: <json>\n\n`. Parsers must accept all three spec separators (`\n\n`,
`\r\n\r\n`, `\r\r`) — assuming only the first was a real bug on both sides of the wire.

Chat events: `token` (a delta), `tool_call`, `done` (the terminal event, carrying the assembled
message, usage, provider, model and `finishReason`), `error`. The conversation id is the
`X-Conversation-Id` response header, not a field of any event.

An `EventSource` cannot set headers, so the agent event stream takes `?projectId=` and relies on
`withCredentials` for the session cookie.

