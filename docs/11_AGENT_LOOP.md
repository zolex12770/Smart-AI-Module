# Agent Loop: State Machine and Task Graph Design

This is an original design, not a survey. It makes concrete decisions, informed by `02_AI_AGENT_RESEARCH.md` (why naive loops fail, context management, HITL, persistence), `03_EXISTING_AGENT_ARCHITECTURES.md` (patterns validated across Claude Code, LangGraph, Aider, and others), and `10_TOOL_AND_MCP_ARCHITECTURE.md` (tool registry, permission gating). Where a decision is a judgment call rather than a documented industry consensus, it is marked **DESIGN DECISION** with its rationale, so it can be revisited deliberately rather than mistaken for received wisdom.

---

## 1. Design Principles (Carried Forward as Constraints)

1. **Grounded verification, not self-assessment.** Every task that can be checked against an objective signal (tests, schema validation, a deterministic comparison) must be, rather than trusting the generating model's own claim of success (`02_AI_AGENT_RESEARCH.md` §1.3, §3).
2. **Context is finite and decaying, not just size-limited.** The loop must actively manage what's in context (compaction, sub-agent isolation) rather than let a transcript grow unbounded (`02_AI_AGENT_RESEARCH.md` §2).
3. **Approval is risk-tiered, not a single global toggle.** Different actions warrant different points of human involvement — pre-plan review, pre-action approval, post-hoc audit — and the state machine must express all of them (`02_AI_AGENT_RESEARCH.md` §5, `03_EXISTING_AGENT_ARCHITECTURES.md` synthesis §3).
4. **Every state transition is durable before the next action starts.** Crash-only design: the process can die at any point and resume from the last committed state, matching the checkpoint-per-step pattern validated in LangGraph (`02_AI_AGENT_RESEARCH.md` §6, `03_EXISTING_AGENT_ARCHITECTURES.md` C.1).
5. **Mutating tool calls are idempotent or gated, never blindly retried.** Non-atomic tool failure (the call partially succeeded but reported failure, or vice versa) is a named, real failure class, not an edge case (`02_AI_AGENT_RESEARCH.md` §3; `10_TOOL_AND_MCP_ARCHITECTURE.md` §3.1).
6. **Single-loop-plus-isolated-sub-agents is the default, not a multi-agent team.** Multi-agent decomposition is opt-in for tasks that are genuinely context-isolable (research-style fan-out), not the default execution model, per Anthropic's own documented caveat about tightly-coupled work (`03_EXISTING_AGENT_ARCHITECTURES.md` §B.4, synthesis §5).

---

## 2. The State Machine

### 2.1 States

| State | Meaning | Typical duration |
|---|---|---|
| `IDLE` | No active task; agent awaiting input | Indefinite |
| `UNDERSTANDING` | Parsing the incoming request, gathering minimum context to scope the task (may involve read-only tool calls: search, file read, memory/RAG retrieval) | Seconds |
| `PLANNING` | Producing a task graph (§3) — one or more steps, their dependencies, and per-step tool/model assignments | Seconds to ~1 minute for complex tasks |
| `WAITING_FOR_APPROVAL` | Plan (or a specific high-risk step) is presented to a human and execution is blocked until a decision arrives | Indefinite (can be hours/days) |
| `EXECUTING` | Actively running a task-graph node: either generating (model call) or acting (tool call) | Variable |
| `WAITING_FOR_MODEL` | A model call is in flight (sub-state of `EXECUTING`, broken out because it has distinct timeout/retry semantics from tool calls) | Seconds |
| `WAITING_FOR_TOOL` | A tool/MCP call is in flight (sub-state of `EXECUTING`, distinct timeout/retry/idempotency semantics per `10_TOOL_AND_MCP_ARCHITECTURE.md` §3.1) | Variable, tool-dependent |
| `VERIFYING` | Checking a completed node's output against its success criteria (tests, schema, explicit check) — grounded where possible, not self-assessment alone | Seconds |
| `RETRYING` | Verification failed in a recoverable way; preparing another attempt at the same node (possibly with adjusted input) | Seconds |
| `PAUSED` | Execution deliberately suspended (user-requested pause, resource limit hit, scheduled deferral) — distinct from waiting-for-approval because no decision is pending, just a hold | Indefinite |
| `CANCELLED` | Task terminated by explicit user/system cancellation before completion | Terminal |
| `COMPLETED` | Task graph fully resolved successfully | Terminal |
| `FAILED` | Task graph terminated because a node exhausted retries/escalation with no recovery path, or an unrecoverable error occurred | Terminal |

