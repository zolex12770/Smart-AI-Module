# Frontend Architecture

Next.js (App Router) per [[26_DECISIONS]] ADR-004, calling `apps/api` over HTTP/SSE per [[15_API_ARCHITECTURE]]. No business logic in server actions/route handlers on the web app — it is a thin client of the real API, so the API stays independently usable (FR-051).

## Screens

| Route | Purpose | Backs onto |
|---|---|---|
| `/chat/[conversationId]` | General chat, streaming | `/api/v1/chat` |
| `/agent/[taskId]` | Agent execution detail (see below) | `/api/v1/agent/tasks/:id`, `/events` |
| `/coding/[taskId]` | Coding-agent view: files changed, commands run, diffs, test results | Same task endpoints, filtered/rendered for the coding-agent task type |
| `/images` | Image generation UI: prompt form, history grid, job status | `/api/v1/images` |
| `/videos` | Video generation UI: prompt form, scene/storyboard preview for long-form jobs, job status | `/api/v1/videos`, `/scenes` |
| `/projects` | Project list/create/manage members | `/api/v1/projects` |
| `/files` | Document upload + list, RAG source browser | `/api/v1/files` |
| `/assets` | Generated asset library (images/videos/documents) | `/api/v1/assets` |
| `/tasks` | Task history across all types | `/api/v1/agent/tasks` |
| `/settings` | Account, memory view/delete, API keys | `/api/v1/memory`, `/api/v1/api-keys` |
| `/models` | Available models + capabilities (read-only for non-admins) | `/api/v1/models` |
| `/providers` | Provider configuration (admin) | `/api/v1/providers` |
| `/usage` | Usage/cost dashboard | `/api/v1/usage` |
| `/admin` | System-wide usage, queue health, provider error rates | `/api/v1/admin/*` |

## Agent execution UI (the one screen worth designing in detail)

Per the original brief's rule 25, the point of this view is that the user can tell **what the agent is doing and why**, not just see a final answer. Concretely, one page renders, live, from the SSE event stream on `/api/v1/agent/tasks/:id/events`:

```
┌─ User request ─────────────────────────────────────────┐
│ "..."                                                    │
├─ Plan ─────────────────────────────────────────────────┤
│ [x] Step 1: ...      [x] Step 2: ...      [ ] Step 3: ...│
├─ Current step detail ──────────────────────────────────┤
│ Model: claude-...        Tool: filesystem.read           │
│ Status: EXECUTING                                         │
├─ Files changed | Commands run | Test results ──────────┤
│ (tabs — populated as events arrive, not only at the end) │
├─ Errors / retries ──────────────────────────────────────┤
│ (shown inline at the step they occurred, not hidden)     │
└─ Final result ─────────────────────────────────────────┘
```

This maps 1:1 onto the state machine and task-graph node fields in [[11_AGENT_LOOP]] — the UI is a direct rendering of that persisted state, not a separate representation that can drift from it. A `WAITING_FOR_APPROVAL` state renders an explicit Approve/Reject control (FR-007), not a spinner.

## State/data fetching

TanStack Query for request caching/invalidation on non-streaming reads (projects, assets, usage); a small custom `useEventStream` hook wrapping `EventSource` for the SSE endpoints (chat, agent events, job progress), feeding into the same query cache so a completed stream's final state is what re-renders on navigation back to that page — no separate "live" vs. "historical" rendering path.

## Component/design approach

Tailwind CSS + a small internal component set (not a full design-system dependency) — chat/agent UIs have enough bespoke interaction (streaming text, diff views, plan trees) that a heavy off-the-shelf admin-template library would fight the actual requirements more than it would save time. Markdown/code-block rendering via `react-markdown` + `shiki`; diffs via a unified-diff renderer for the coding agent view (FR-013).

## What's explicitly deferred

Mobile-native apps, offline support, and i18n are not in [[01_REQUIREMENTS]] and are not designed for here — the web app is responsive (usable on mobile browsers) but not a distinct mobile product.
