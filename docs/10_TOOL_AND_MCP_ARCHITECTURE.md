# Tool Calling and MCP Architecture

This document covers (1) how tool/function calling works across the major LLM APIs, (2) the Model Context Protocol (MCP) as a standardized way to expose tools/data to any model, and (3) our proposed tool registry and MCP integration layer design.

Tags: **PUBLICLY DOCUMENTED** = stated in vendor/spec docs. **INFERRED** = reasonable deduction not explicitly stated. **ASSUMED** = our design choice, not a fact about any external system. **UNKNOWN** = genuinely undocumented.

---

## 1. Tool Calling Across LLM APIs

All three major providers converge on the same conceptual model — the model is given a list of callable functions with JSON-Schema-typed parameters, it responds with a structured "call this function with these arguments" payload instead of (or alongside) prose, the caller executes the function outside the model, and the result is fed back in as a new message for the model to continue from. The differences are in schema shape, guarantees, and control knobs.

### 1.1 Anthropic (Claude) — Tool Use

**PUBLICLY DOCUMENTED** (platform.claude.com/docs):
- A tool is defined with `name`, `description`, and `input_schema` (JSON Schema, no outer `function` wrapper — this is flatter than OpenAI's shape).
- `tool_choice` controls selection mode: `auto` (default — model decides whether/which tool to call), `any` (must call some tool), `tool` (must call a specific named tool), `none`.
- Claude can return **multiple `tool_use` blocks in a single response** (parallel tool calls); the caller must execute all of them and return all corresponding `tool_result` blocks in a single subsequent user message. Set `disable_parallel_tool_use: true` to force at most one tool call per turn.
- **Programmatic tool calling / advanced tool use**: Anthropic has added capability for Claude to orchestrate tool calls through generated code rather than one-at-a-time API round trips, reducing latency and token overhead for tool-heavy workflows. ([anthropic.com/engineering/advanced-tool-use](https://www.anthropic.com/engineering/advanced-tool-use))
- Tool descriptions are explicitly treated as a design surface (the ACI concept, see `03_EXISTING_AGENT_ARCHITECTURES.md` and `02_AI_AGENT_RESEARCH.md` §1.4): Anthropic's own guidance is that tool descriptions deserve the same design rigor as a user-facing API, with examples, edge cases, and explicit boundaries written into the description text itself, since that text is the model's only knowledge of the tool.

### 1.2 OpenAI — Function Calling

**PUBLICLY DOCUMENTED** (developers.openai.com/api/docs/guides/function-calling):
- A tool is defined with `type: "function"` and a nested `function: { name, description, parameters }` object, where `parameters` is JSON Schema.
- `strict: true` enables constrained decoding — the API guarantees the emitted arguments conform exactly to the schema (no missing/hallucinated fields), rather than best-effort JSON that needs post-hoc validation. OpenAI's current guidance (2026) is to use `strict: true` for all new production tool schemas and treat unconstrained JSON mode as legacy.
- `parallel_tool_calls` controls whether multiple tools can be invoked in one turn; as of 2025 `strict: true` and parallel calling are compatible for non-fine-tuned models, but fine-tuned models may still disable strict mode when calling multiple functions at once — if schema reliability matters more than parallelism on a fine-tuned model, set `parallel_tool_calls: false`.
- Strict mode requires a **constrained subset of JSON Schema** (e.g., `additionalProperties: false`, all properties required or explicitly nullable) — this is a real constraint on schema authoring, not just documentation flavor.

### 1.3 Google (Gemini) — Function Calling

**PUBLICLY DOCUMENTED** (ai.google.dev/gemini-api/docs/function-calling):
- Functions are declared via `FunctionDeclaration` (name, description, parameters as a subset of OpenAPI schema).
- **Automatic function calling**: the Python/JS SDKs can optionally execute the declared function themselves and loop the result back to the model automatically, continuing until the model stops requesting calls — this is an SDK-level convenience, not a protocol difference; it packages the "call → execute → feed back → repeat" loop for the caller.
- The **Live API** (real-time/streaming) does *not* support automatic tool-response handling — tool responses must be handled manually in that mode, which matters for any voice/streaming surface we build.
- Two use-case categories are called out explicitly in Google's docs: "take actions" (side-effecting calls — send email, schedule, control a device) vs. "augment knowledge" (read-only lookups) — this maps directly onto our permission-level design below (mutating vs. read-only tools deserve different default trust).

### 1.4 Cross-Provider Comparison

| Aspect | Anthropic | OpenAI | Google Gemini |
|---|---|---|---|
| Schema field name | `input_schema` | `parameters` (nested in `function`) | `parameters` (OpenAPI subset) |
| Guaranteed schema conformance | Best-effort (no strict-mode equivalent documented at this level) | `strict: true` — constrained decoding | Best-effort |
| Parallel tool calls | Multiple `tool_use` blocks per response, opt-out via `disable_parallel_tool_use` | `parallel_tool_calls` flag, some fine-tuned-model caveats | SDK-dependent |
| Automatic execute-and-loop | Not automatic — caller always executes and replies | Not automatic — caller always executes and replies | Optional SDK "automatic function calling" |
| Tool-orchestration-via-code | Yes (programmatic/advanced tool use) | Not equivalent documented | Not equivalent documented |

**Design implication**: because schema shape and conformance guarantees differ per provider, our tool registry (§3) should store one **canonical internal schema** (JSON Schema) per tool and have a thin per-provider adapter that translates to `input_schema` / `parameters` / `FunctionDeclaration` at call time — never hand-author three copies of the same tool definition. This is also what makes the platform genuinely model-agnostic rather than Claude-first or OpenAI-first with adapters bolted on.

---

## 2. Model Context Protocol (MCP)

### 2.1 What MCP Is and Why It Exists

MCP is an open protocol, originally introduced by Anthropic in late 2024 and now developed as a community/spec-governed standard at [modelcontextprotocol.io](https://modelcontextprotocol.io), for connecting AI applications ("hosts") to external tools and data sources ("servers") through a single, uniform interface — instead of every AI application writing bespoke integration code for every data source. **PUBLICLY DOCUMENTED.**

The specification is versioned by date (e.g., `2025-06-18`, `2026-07-28`); we cite the `2026-07-28` revision below as the current one at time of writing, and flag anything that changed recently, because MCP is evolving quickly and any implementation must track the spec version it targets.

### 2.2 Architecture: Host, Client, Server

- **MCP Host**: the AI application itself (e.g., Claude Desktop, Claude Code, VS Code, or — in our case — our own agent platform). The host coordinates one or more MCP clients.
- **MCP Client**: a component, one per connected server, that owns the connection lifecycle, discovery, and message exchange for that server. A host with four connected servers instantiates four clients, each maintaining a dedicated 1:1 connection.
- **MCP Server**: a program that exposes tools, resources, and/or prompts. It can run **locally** (spawned as a subprocess, e.g., a filesystem or local-database server) or **remotely** (a hosted service, e.g., a SaaS product's official MCP server).

This 1:1 client-server pairing, aggregated inside one host, is the core topology — the host is the trust boundary and policy point, not any individual server. ([modelcontextprotocol.io architecture overview](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture))

### 2.3 Two Layers

- **Data layer**: a JSON-RPC 2.0-based protocol defining message structure, capability/version discovery, and the core primitives (tools, resources, prompts, notifications). This is the part that matters for what an integration can *do*.
- **Transport layer**: how bytes actually move.
  - **stdio**: host spawns the server as a local subprocess and communicates over its stdin/stdout. Zero network overhead; used for local integrations (filesystem access, local databases, local dev tools). Typically serves exactly one client.
  - **Streamable HTTP (+ optional SSE)**: HTTP POST for client→server messages, with the server able to respond either as a single JSON object or, for streaming, as a `text/event-stream` (SSE). Used for remote servers; supports standard HTTP auth (bearer tokens, API keys, OAuth). Typically serves many clients concurrently.

Both transports carry the same JSON-RPC 2.0 message format — the transport is an implementation detail, and the data-layer semantics (tool discovery, invocation, etc.) do not change based on which one is used. **PUBLICLY DOCUMENTED.**

### 2.4 Primitives

MCP defines primitives on both sides of the connection, each with a distinct **control model** — who decides when it's used:

| Primitive | Exposed by | Control model | Purpose |
|---|---|---|---|
| **Tools** | Server | Model-controlled — the LLM decides when to call it, like any function call | Executable actions: API calls, file operations, database queries |
| **Resources** | Server | Application-controlled — the host/client attaches it as context, the model doesn't "call" it | Data the model can be given: file contents, schema, DB records |
| **Prompts** | Server | User-controlled — invoked by explicit user choice (e.g., a slash command or menu item) | Reusable interaction templates, e.g., a canned few-shot prompt for a domain |
| **Elicitation** | Client (host) | Server-initiated, human-mediated | Lets a server ask the *user*, via the host, for more input or explicit confirmation mid-operation |

As of protocol version `2026-07-28`, two former client primitives are **deprecated**: **Sampling** (letting a server ask the client's model for a completion, to stay model-agnostic) and **Logging** (server→client debug log messages). The spec now directs new implementations to integrate directly with LLM provider APIs instead of routing model calls through sampling, and to log to `stderr` (stdio) or via OpenTelemetry instead of the logging primitive. **PUBLICLY DOCUMENTED** — this is a real, recent spec change worth tracking since older MCP servers/clients in the wild may still implement the deprecated primitives.

Discovery and invocation follow a consistent `*/list`, `*/get`, `*/call` pattern (`tools/list` → `tools/call`, `resources/list` → `resources/read`, `prompts/list` → `prompts/get`), and servers advertise supported primitives/capabilities via a `server/discover` request (the current spec's discovery/handshake method) before any other calls are made. Server-side change notifications (e.g., the tool list changing) are opt-in via a `subscriptions/listen` stream rather than pushed unconditionally.

### 2.5 Security Model and Trust Boundaries

MCP's specification and independent security guidance (including NSA design guidance referenced in 2026 industry writeups) converge on treating MCP as introducing **at least three distinct trust boundaries** that must be reasoned about separately: **user ↔ host**, **host ↔ server**, and (transitively) **server ↔ whatever backend the server itself calls**. Key documented/consensus points:

- **Least privilege by default**: an agent/host should request the minimum necessary scope (e.g., read-only) at connection time, and escalate (e.g., to a write scope) only with explicit, specific user consent at the point of escalation — not a single blanket "allow everything" grant at connection time. **PUBLICLY DOCUMENTED** (security guidance consensus, e.g., Cloud Security Alliance MCP security guide).
- **Tool metadata cannot be blindly trusted**: because tool `name`/`description` text is attacker-influenceable if a server is malicious or compromised, a host must guard against **tool poisoning / tool injection** — a tool whose description is crafted to manipulate the model into misusing it or exfiltrating data, or a tool that silently changes behavior between calls without the description changing. Recommended mitigations: pin/verify tool schemas at connection time and re-verify on the `list_changed` notification (don't blindly accept updated tool definitions), log actual invocations against the declared schema, and alert on tools whose behavior or description drifts.
- **Remote MCP servers require OAuth 2.1 with PKCE**: this became a hard requirement in the MCP spec's evolution during 2025 — the June 2025 revision made the MCP server a plain OAuth **resource server** (not an identity provider itself), discovered via RFC 9728 Protected Resource Metadata and audience-bound via RFC 8707 Resource Indicators, delegating actual authentication to a separate authorization server. As of the November 2025 spec revision, any internet-accessible MCP server must implement OAuth 2.1 + PKCE (S256) — no exceptions. **PUBLICLY DOCUMENTED.**
- **Confused-deputy and token-passthrough risks** are a known MCP-specific failure class: if a host naively forwards a user's own OAuth token to an MCP server, and that server uses it against a third-party API, the server can act with the full scope of the user's token even for actions the user never approved for that specific server. Documented mitigation is token audience-binding (Resource Indicators) so a token minted for one resource server cannot be replayed against another.
- **A compromised/malicious local MCP server has full subprocess privileges** on the host machine (stdio transport spawns it as a normal OS process) — so local server installation is a supply-chain trust decision equivalent to installing any other executable, not a sandboxed capability grant, unless the host itself imposes OS-level sandboxing (container, restricted user, seccomp, etc.) around the spawned process. **INFERRED** from the transport model — MCP itself specifies the protocol, not OS-level sandboxing, so any isolation is the host's responsibility, not something the protocol provides for you.

### 2.6 What This Means for a Host Application (Design Requirement, Not MCP's Job)

MCP intentionally does **not** dictate how a host should sandbox or gate tool calls — that is left to the host application. This is the explicit scope boundary in the spec itself ("MCP focuses solely on the protocol for context exchange — it does not dictate how AI applications use LLMs or manage the provided context"). Concretely, our platform (not the protocol) must own:

1. Per-server and per-tool **permission gating** (see registry design below) — MCP gives you a tool's name/description/schema, not a trust level; the host has to assign one.
2. **Sandboxing of local (stdio) servers** — run them under a restricted OS user, container, or equivalent, not with the same privileges as the host process.
3. **Argument and result validation** against the declared schema on every call, independent of whatever the server claims.
4. **Consent UX** for scope escalation and for any newly-appeared or changed tool (react to `list_changed` by re-surfacing for approval, not silently trusting the update).
5. **Audit logging** of every MCP invocation (server, tool, arguments, result, latency, outcome) as a durable record independent of the server's own logs.

---

## 3. Our Tool Registry Design

Every tool the agent can call — whether a native built-in tool (file read/write, shell, our own RAG search) or one discovered through an MCP server — is normalized into one internal registry entry. This gives the orchestrator (see `11_AGENT_LOOP.md`) a single uniform interface regardless of origin or which model API it's ultimately serialized for.

### 3.1 Tool Registry Entry Schema

```yaml
tool:
  id: string                     # stable internal id, e.g. "fs.read_file" or "mcp.<server_id>.<tool_name>"
  name: string                   # human/model-facing name
  description: string            # ACI-quality description: purpose, when to use, when NOT to use, edge cases
  origin:
    kind: enum [native, mcp]
    server_id: string | null     # populated when kind == mcp
    server_version: string | null

  input_schema: JSONSchema       # canonical schema; provider adapters translate at call time
  output_schema: JSONSchema | null   # documented shape of a successful result, where known

  permission_level: enum [read_only, write_local, write_external, destructive, financial]
    # read_only        - no side effects (search, read a file, query an API GET)
    # write_local      - mutates state fully owned/reversible by us (write to a scratch file, our own DB draft)
    # write_external   - mutates a third-party system (send email, create a ticket, push a commit)
    # destructive      - hard-to-reverse or irreversible (delete data, force-push, drop table)
    # financial        - moves money or has direct monetary consequence

  risk_level: enum [low, medium, high, critical]
    # derived from permission_level + origin trust (native > vetted MCP server > unvetted MCP server)
    # informs default approval requirement (see 11_AGENT_LOOP.md WAITING_FOR_APPROVAL policy)

  requires_approval: enum [never, first_use, always, risk_threshold]
    # "risk_threshold" defers to a configurable org/user policy keyed on risk_level

  timeout_ms: integer            # hard wall-clock cap; default per permission_level (see below)
  retry_policy:
    max_attempts: integer
    backoff: enum [none, fixed, exponential]
    retryable_errors: [string]   # error classes considered safe to retry (e.g. timeout, 5xx)
    idempotency_required: bool   # true for write_external/destructive/financial - caller must supply an idempotency key

  rate_limit:
    max_calls_per_minute: integer | null
    max_calls_per_task: integer | null

  cost_hint: enum [free, cheap, expensive] | null   # for tools that call paid third-party APIs

  enabled: bool
  scopes_required: [string]      # least-privilege scopes this tool needs (mirrors MCP's own scoping)
  last_verified_at: timestamp    # last time schema/behavior was confirmed to match declaration
```

**Default timeout/retry by permission level** (ASSUMED — a starting policy, tunable per deployment):

| permission_level | default timeout_ms | default max_attempts | default requires_approval |
|---|---|---|---|
| read_only | 30,000 | 3 | never |
| write_local | 30,000 | 2 | never |
| write_external | 60,000 | 1 (no silent retry — see below) | first_use, then risk_threshold |
| destructive | 60,000 | 1 | always |
| financial | 60,000 | 1 | always |

Rationale: retrying a `write_external`/`destructive`/`financial` call automatically is unsafe unless the tool is verified idempotent (an email-send tool retried after a false-negative timeout can double-send) — so the default is **no automatic retry** for those tiers unless the specific tool declares `idempotency_required: true` *and* the registry entry has been verified to actually honor an idempotency key end to end.

### 3.2 MCP Integration Layer Design

```
┌─────────────────────────────────────────────────────────┐
│                     Agent Orchestrator                    │
│         (sees only normalized Tool Registry entries)      │
└───────────────────────────┬───────────────────────────────┘
                             │
                  ┌──────────▼──────────┐
                  │   Tool Registry      │  ← single source of truth,
                  │  (native + MCP)      │    used by planner + executor
                  └──────────▲──────────┘
                             │ registers/updates
                  ┌──────────┴──────────┐
                  │  MCP Integration     │
                  │       Layer          │
                  ├───────────────────────┤
                  │ 1. Config & Discovery │
                  │ 2. Connection Manager │
                  │ 3. Permission Gate    │
                  │ 4. Invocation Adapter │
                  │ 5. Audit Log          │
                  └──────────┬──────────┘
                             │ one MCP client per server
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        MCP Server A    MCP Server B    MCP Server C
        (stdio, local)  (HTTP, remote)  (HTTP, remote)
```

**1. Config & Discovery**
- MCP servers are declared in a platform-level config (per-org and per-user layers, user layer can only narrow, never widen, org-granted scopes) specifying: server id, transport (stdio command / HTTP URL), auth method, and an explicit **allow-list of scopes** the server is permitted to request.
- On startup (and on a periodic/manual refresh), the layer connects, performs `server/discover`, and calls `tools/list` (and `resources/list`, `prompts/list` where relevant) to populate/refresh the Tool Registry.
- New or changed tools discovered this way are inserted into the registry in a **disabled** state until either an admin/user explicitly approves them or they match a pre-approved pattern — we do not auto-trust a server's own self-declared capability changes.

**2. Connection Manager**
- Owns the lifecycle of each MCP client: connect, handshake, capability caching (respecting `ttlMs`/`cacheScope` hints from `server/discover` and `tools/list`), reconnect with backoff on transport failure, and clean shutdown.
- For stdio servers: spawns the subprocess inside a restricted execution context (see §2.6 point 2) — no shared filesystem/network access beyond what that server's declared scopes justify, enforced at the OS/container level, not just by convention.
- For HTTP servers: manages the OAuth 2.1/PKCE flow, token storage (encrypted at rest, scoped per user), and token refresh; verifies audience binding so a token cannot be replayed against a different resource server.

**3. Permission Gate**
- Every `tools/call` is intercepted here before it reaches the network/subprocess. It checks: is this tool enabled; does `permission_level`/`risk_level` require approval for this user/org policy; has this exact tool+argument shape been approved before (for `first_use` policy); is the per-minute/per-task rate limit exceeded.
- On a required approval, the call transitions the task into `WAITING_FOR_APPROVAL` (see `11_AGENT_LOOP.md`) rather than executing — this is the single enforcement point shared by both native and MCP tools, so approval policy is not duplicated per tool type.

**4. Invocation Adapter**
- Translates the orchestrator's canonical call (tool id + arguments matching `input_schema`) into the specific `tools/call` JSON-RPC request for that server, and translates the MCP `content` response array back into the orchestrator's normalized result shape.
- Validates both the outgoing arguments and the incoming result against the registry's declared schemas — a schema mismatch (server returned something not matching its own advertised `inputSchema`/behavior) is logged and surfaced as a `last_verified_at` staleness signal, not silently trusted.
- Enforces `timeout_ms` at this layer regardless of what the server does — a hung MCP server cannot hang the agent loop.

**5. Audit Log**
- Every invocation (attempted and completed) is written to durable storage: tool id, origin server, arguments (redacted per a configurable PII policy), result summary, latency, outcome (success/error/timeout), and which approval (if any) authorized it.
- This log is the basis for the "dynamic tool monitoring" security control referenced in §2.5 — alerting when a tool's observed behavior (latency profile, argument patterns, error rate) drifts from its historical baseline, which is a documented indicator of a compromised or updated-without-notice server.

### 3.3 Why This Design, Not Alternatives Considered

- **Single canonical schema + per-provider adapters** (vs. maintaining separate tool defs per model provider): avoids drift between three hand-maintained copies of the same tool, and is the only approach consistent with being genuinely model-agnostic (§1.4).
- **Permission gating centralized in one layer shared by native and MCP tools** (vs. MCP-specific permission logic bolted onto the MCP layer only): native tools (shell, file write) are at least as dangerous as third-party MCP tools and must not get a free pass just because they didn't come through MCP.
- **No default retry for external/destructive/financial tiers** (vs. framework-default retry-on-any-failure): chosen because the literature on tool-call reliability (`02_AI_AGENT_RESEARCH.md` §3) specifically flags non-atomic tool failures — a "failed" call that actually partially succeeded — as a documented, hard-to-detect error class; blind retry is how that becomes a double-send or double-charge.
- **Disabled-by-default on newly discovered/changed tools** (vs. auto-trusting server-declared capability updates): directly addresses the tool-poisoning/metadata-drift risk documented in MCP security guidance (§2.5) at the cost of some friction on legitimate server updates — an acceptable tradeoff given the blast radius of a silently-weaponized tool description.

---

## Sources

- Model Context Protocol, "Architecture overview" (spec `2026-07-28`) — https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture
- Model Context Protocol, transports specification — https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- Anthropic, "Tool use with Claude" — https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Anthropic, "Parallel tool use" — https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
- Anthropic, "Introducing advanced tool use on the Claude Developer Platform" — https://www.anthropic.com/engineering/advanced-tool-use
- OpenAI, "Function calling" — https://developers.openai.com/api/docs/guides/function-calling
- Google, "Function calling with the Gemini API" — https://ai.google.dev/gemini-api/docs/function-calling
- Descope, "Diving Into the MCP Authorization Specification" — https://www.descope.com/blog/post/mcp-auth-spec
- Cloud Security Alliance, "Agentic MCP Security Best Practices Guide" — https://labs.cloudsecurityalliance.org/agentic/agentic-mcp-security-best-practices-v1/
- Stack Overflow Blog, "Is that allowed? Authentication and authorization in Model Context Protocol" (Jan 2026) — https://stackoverflow.blog/2026/01/21/is-that-allowed-authentication-and-authorization-in-model-context-protocol/