### 2.2 Transition Diagram

```
                      ┌─────────┐
                      │  IDLE   │◄─────────────────────────────────────┐
                      └────┬────┘                                      │
                           │ new request                               │
                           ▼                                           │
                  ┌────────────────┐                                   │
                  │ UNDERSTANDING  │                                   │
                  └────────┬───────┘                                   │
                           │ scope established                         │
                           ▼                                           │
                  ┌────────────────┐                                   │
             ┌────┤   PLANNING     │◄───────────────────┐              │
             │    └────────┬───────┘                     │              │
             │             │ plan produced                │ replan       │
             │             ▼                              │ triggered    │
             │   ┌───────────────────────┐                │              │
             │   │ WAITING_FOR_APPROVAL  │── rejected ─────┘              │
             │   │ (skipped if no        │                                │
             │   │  approval required)   │── approved                    │
             │   └───────────┬───────────┘                                │
             │               ▼                                            │
             │      ┌────────────────┐    node needs model   ┌──────────────────┐
             │      │   EXECUTING    │───────────────────────►│ WAITING_FOR_MODEL │
             │      │ (dispatch loop │                        └─────────┬─────────┘
             │      │  over ready    │                                  │ response
             │      │  graph nodes)  │◄─────────────────────────────────┘
             │      │                │    node needs tool     ┌──────────────────┐
             │      │                │───────────────────────►│ WAITING_FOR_TOOL  │
             │      │                │                        └─────────┬─────────┘
             │      │                │◄─────────────────────────────────┘
             │      └───────┬────────┘    result
             │              │ node output ready
             │              ▼
             │      ┌────────────────┐
             │      │   VERIFYING    │
             │      └───────┬────────┘
             │        pass  │  │  fail (recoverable)
             │      ┌───────┘  └────────┐
             │      ▼                   ▼
             │  more nodes?      ┌────────────┐
             │   │      │        │  RETRYING  │──── retries exhausted ───┐
             │   yes    no       └─────┬──────┘                          │
             │   │      │              │ retry attempt                  │
             │   │      ▼              └──────► back to EXECUTING       │
             │   │  ┌───────────┐                                       │
             │   │  │ COMPLETED │───────────────────────────────────────┼──► IDLE
             │   │  └───────────┘                                       │
             │   └──► back to EXECUTING (next ready node)                │
             │                                                           ▼
             │                                                     ┌───────────┐
             │  fail (unrecoverable, any state) ───────────────────►  FAILED   │──► IDLE
             │                                                     └───────────┘
             │
             │  user pause (any active state) ──► PAUSED ──► resume ──► prior state
             │  user cancel (any active state) ──► CANCELLED ──► IDLE
             └─ verification reveals plan itself is wrong ──► PLANNING (replan)
```

Notes on transitions not obvious from the diagram:

- **`WAITING_FOR_APPROVAL` is not a single global gate** — it can be entered at the plan level (approve the whole plan before any execution) or per-node, immediately before a specific high-risk tool call is dispatched (approve just this step, plan already running). Which mode applies is determined by the tool registry's `requires_approval` field (`10_TOOL_AND_MCP_ARCHITECTURE.md` §3.1) evaluated per node at the moment it becomes ready to execute, not decided once upfront — this is what makes the risk-tiered approval model (principle 3) actually work: a plan with nine read-only steps and one destructive step only blocks once, right before the destructive step.
- **`PAUSED` vs. `WAITING_FOR_APPROVAL`**: both suspend execution, but `PAUSED` has no pending decision — resuming just continues; `WAITING_FOR_APPROVAL` resolves only via an explicit approve/reject decision, and a reject routes back to `PLANNING` (replan around the rejected step), not to `FAILED` — a rejected step is information for the planner, not necessarily a fatal error.
- **Replanning loop**: `VERIFYING` can route back to `PLANNING`, not just `RETRYING`, when the failure indicates the *plan* was wrong (e.g., a step's precondition turned out false, a dependency produced an unexpected shape) rather than the *execution* being flawed. Distinguishing these two cases is a **DESIGN DECISION**: verification failures are classified as `retryable-execution` (same plan, retry the node, possibly with adjusted arguments) or `plan-invalidating` (return to `PLANNING` with the failure as new input) by an explicit rule per task type, defaulting to `retryable-execution` for the first failure and escalating to `plan-invalidating` after a configurable number of same-node retries fail — this avoids both extremes (never replanning, which loops forever on a broken plan; replanning on every hiccup, which is expensive and can thrash).
- **Any active state can transition to `PAUSED` or `CANCELLED`** on explicit user action — these are treated as interrupts, not normal graph edges, and are handled by the same durable-checkpoint mechanism as every other transition (§4).

### 2.3 Why This State Set, Not a Simpler One

- **Splitting `WAITING_FOR_MODEL` and `WAITING_FOR_TOOL` out of a generic `EXECUTING`**: they have genuinely different failure/retry semantics — a model call timeout is usually safely retryable (no external side effect happened), while a tool call timeout may or may not be (did the external action actually happen?). Collapsing them into one `EXECUTING` state would force one retry policy to serve both, which is exactly the non-atomic-failure risk flagged in `02_AI_AGENT_RESEARCH.md` §3.
- **`VERIFYING` as its own state, not folded into `EXECUTING`**: makes grounded verification an explicit, auditable step in the state history rather than an implicit judgment buried inside execution — every completed task graph has a visible verification record per node, which is what principle 1 requires in practice, not just in intent.
- **`RETRYING` as its own state rather than an immediate re-dispatch**: gives a place to apply backoff, adjust arguments based on the failure (e.g., re-read a file that changed, fix a malformed argument), and cap attempts — and gives the persistence layer (§4) a distinct, inspectable record of "this was attempt 2 of 3," which matters for debugging and for not silently masking a flaky step as if it succeeded cleanly the first time.

---

## 3. Task Graph Representation

A task is not a single flat to-do item — it is a node in a directed graph, because real work is sequential in places, parallel in places, conditionally branches, and sometimes loops (retry a sub-step, or repeat a step over a collection). One schema needs to express all four without special-casing each.

### 3.1 Node Schema

```yaml
task_node:
  id: string                      # stable unique id (e.g. ULID) - never reused
  parent_id: string | null        # containing task-graph or parent node, for sub-task/sub-agent nesting
  root_task_id: string            # the top-level task this node belongs to, for grouping/audit

  type: enum [atomic, sequential_group, parallel_group, conditional, loop, sub_agent]
    # atomic          - a single model call or tool call
    # sequential_group- children execute in dependency order (see edges below)
    # parallel_group   - children execute concurrently, no ordering constraint among them
    # conditional      - exactly one of several child branches executes, chosen by a condition
    # loop             - a child (or subgraph) repeats until a condition or iteration cap is hit
    # sub_agent        - delegates to an isolated-context sub-agent (own model/tool/context scope);
    #                    returns only a condensed summary to the parent, per 02_AI_AGENT_RESEARCH.md §2.1

  status: enum [pending, ready, running, waiting_approval, waiting_tool, waiting_model,
                verifying, retrying, paused, completed, failed, cancelled, skipped]
    # "skipped" covers a conditional branch not taken, or a step made moot by an earlier result

  depends_on: [string]            # node ids that must be `completed` before this node becomes `ready`
                                   # empty list = ready as soon as its parent group is ready

  condition: expression | null    # for type=conditional: evaluated against prior node outputs to pick a branch
                                   # for type=loop: the continuation predicate, evaluated each iteration
  loop_bound:
    max_iterations: integer | null
    break_on: expression | null   # e.g. "no items left", "verification passed"

  input: JSON                     # resolved input for this node - may reference prior nodes' outputs
                                   # by id (e.g. "{{node_42.output.file_path}}"), resolved at dispatch time
  output: JSON | null             # populated once completed; null while pending/running

  model:
    provider: string | null       # e.g. "anthropic", "openai", "google" - null lets the router choose
    model_id: string | null       # specific model, or null to use the task-type default
    # left flexible deliberately: model selection is a routing decision (see 3.3), not hardcoded per node

  tools: [tool_id]                # subset of the tool registry (10_TOOL_AND_MCP_ARCHITECTURE.md §3.1)
                                   # this node is permitted to call - explicit allowlist, not "all tools"

  retry_policy:
    max_attempts: integer
    backoff: enum [none, fixed, exponential]
    classify_failure_as: enum [retryable-execution, plan-invalidating] | null
                                   # null = use the task-type default classifier (see 2.2)

  timeout_ms: integer

  verification:
    method: enum [none, test_suite, schema_check, deterministic_compare, model_judge, human]
    spec: JSON                    # method-specific config, e.g. which test command, which schema
    # "model_judge" is deliberately last-resort and logged as lower-confidence than the others,
    # per the documented risk of same-model self-assessment bias (02_AI_AGENT_RESEARCH.md §1.3)

  approval:
    required: bool                # resolved at dispatch time from the tool registry's permission_level,
                                   # can also be forced true/false at the node level for task-specific policy
    approved_by: string | null
    approved_at: timestamp | null

  created_at: timestamp
  updated_at: timestamp           # bumped on every state transition - see 4.1
  attempt_count: integer
```

### 3.2 Expressing the Four Execution Shapes

- **Sequential**: a `sequential_group` whose children each `depends_on` the previous child's id. Simple linear chains (most common case) are just a degenerate sequential group.
- **Parallel**: a `parallel_group` whose children share no `depends_on` relationship to each other (they may all depend on some common earlier node, but not on one another) — the dispatcher (§3.4) runs every node whose dependencies are satisfied concurrently, up to a configurable concurrency cap per task graph.
- **Dependent (general DAG, not just linear)**: expressed directly through `depends_on` — a node can list multiple dependencies from different branches, letting a diamond-shaped dependency graph (two parallel branches that later join) be expressed without a special node type; `sequential_group`/`parallel_group` are conveniences for the common cases, not the only way to express ordering.
- **Conditional**: a `conditional` node has multiple candidate children, each implicitly guarded; at dispatch time the `condition` expression is evaluated against already-completed sibling/ancestor outputs, exactly one branch is marked `ready`, and the rest are marked `skipped` (not `cancelled` — skipped is a normal, expected outcome, not an interruption).
- **Looping**: a `loop` node wraps a child (often a `sub_agent` or a small subgraph) that re-executes with `attempt_count` incrementing each pass, continuing while `condition` holds and `loop_bound.max_iterations` isn't exceeded — this is the same primitive whether the "loop" is a retry-with-modification, a map-over-collection, or an agentic "keep refining until verification passes" pattern; they differ only in what the continuation condition checks.

### 3.3 Model and Tool Assignment

Model assignment is deliberately **not hardcoded per node at plan time** for every case — `model.provider`/`model.model_id` can be left null, in which case a routing policy (external to this document; a model-selection concern, not a state-machine concern) chooses based on task-type defaults, cost/latency budget for the root task, and which models the tool calls in this node's `tools` list actually support. This is what keeps the platform model-agnostic at the task-graph level: the graph schema encodes *what* needs to happen and *what it's allowed to touch*, not *which vendor* does it, mirroring the canonical-schema-plus-adapter design already used for tools (`10_TOOL_AND_MCP_ARCHITECTURE.md` §1.4). A node can still pin a specific model when the task genuinely requires it (e.g., a verification step that must use a different model than the one that generated the output, per the same-model-self-critique-blind-spot finding in `02_AI_AGENT_RESEARCH.md` §1.3).

The `tools` field being an explicit allowlist per node (not "this task graph can use any registered tool") is a **DESIGN DECISION**: it bounds blast radius per node — a node whose job is "summarize this document" has no business being able to invoke a destructive tool even if the overall task graph's root task has that tool enabled somewhere else, and it makes the permission gate's job (`10_TOOL_AND_MCP_ARCHITECTURE.md` §3.2) simpler since it's checking against a small, task-relevant set rather than the platform's entire tool registry.

### 3.4 The Dispatcher

The `EXECUTING` state runs a dispatch loop, not a single call: at each tick, it finds every node across the whole graph whose status is `pending` and whose `depends_on` are all `completed` (or `skipped`, for conditional branches), promotes them to `ready`, and dispatches all currently-`ready` nodes up to the concurrency cap. This is what makes parallel and sequential execution the same mechanism rather than two code paths — a purely sequential graph just happens to never have more than one `ready` node at a time. Each dispatched node's own execution (model call, tool call, verification, retry) runs through the sub-states in §2.1/§2.2 independently, and the dispatcher is re-entered whenever any node completes, since that may unblock new dependents.

---

## 4. Persistence and Resumability

### 4.1 What Gets Persisted, and When

Every state transition for every node — and for the root task overall — is written to durable storage (a relational store; the task-graph tables live in the same Postgres instance as the rest of the platform, consistent with the pgvector co-location reasoning in `09_RAG_ARCHITECTURE.md` §5.3) **before** the corresponding action is taken, not after. Concretely: before dispatching a tool call, the node's status is committed as `waiting_tool` along with the exact arguments about to be sent; only then does the call go out. This ordering (commit-then-act, not act-then-commit) is what makes crash recovery correct — if the process dies mid-call, the recovered state honestly reflects "we were in the middle of calling this tool with these arguments," which is exactly the information needed to decide safely what to do next (see §4.3), rather than an ambiguous "we don't know if this ran."

Persisted per transition: node id, previous status, new status, timestamp, actor (which component/model/user caused the transition), and a payload appropriate to the transition (arguments about to be sent, result received, verification outcome, approval decision). This is an **append-only log**, not just a mutable "current status" column — the current status is a materialized view over the log, kept for fast queries, but the log itself is the source of truth and is never overwritten, which gives us LangGraph-style time-travel/audit for free (`03_EXISTING_AGENT_ARCHITECTURES.md` C.1) without extra design work.

### 4.2 Resuming After a Restart

On process start (or when explicitly resuming a `PAUSED` task), the loop:

1. Loads the root task's current materialized state and every node's current status from the log.
2. For any node found in `waiting_model` or `waiting_tool` at the moment of the crash, does **not** blindly assume it either succeeded or failed — see §4.3.
3. Re-runs the dispatcher tick (§3.4): finds all nodes whose dependencies are satisfied and whose status is `pending`/`ready`, and resumes normal execution from there.
4. If the root task itself was mid-`PLANNING` (a plan was being generated but never committed), the partial plan is discarded and planning restarts — plans are only durable once fully committed as node rows, so a half-formed plan is safe to throw away rather than resume awkwardly.

This means the unit of resumability is the **node**, not the whole task graph — a long task graph with forty completed nodes and one in-flight node at crash time resumes with thirty-nine nodes untouched and one node re-examined, not a full restart from scratch. This directly operationalizes the persistence requirement from `02_AI_AGENT_RESEARCH.md` §6.

### 4.3 Handling In-Flight Work at Resume Time (Idempotency in Practice)

This is where principle 5 (idempotent-or-gated mutation) becomes concrete, not aspirational:

- **`waiting_model` at crash time**: safe to simply retry the model call. A model call has no external side effect by construction (in our design, a model call never directly mutates external state — only a subsequent, separately-dispatched tool call does), so re-issuing it is always safe. **DESIGN DECISION**: this is exactly why model calls and tool calls are split into distinct states (§2.3) — it's what makes this recovery rule simple instead of case-by-case.
- **`waiting_tool` at crash time, tool is `read_only`**: safe to simply retry, same reasoning as above.
- **`waiting_tool` at crash time, tool is `write_local`/`write_external`/`destructive`/`financial`**: the node is **not** automatically retried. It transitions to a special recovery status (`needs_reconciliation`) and the platform attempts a **reconciliation check** before doing anything else: if the tool declared an idempotency key (`10_TOOL_AND_MCP_ARCHITECTURE.md` §3.1) and supports a status-check call, query whether the original call actually completed; if the tool has no such support, the node surfaces to a human as "this action's outcome is unknown — please verify manually before we proceed," which is the safe default when the alternative is a silent double-send or a silently-dropped action. This directly implements the non-atomic-tool-call risk mitigation flagged in `02_AI_AGENT_RESEARCH.md` §3 rather than leaving it as an unaddressed known issue.
- **`WAITING_FOR_APPROVAL` at crash time**: trivially safe to resume — nothing was dispatched, the state simply continues waiting for the same pending decision.

### 4.4 Sub-Agent and Parallel Persistence

A `sub_agent` node's own internal execution (its context, its own sequence of model/tool calls) is persisted as its own nested set of node rows under that node's `id` as their `parent_id` — recursively the same schema, which means resumability, audit logging, and the state machine itself apply uniformly at any depth of sub-agent delegation, with no special-cased "top-level task" logic that sub-agents don't get. Parallel nodes persist independently of one another; a crash that loses one branch of a `parallel_group` mid-flight does not require re-running sibling branches that had already committed `completed` — only the affected branch resumes via §4.2–4.3.

---

## 5. Summary of Concrete Decisions Made in This Document

| Decision | Choice | Primary reason |
|---|---|---|
| Approval granularity | Per-node, evaluated at dispatch time from tool risk tier | Avoids one global block-everything or approve-everything mode |
| Verification location | Own explicit state (`VERIFYING`), grounded methods preferred over model self-judgment | Matches documented risk of same-model critique blind spots |
| Retry vs. replan | Classify each failure as `retryable-execution` or `plan-invalidating`; escalate after N same-node failures | Avoids infinite retry-the-same-broken-plan loops without replanning on every minor hiccup |
| Task graph shape | Single node schema with `type` enum covering sequential/parallel/conditional/loop/sub-agent | One schema, one dispatcher, no special-cased execution paths |
| Model binding | Optional per-node pin; otherwise resolved by a routing policy at dispatch time | Keeps the platform model-agnostic at the graph level |
| Tool access per node | Explicit allowlist subset of the global registry, not blanket access | Bounds blast radius per node independent of the root task's overall permissions |
| Persistence granularity | Append-only log per node transition, committed before the corresponding action executes | Enables node-level (not whole-graph) resumability and honest crash recovery |
| Mutating-tool crash recovery | Never auto-retry; reconcile via idempotency check or escalate to human | Directly addresses the documented non-atomic tool failure risk |
| Multi-agent default | Single loop + isolated sub-agents by default; full multi-agent team is opt-in per task type | Follows Anthropic's documented caveat against multi-agent decomposition for tightly-coupled work |

This design is deliberately conservative in exactly the places the research in files 1–3 identified as high-risk (mutating tool retries, self-verification, unbounded context growth, blanket approval models) and deliberately flexible in the places where over-constraining would just reproduce a narrower version of an existing framework (model binding, task graph shape, approval granularity).
