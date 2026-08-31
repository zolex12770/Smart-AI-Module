# Survey of Existing Agent Architectures

A survey of publicly documented architectures across three categories: autonomous coding agents, browser/research agents, and workflow/multi-agent orchestration frameworks. Purpose: extract transferable patterns for our original design, not to clone any single product.

**Tagging discipline**: every claim below is either **PUBLICLY DOCUMENTED** (stated in the vendor's own docs/blog/spec), **INFERRED** (a reasonable deduction from documented behavior, not itself stated), **ASSUMED** (a gap we're filling with a design guess, flagged as such), or **UNKNOWN** (genuinely undocumented — we say so rather than guessing). Internal implementation details of closed products (exact prompts, model routing logic, training data) are largely **UNKNOWN** unless a vendor has published them; where a source is a third-party reverse-engineering writeup rather than the vendor itself, that is noted.

---

## Category A: Autonomous Coding Agents

### A.1 Claude Code (Anthropic)

- **Problem solved**: a terminal-native coding agent that operates directly on a real repository with real tools (file read/write, shell, search), for both interactive and long-running autonomous use.
- **Agent loop**: **PUBLICLY DOCUMENTED** (Anthropic's own Agent SDK docs) as a `while (tool_call) { execute tool → feed result back → repeat }` loop that terminates when the model responds with plain text and no tool call. Third-party reverse-engineering writeups (not Anthropic's own disclosure) describe this as implemented in a small amount of core code with a flat, single-threaded conversation history, deliberately avoiding a hidden internal multi-agent graph for the main loop — a typical task runs an estimated 5–50 loop iterations. **Mixed sourcing**: the loop shape and termination condition are Anthropic-documented; specific line counts and "flat history" framing come from third-party analysis and should be treated as **INFERRED**, not vendor-confirmed.
- **Planning approach**: uses an explicit `Task`/todo-list mechanism and dedicated `Plan`/`Explore` sub-agent modes (documented via extracted system prompts and Anthropic's own "Explore/Plan/Code" workflow guidance) rather than a single implicit ReAct stream — the model is encouraged to externalize a plan as an artifact before executing.
- **Context management**: supports **compaction** (summarize-and-restart, per `02_AI_AGENT_RESEARCH.md` §2.1) and can delegate to **sub-agents with isolated context** that return condensed summaries — both are Anthropic-documented context-engineering patterns, and Claude Code is the product these were substantially developed for/validated in.
- **Tool architecture**: **PUBLICLY DOCUMENTED** — a fixed set of built-in tools (file read/write/edit, grep/glob search, bash execution, web fetch/search, task delegation) plus **MCP** for third-party extension (see `10_TOOL_AND_MCP_ARCHITECTURE.md`).
- **Memory**: project-level memory via a checked-in `CLAUDE.md` file (explicit, user-authored, version-controlled — not an inferred/auto-learned memory store) plus the general Claude memory feature described in `08_MEMORY_ARCHITECTURE.md` §5.
- **Model usage**: single primary model per session (model-selectable), with sub-agent invocations able to use the same or a different model.
- **File/terminal handling**: direct file edits (with diffs shown for review) and direct shell execution — this is a first-class, not bolted-on, capability.
- **Error recovery**: relies on the model observing tool errors (compile failures, test failures, lint errors) as ground truth and self-correcting in the next loop iteration, per the "ground truth from the environment" principle (`02_AI_AGENT_RESEARCH.md` §1.4).
- **Human approval**: **PUBLICLY DOCUMENTED** — "ask before act" default posture; every file-modifying or command-running action requires permission unless pre-allowlisted; a **sandboxing** layer (OS-level filesystem/network isolation) is offered specifically so a sandboxed session needs far fewer interactive prompts while still bounding blast radius. This is a three-layer documented model: permissions (what Claude may attempt), MCP server allowlisting (what external systems are reachable), and OS-level sandboxing (hard boundary independent of the model's behavior).
- **Security model**: layered defense-in-depth as above; explicitly designed against prompt injection by keeping destructive actions gated behind permission checks regardless of what the model "decides" to do, rather than trusting the model to refuse on its own.
- **Strengths**: simple, inspectable single-loop design avoids the coordination overhead and emergent-behavior debugging cost documented for multi-agent systems (`02_AI_AGENT_RESEARCH.md` §2.3); strong tool-design investment (ACI principle) reduces tool-call error rates; layered security model separates "what the model wants to do" from "what it's allowed to do" cleanly.
- **Weaknesses**: a flat single-threaded loop is bounded by one context window's worth of working state per session (mitigated but not eliminated by compaction/sub-agents); heavily tuned around one family of models, so "model-agnostic by design" is not a documented goal of this product (unsurprising, since Anthropic builds both).
- **What to learn**: the permission/sandbox/MCP-allowlist three-layer separation is a clean, reusable security model; compaction and sub-agent context isolation are validated, documented mitigations for context rot worth adopting directly (see `11_AGENT_LOOP.md`).
- **What NOT to copy**: don't assume single-model-family tuning transfers to a model-agnostic platform — our tool descriptions, prompts, and context-management thresholds need to be validated per model family, not tuned against one.

### A.2 GitHub Copilot — Agent Mode and Coding Agent

- **Problem solved**: two distinct but related products under one brand — **Agent Mode** (synchronous, runs inside the IDE, human watching in real time) and **Coding Agent** (asynchronous, runs in the cloud against an assigned issue, produces a PR). **PUBLICLY DOCUMENTED** distinction.
- **Agent loop / planning**: Coding Agent boots an isolated VM, clones the repo, sets up the environment, and analyzes the codebase with RAG powered by GitHub code search before beginning autonomous write/run/test iteration; it incorporates linked issue/PR discussion and repo-specific custom instructions as planning input.
- **Context management**: retrieval-based (GitHub code search RAG) rather than whole-repo-in-context; scoped to the assigned issue rather than an open-ended session.
- **Tool architecture**: full dev environment access inside the sandboxed VM (GitHub Actions-backed), including running the test suite.
- **File/terminal handling**: **PUBLICLY DOCUMENTED** — pushes incremental commits to a **draft pull request** as it works and updates the PR description live, which doubles as both a progress log and a resumable checkpoint artifact a human can inspect mid-task.
- **Error recovery**: runs the test suite itself as a grounded verification oracle before finalizing.
- **Human approval**: the draft-PR mechanism *is* the approval gate — nothing merges without a human reviewing and approving the PR; this is asynchronous HITL/HOTL hybrid by construction (agent runs autonomously; human approval is required only at the merge boundary, not at each step).
- **Security model**: **PUBLICLY DOCUMENTED** — sandboxed VM, restricted internet access (allowlisted egress), limited repository permissions scoped to the assigned task.
- **Strengths**: the draft-PR-as-checkpoint pattern is an elegant, low-friction approval mechanism that doesn't require a bespoke approval UI — it reuses a workflow developers already trust and know how to review.
- **Weaknesses**: **PUBLICLY DOCUMENTED** limitation — explicitly positioned for "low-to-medium complexity tasks in well-tested codebases," not open-ended autonomous engineering; effectiveness is directly coupled to the target repo already having a solid test suite, since that's the primary verification oracle.
- **What to learn**: using an artifact the human already reviews for other reasons (a PR) as the approval/checkpoint mechanism, rather than inventing a separate approval UI, is a strong, low-friction HITL pattern applicable beyond coding (e.g., a draft document, a draft email).
- **What NOT to copy**: don't assume a codebase has adequate tests as a given — a generalized platform needs an explicit fallback verification strategy for under-tested targets.

### A.3 Cursor — Agent Mode

- **Problem solved**: IDE-embedded autonomous multi-file coding, as the default interaction mode of the editor rather than a separate feature.
- **Agent loop / planning**: **PUBLICLY DOCUMENTED** (Cursor docs) — the agent operates inside an "Agent Harness" that exposes the project as an actionable environment (instructions/rules, tools, model selection bundled together); it plans and executes across multiple files, running tests and self-verifying.
- **Context management**: `.cursor/rules/` directory holds multiple rule files scoped to file globs, so only rules relevant to the current file/context are loaded — a documented, deliberately narrow-scoping approach to avoid dumping the whole ruleset into every context window.
- **Tool architecture**: built-in file editing, codebase search, terminal execution, plus first-class **MCP** support described explicitly as a "plugin system."
- **Memory**: primarily rules-file-based (explicit, user-authored, like Claude Code's `CLAUDE.md`) rather than an inferred long-term memory store — **INFERRED** that this is a deliberate choice favoring explicit/inspectable project conventions over auto-learned facts, consistent with how coding tools generally favor determinism over inference for anything that affects code correctness.
- **File/terminal handling**: edits are applied live and shown in a diff view for accept/reject — inline, incremental human review rather than an end-of-task batch review.
- **Human approval**: per-edit diff review (can be tuned toward more or less autonomy); this is a HITL-per-change default that can be relaxed.
- **Error recovery**: **PUBLICLY DOCUMENTED** — can spin up specialized sub-agents (research, shell commands, browser interaction) in parallel, each with its own context window, returning a result to the main conversation — directly mirroring the sub-agent context-isolation pattern from `02_AI_AGENT_RESEARCH.md` §2.1/2.3.
- **Strengths**: glob-scoped rules loading is a clean, cheap context-management technique; live diff review lowers the cost of catching a bad edit immediately rather than after a whole task completes.
- **Weaknesses**: **UNKNOWN** — Cursor has not published the same level of loop/architecture detail as Anthropic has for Claude Code; most public description is feature-level, not mechanism-level, so deeper claims here would be speculation.
- **What to learn**: glob-scoped, file-context-triggered rule loading as a lightweight alternative to summarization for keeping project conventions in context only when relevant.

### A.4 Devin (Cognition)

- **Problem solved**: a fully autonomous, cloud-hosted "AI software engineer" that takes a scoped task and works end-to-end without a human driving each step, including via a REST API for headless/agent-to-agent use.
- **Agent loop / architecture**: **PUBLICLY DOCUMENTED** (Cognition's own blog) as a **brain/devbox split**: the "brain" is a stateless reasoning coordinator (cloud-side) that does not execute code directly — it emits logical operations translated into tool executions; the "devbox" is the actual sandboxed execution workspace (its own terminal, editor, and browser) where code actually runs.
- **Planning approach**: the reasoning model evaluates the target codebase and compiles a step-by-step plan *before* writing code — an explicit plan-then-execute structure, not pure ReAct.
- **Multi-agent variant ("Devin Fusion")**: **PUBLICLY DOCUMENTED** — runs two parallel agents on a task, one on a frontier model and one on a cheaper "sidekick" model; the main agent decides which sub-tasks to delegate to the sidekick versus handle itself — a cost/capability trade managed dynamically per sub-task rather than fixed per task.
- **Tool architecture**: full sandboxed devbox with terminal, editor, browser — comparable in kind to Claude Code/Cursor's toolset but running remotely rather than on the developer's own machine.
- **Human approval**: **PUBLICLY DOCUMENTED** as designed to *not* require a human in the loop to start work (full REST API access), positioning it toward the HOTL end of the spectrum (`02_AI_AGENT_RESEARCH.md` §5) by default, more so than IDE-embedded tools that surface inline diffs per edit.
- **Strengths**: brain/devbox separation cleanly decouples "reasoning about what to do" from "the environment where it happens," which is a reusable architectural idea independent of Devin specifically — it maps onto keeping orchestration logic separate from sandboxed execution in any agent platform.
- **Weaknesses**: **UNKNOWN** internals beyond what's described above — Cognition has not published loop-level detail comparable to Anthropic's Agent SDK docs; independent evaluations of Devin's real-world autonomous success rate are mixed and often cite gaps between demoed and production performance, a pattern flagged generally in `02_AI_AGENT_RESEARCH.md` §3 ("demos look reliable because they're short and the environment behaves").
- **What to learn**: the brain/devbox (reasoning-coordinator vs. sandboxed-execution-workspace) separation as a clean architectural boundary; dynamic per-subtask model routing (Fusion) as a cost-control pattern more granular than picking one model for a whole task.
- **What NOT to copy**: don't default to "no human in the loop to start" as a platform-wide default — that's a reasonable choice for a product built around fully scoped, bounded tasks with a PR-review endpoint, but is a risk-tier decision that should be explicit and configurable in a general platform (`02_AI_AGENT_RESEARCH.md` §5), not baked in.

### A.5 OpenAI Codex CLI

- **Problem solved**: a terminal-native, locally-runnable coding agent, open-sourced under a permissive license (April 2025), sharing a common "harness" (core agent loop + execution logic) across CLI, cloud, and IDE-extension surfaces.
- **Sandbox architecture**: **PUBLICLY DOCUMENTED** — built-in shell escalation controls and a network proxy policy that blocks or allows outbound requests against a configurable allowlist; network access is **blocked by default**.
- **Security incident (worth noting as a real, documented lesson)**: Check Point researchers publicly disclosed in 2025 that project-supplied files could become an execution vector on the CLI — repository files that are supposed to be passive input material could, under some configurations, be turned into something the agent executes, breaking the intended trust boundary where "files in the repo" are supposed to be data, not code the agent runs. **PUBLICLY DOCUMENTED** (third-party security disclosure, not a Codex CLI self-report) — a concrete, real-world instance of the "repository content is a prompt-injection/execution surface" risk class discussed generally in `10_TOOL_AND_MCP_ARCHITECTURE.md` §2.5.
- **Configuration**: supports an `AGENTS.md` project-instructions file (an emerging convention, analogous to `CLAUDE.md`/Cursor rules) and MCP integration.
- **Strengths**: default-deny network posture is a genuinely strong default other tools should match; sharing one harness across local/cloud/IDE surfaces avoids maintaining three divergent agent loops.
- **Weaknesses**: the disclosed file-as-execution-vector issue is a concrete illustration that "the repo is just data" is an assumption that must be actively defended, not assumed safe by default — any agent that reads repository files into a context that can trigger tool calls (e.g., a file containing text that looks like an instruction) needs explicit content/instruction separation, not implicit trust.
- **What to learn**: default-deny network egress as the sandbox default (contrast with Copilot's "restricted... access" phrasing which is vaguer); one shared harness across surfaces.
- **What NOT to copy**: don't assume repository/file content is inert — the Check Point disclosure is a direct argument for treating all ingested file content (not just explicit user prompts) as a potential injection surface in our own file-reading tools.

### A.6 Aider

- **Problem solved**: terminal-based AI pair programming with heavy emphasis on git-native workflow and efficient codebase context via a purpose-built repository map, without an IDE or cloud sandbox.
- **Context management — the Repo Map**: **PUBLICLY DOCUMENTED** and one of the more concretely useful published techniques in this survey: Aider builds a compressed, ranked map of the repository using **tree-sitter** parses (symbol-level structural parsing, not naive text) and a **PageRank-style graph-ranking algorithm** over a graph where files are nodes and dependency relationships are edges, selecting the most important symbols/definitions to fit within a configured token budget. This is sent alongside every request instead of dumping the whole repo into context.
- **Planning approach — Architect mode**: **PUBLICLY DOCUMENTED**, and a genuinely distinct pattern from the plan-and-execute framing in `02_AI_AGENT_RESEARCH.md` §1.2: a strong "architect" model proposes *how* to solve the request in natural language, then a separate, typically cheaper/faster "editor" model turns that proposal into the actual file-editing instructions in a specific edit format. This is architecturally the plan-and-execute pattern applied specifically to the plan→diff boundary, with two different models rather than one model wearing two hats.
- **Tool architecture**: minimal by design — file edit (via a documented family of "edit formats," e.g., search/replace diff blocks that let the model return only the changed portion of a file rather than whole-file rewrites) and git (auto-commits each change, giving a natural undo/audit trail for free).
- **Error recovery**: documented "edit format" failures (a model producing a diff that doesn't cleanly apply) are a known, named failure class with dedicated troubleshooting docs — an explicit acknowledgment that the model-output-to-file-mutation boundary is a real reliability risk needing its own error handling, not just a "trust the model's output" assumption.
- **Human approval**: git auto-commit per change means the approval model is closer to HOTL — changes land automatically but are fully reversible/reviewable via normal git tooling (diff, revert) after the fact, rather than blocked pending approval before the fact.
- **Strengths**: the repo map's tree-sitter + PageRank approach is a well-engineered, cheap, and effective solution to "how do I give a model useful codebase context without either dumping everything or missing what matters" — directly reusable technique for any coding-agent context-management design; git-auto-commit-as-safety-net is a simple, low-overhead reversibility mechanism.
- **Weaknesses**: **INFERRED** — minimal sandboxing/tool surface (no described sandboxed execution environment comparable to Devin's devbox or Copilot's VM) means Aider's own security model leans heavily on git reversibility and the fact that it typically runs on a developer's own machine with their own judgment already in the loop, rather than on isolation primitives — appropriate for its target use case (a developer running it locally) but not directly transferable to an unattended/cloud agent.
- **What to learn**: tree-sitter-based, PageRank-ranked repo maps as the concrete technique for codebase context management (directly informs code-chunking in `09_RAG_ARCHITECTURE.md` §2); the architect/editor two-model split as a clean way to get plan-and-execute benefits (cheaper execution, higher-quality planning) without a full multi-agent framework; git-auto-commit as cheap reversibility.
- **What NOT to copy**: don't assume "runs on a trusted developer's own machine" security assumptions transfer to a hosted, multi-tenant, or unattended agent context.

### Cross-Cutting Table — Coding Agents

| | Claude Code | Copilot Coding Agent | Cursor Agent | Devin | Codex CLI | Aider |
|---|---|---|---|---|---|---|
| Execution location | Local | Cloud VM | Local (IDE) | Cloud (devbox) | Local (default) | Local |
| Planning style | Explicit task list / Plan mode | RAG-informed autonomous | Harness-driven autonomous | Explicit upfront plan | Harness-driven | Architect→Editor two-model |
| Primary verification oracle | Tests/lint/model observation | Repo test suite | Tests + inline diff review | Tests, own tooling | Tests/lint | Edit-format apply success |
| Approval default | Ask-before-act (relaxable via sandbox) | PR review gate | Per-edit diff review | API-first, minimal gating | Ask-before-act, network deny | Auto-commit (post-hoc reversible) |
| Context technique | Compaction + sub-agents | Code-search RAG | Glob-scoped rules + sub-agents | UNKNOWN | UNKNOWN | Tree-sitter + PageRank repo map |

---

## Category B: Browser and Research Agents

### B.1 OpenAI Operator / ChatGPT Agent (Computer-Using Agent, CUA)

- **Problem solved**: performing tasks through direct GUI interaction with a browser (or, in the unified "ChatGPT agent" successor, browser + terminal + APIs) rather than only through structured APIs — booking, form-filling, ordering, and similar tasks that have no clean API.
- **Architecture**: **PUBLICLY DOCUMENTED** — the CUA model processes raw screenshots (pixel-level, not DOM/accessibility-tree-level) and drives a virtual mouse/keyboard, allowing it to act on essentially any visual interface without needing site-specific integration. Operator was folded into a unified "ChatGPT agent" (July 2025) combining Operator's browser interaction, "deep research"'s synthesis capability, and conversational ChatGPT — equipped with a **visual browser**, a **text-based browser** for simpler reasoning-only lookups, a **terminal**, and direct API access, letting the system choose the cheapest sufficient modality per step rather than always using the expensive visual/pixel path.
- **Human approval**: **PUBLICLY DOCUMENTED** general pattern for computer-use-style agents (both OpenAI's and, per §B.2, Anthropic's) — sensitive actions (submitting a purchase, entering credentials) are documented as requiring explicit user confirmation before proceeding, a targeted HITL checkpoint layered onto an otherwise autonomous loop.
- **Strengths**: pixel-level interaction generalizes to any site/app with no per-target integration work; the multi-modality design (visual vs. text browser vs. terminal vs. API) is a clean cost/capability trade made per step.
- **Weaknesses**: **INFERRED** from the general nature of vision-driven GUI automation (not a specific OpenAI admission) — screenshot-driven interaction is inherently slower and more token/compute-expensive per step than a structured API call, and is exposed to visual prompt injection (malicious instructions rendered on a page) in a way structured API calls are not.
- **What to learn**: modality selection per step (cheap text-based path first, fall back to expensive visual/pixel interaction only when needed) as a cost-control pattern generalizable beyond browsing.

### B.2 Anthropic Computer Use

- **Problem solved**: the same class of problem as CUA (generalized desktop/GUI control via vision) exposed as an API tool (`computer_use`) rather than a packaged end-user product, released in public beta October 2024.
- **Architecture**: **PUBLICLY DOCUMENTED** — Claude takes a screenshot, interprets the visual layout, and issues mouse/keyboard actions plus bash commands; it is explicitly a **client-side tool** — screenshots, inputs, and files stay in the developer's own environment/execution loop, not sent to or stored by Anthropic beyond the API call itself.
- **Security model**: **PUBLICLY DOCUMENTED** — Anthropic trained the model with resistance to prompt injection and layered on classifiers that scan for injection attempts in screenshots, automatically steering the model to pause and request user confirmation when one is flagged. Anthropic's own guidance is explicit that this is a mitigation, not a guarantee: "jailbreaks and prompt injection can affect computer use as they can any frontier AI system," and the documented recommendation is to run it inside a VM or container with minimal privileges regardless of model-level defenses.
- **What to learn**: treating model-level injection resistance as a *defense-in-depth layer*, never a substitute for environment-level sandboxing, is the correct posture and directly reinforces the sandboxing requirements in `10_TOOL_AND_MCP_ARCHITECTURE.md` §2.6; the "client-side tool, host owns the data" architecture is the same trust model as Claude's memory tool (`08_MEMORY_ARCHITECTURE.md` §5) and worth replicating for any tool where privacy/control matters — the platform vendor never needs custody of the sensitive execution surface.

### B.3 Google Project Mariner / Gemini Deep Research

- **Problem solved**: two related but distinct efforts — **Project Mariner** (browser-control research prototype, Gemini-based) and **Gemini Deep Research** (multi-step web research and synthesis agent). **PUBLICLY DOCUMENTED** as separate initiatives, sometimes conflated in secondary coverage.
- **Mariner architecture**: **PUBLICLY DOCUMENTED** at a high level — reported to run on a virtual-machine architecture enabling multiple (reportedly up to ten) tasks concurrently, achieving a reported 83.5% on the WebVoyager browser-agent benchmark as a single-agent setup. Deeper mechanism detail (exact orchestration internals) is **UNKNOWN** — Google has not published Mariner internals to the depth Anthropic has for Claude Code.
- **Deep Research architecture**: **PUBLICLY DOCUMENTED** pattern — on receiving a query, the agent first produces a multi-step research plan *for interactive user review and modification before execution* (an explicit plan-approval checkpoint, distinct from the coding agents above which mostly gate at the execution/output stage rather than the plan stage), then executes asynchronously, managing multiple simultaneous sub-investigations, using RAG-style adaptive multi-round web retrieval rather than a single search pass.
- **What to learn**: **plan-stage human approval** (review/edit the plan before any execution starts) is a distinct and valuable checkpoint compared to only reviewing outputs or individual actions — worth including as an explicit option in our approval model (`11_AGENT_LOOP.md`) for tasks where getting the plan wrong is expensive to discover only after execution.

### B.4 Anthropic's Multi-Agent Research System (Claude "Research")

Covered in depth in `02_AI_AGENT_RESEARCH.md` §2.3 and §1.4; summarized here for completeness within this survey. **PUBLICLY DOCUMENTED**: orchestrator-worker architecture — a lead agent plans and spawns 3–5 parallel subagents, each with an isolated context window and its own tool access, whose condensed results the lead agent synthesizes, followed by a separate citation-verification pass. Reported (Anthropic's own internal eval, not independently audited) 90.2% improvement over single-agent Opus 4 on their research benchmark, at roughly 15x the token cost. Anthropic's own explicit caveat — multi-agent decomposition is a poor fit for "domains that require all agents to share the same context or involve many dependencies between agents," specifically naming coding as a bad fit — is one of the most directly load-bearing pieces of guidance in this entire survey for deciding *when not* to reach for a multi-agent pattern in our own platform.

---

## Category C: Workflow / Multi-Agent Orchestration Frameworks

These are developer frameworks (not end-user products) for building agents — most relevant to how we might structure our own orchestration layer, and to which conventions (MCP, etc.) have become de facto standards.

### C.1 LangGraph

- **Problem solved**: explicit, graph-based control flow for agents — states and transitions as first-class graph nodes/edges rather than an implicit prompt loop — aimed specifically at production reliability, durability, and inspectability.
- **Planning/control model**: **PUBLICLY DOCUMENTED** — developer defines a state graph explicitly; this is closer to the "workflow" end of Anthropic's workflow-vs-agent spectrum (`02_AI_AGENT_RESEARCH.md` §1.4) by default, with agentic (model-directed) branches composed in as specific nodes rather than the whole system being one open-ended loop.
- **State/persistence**: **PUBLICLY DOCUMENTED**, and the most directly relevant piece of this framework for our design — **checkpointers** persist a full state snapshot after every "super-step," keyed by thread id, with Postgres/SQLite-backed checkpointers recommended for production (in-memory only for dev). This is documented as the basis for crash recovery, HITL pause/resume (the graph can `interrupt` at a node and wait for external input), and time-travel debugging (replay or branch from an earlier checkpoint). A documented caveat carried over into our own design (`02_AI_AGENT_RESEARCH.md` §6): checkpointing state is not the same guarantee as full durable execution — non-idempotent side effects inside a step can re-run on resume unless explicitly guarded.
- **Human approval**: first-class `interrupt` primitive at the graph level — approval is a graph-structural feature, not bolted on.
- **Strengths**: the checkpoint/thread/interrupt model is a clean, production-grade, directly reusable pattern for resumable multi-step agents — this is one of the most concretely transferable designs in this whole survey.
- **Weaknesses**: **PUBLICLY DOCUMENTED, by independent analysis, not LangChain's own claim** — checkpointing is sometimes conflated with true durable execution (à la Temporal-style workflow engines) when it isn't fully equivalent; graph-based explicit control flow trades some of the flexibility of a fully open-ended agent loop for its reliability gains, which is a deliberate and documented tradeoff, not a limitation to "fix."
- **What to learn**: adopt the checkpoint-per-step, thread-id-keyed, Postgres-backed persistence model close to as-is for our own task-graph persistence (`11_AGENT_LOOP.md`); adopt `interrupt`-as-graph-primitive for approval gating.

### C.2 CrewAI

- **Problem solved**: role-based multi-agent collaboration expressed in a small amount of code — agents with a role/goal/backstory, tasks with a description/expected-output, composed into "crews."
- **Planning/control model**: **PUBLICLY DOCUMENTED** — two process types: **Sequential** (tasks execute in defined order, each agent working autonomously, no central coordinator) and **Hierarchical** (a manager agent delegates, evaluates, and validates results before proceeding — closer to the orchestrator-workers pattern from `02_AI_AGENT_RESEARCH.md` §1.4). "Flows" add event-driven state, branching, and routing on top for more complex production logic.
- **Tool/protocol architecture**: **PUBLICLY DOCUMENTED** as having native MCP and A2A (agent-to-agent) protocol support, marketed as its differentiator for plugging into the broadest existing tool/agent ecosystem with the least custom glue code.
- **Strengths**: low-code path to a working multi-agent system; role/goal/backstory as a structured prompt-construction convention is a simple, reusable way to keep agent persona/scope consistent across a crew.
- **Weaknesses**: **INFERRED** — the same coordination/emergent-behavior risks documented for multi-agent systems generally (`02_AI_AGENT_RESEARCH.md` §2.3, error compounding in §3) apply to any hierarchical/sequential agent-team framework, and role-based multi-agent frameworks in general are noted across 2025-2026 practitioner writeups as easy to prototype but harder to make reliable at task counts beyond a handful of agents.
- **What to learn**: role/goal/backstory as a lightweight, structured way to template agent-specific system prompts; sequential vs. hierarchical as two named, distinct coordination modes worth supporting explicitly rather than one generic "multi-agent" mode.

### C.3 AutoGen / AG2

- **Problem solved**: originally Microsoft's multi-agent *conversation* framework — agents that negotiate, critique, and iteratively refine each other's outputs through structured dialogue.
- **Status**: **PUBLICLY DOCUMENTED** — Microsoft moved AutoGen to maintenance mode in 2026 (existing deployments continue to work; no new features planned); **AG2** is the actively maintained continuation/fork, positioned specifically for multi-agent conversational patterns (negotiation, critique-and-refine loops) rather than as a general-purpose single-agent framework.
- **What to learn**: the conversational multi-agent pattern (agents critiquing each other's output, structured as dialogue turns rather than a pipeline) is a distinct and useful pattern for tasks that genuinely benefit from adversarial/critical review (echoing the "inspector pattern" verification approach noted in `02_AI_AGENT_RESEARCH.md` §3, which reported a 96.4% error-recovery rate from an independent verifier agent) — worth supporting as one mode, not the default mode, in our orchestration design.
- **What NOT to copy**: the framework's own trajectory (actively developed → maintenance mode within roughly a two-year window) is a reminder that framework-level lock-in is a real risk; our internal orchestration should not assume any external framework's API surface is stable long-term, reinforcing the case for an original, in-house task-graph design (`11_AGENT_LOOP.md`) rather than building directly atop a third-party framework's abstractions.

### C.4 OpenAI Agents SDK

- **Problem solved**: a lightweight, Python-first SDK for single-agent and simple multi-agent (via handoff) applications, positioned as the fast path for a single agent calling one or two tools rather than a heavyweight orchestration framework.
- **Core primitives**: **PUBLICLY DOCUMENTED** — four primitives: **Agents** (LLM + instructions + tools), **Tools**, **Handoffs** (agent-to-agent delegation, represented to the model as a callable tool, e.g. `transfer_to_refund_agent` — the new agent then sees the full prior conversation history by default, though input filters can modify what's passed), and **Guardrails** (input/output validation running in parallel with execution, with a "tripwire" that halts execution immediately on violation).
- **Strengths**: representing a handoff *as a tool call* is an elegant unification — the model doesn't need a separate "delegate" concept distinct from "call a function," which simplifies both the model-facing interface and the implementation; guardrails-as-parallel-checks-with-a-tripwire is a clean, fail-fast safety pattern.
- **Weaknesses**: **INFERRED** from its own positioning — explicitly not the tool for complex, deeply stateful, or heavily branching orchestration (that's LangGraph's/ADK's niche per current framework-comparison writeups); handoff passing the *entire* prior conversation by default is a documented context-management consideration (risk of context rot / cost growth compounding across handoffs, per `02_AI_AGENT_RESEARCH.md` §2.2) that a builder must actively manage via input filters rather than get for free.
- **What to learn**: handoff-as-tool-call as a clean way to expose delegation to the model without inventing a parallel mechanism; guardrails as parallel (not sequential/blocking-by-default) checks with an explicit tripwire concept.

### C.5 Google Agent Development Kit (ADK)

- **Problem solved**: a code-first, multi-language (Python, Go, TypeScript as of ADK 2.0) framework for building, evaluating, and deploying agents, with native ties to Google Cloud/Vertex AI/Gemini infrastructure.
- **Core building blocks**: **PUBLICLY DOCUMENTED** — **Agents** (LLM-powered reasoning/planning/tool-use units, composable into teams), **Tools** (external API/code-execution/service access), and **Session Services** (own the context of a single conversation: history as "Events," working memory as "State").
- **Memory model**: **PUBLICLY DOCUMENTED** — explicit separation between session-scoped State (short-term, managed automatically by the SessionService) and a distinct, longer-term **Memory service** integration point for recalling user information *across* sessions — directly mirroring the short-term/long-term split in our own `08_MEMORY_ARCHITECTURE.md` §2, and a useful external validation that this split is a converged-upon good idea, not an idiosyncratic choice.
- **Orchestration flexibility**: supports both predictable predefined "workflow agent" pipelines and adaptive agent-coordinated dynamic routing — explicitly offering both ends of the workflow-vs-agent spectrum as first-class options rather than picking one.
- **What to learn**: the Events/State split within Session Services as a clean separation of "what happened" (immutable log) from "what we currently believe/hold" (mutable working memory) — a distinction directly reusable in our own task-memory and conversation-memory design (`08_MEMORY_ARCHITECTURE.md` §2–3).

### Cross-Cutting Table — Orchestration Frameworks

| | LangGraph | CrewAI | AutoGen/AG2 | OpenAI Agents SDK | Google ADK |
|---|---|---|---|---|---|
| Control model | Explicit state graph | Sequential / Hierarchical crews | Conversational multi-agent | Agent + handoff (tool-based) | Workflow agents + dynamic routing |
| Persistence | Checkpointer (Postgres/SQLite), thread-scoped | **UNKNOWN** — not a documented core focus | **UNKNOWN** | **UNKNOWN** — session-based, not documented as durable by default | SessionService (State + Events) |
| HITL primitive | `interrupt` (graph-native) | **UNKNOWN** | Conversational turn-taking itself is the review mechanism | Guardrail tripwire (stop, not pause-for-approval) | **UNKNOWN** |
| Best documented fit | Complex, stateful, production workflows needing durability | Fast-to-prototype role-based teams | Agents critiquing/refining each other | Single agent, 1-2 tools, fast Python path | Multi-language enterprise, GCP-native |
| Status (2026) | Actively developed, considered most production-ready per multiple 2026 comparisons | Actively developed | Maintenance mode (AutoGen); AG2 active | Actively developed | Actively developed (2.0 in 2026) |

**Convergence point worth stating plainly**: multiple independent 2025–2026 framework comparisons report that essentially all major frameworks converged on **MCP as the standard tool-integration layer** by 2025–2026, making MCP-compliant tools portable across frameworks regardless of which orchestration layer is used. This is direct external validation for building our own tool layer MCP-native from the start (`10_TOOL_AND_MCP_ARCHITECTURE.md`) rather than inventing a proprietary tool-integration format.

---

## Synthesis: What We Take Into Our Own Design

1. **Persistence**: LangGraph's checkpoint/thread model, adapted to our own task-graph schema (`11_AGENT_LOOP.md`).
2. **Context management**: Anthropic's compaction + sub-agent isolation (validated at scale in Claude Code and the multi-agent research system) as our default strategy, plus Aider's tree-sitter/PageRank repo-map technique specifically for code context, plus Cursor's glob-scoped rule loading for project conventions.
3. **Approval model**: a risk-tiered spectrum, not one global toggle — Copilot's draft-PR-as-checkpoint, Google Deep Research's plan-stage approval, LangGraph's graph-native `interrupt`, and Devin/Codex's ask-before-act-with-sandbox-relaxation are four genuinely different points on this spectrum, and our design should support all four as configurable modes rather than picking one.
4. **Tool layer**: MCP-native by default, following the converged industry pattern, with the permission/sandbox layering documented for Claude Code and Codex CLI as the security baseline.
5. **Multi-agent restraint**: Anthropic's own explicit caveat — multi-agent decomposition is a poor fit for tightly-coupled, shared-context work like coding — is treated as a hard design constraint: our coding-agent surface should default to a single-loop-with-sub-agent-context-isolation-for-research-subtasks model (Claude Code's approach), not a CrewAI/AutoGen-style multi-agent-team default.
6. **What we explicitly avoid replicating**: any single vendor's undocumented internals (asserted nowhere as fact in this document); Devin's minimal-gating default and Aider's locally-trusted-machine security assumptions, neither of which are safe defaults for a general, potentially multi-tenant platform; and hard dependence on a third-party orchestration framework's API surface, given AutoGen's maintenance-mode trajectory as a cautionary, documented example of framework churn.

---

## Sources

- Anthropic, "How the agent loop works" (Agent SDK docs) — https://platform.claude.com/docs/en/agent-sdk/agent-loop
- GitHub Piebald-AI, "claude-code-system-prompts" (third-party extraction, not vendor-published) — https://github.com/Piebald-AI/claude-code-system-prompts
- Anthropic, "Claude Code sandboxing" — https://anthropic.com/engineering/claude-code-sandboxing
- GitHub Blog, "GitHub Copilot coding agent 101" — https://github.blog/ai-and-ml/github-copilot/github-copilot-coding-agent-101-getting-started-with-agentic-workflows-on-github/
- GitHub Docs, "About GitHub Copilot cloud agent" — https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
- Cursor Docs, "Agent mode" / "Overview" — https://cursor.com/help/ai-features/agent ; https://cursor.com/docs/agent/overview
- Cognition, "Devin Fusion" — https://cognition.com/blog/devin-fusion
- Cognition, "How Cognition Uses Devin to Build Devin" — https://cognition.com/blog/how-cognition-uses-devin-to-build-devin
- ZenML LLMOps Database, "Building Production-Ready AI Agents: OpenAI Codex CLI Architecture and Agent Loop Design" — https://www.zenml.io/llmops-database/building-production-ready-ai-agents-openai-codex-cli-architecture-and-agent-loop-design
- Aider docs, "Repository map" — https://aider.chat/docs/repomap.html
- Aider docs/blog, "Separating code reasoning and editing" (Architect mode) — https://aider.chat/2024/09/26/architect.html
- OpenAI, "Introducing Operator" — https://openai.com/index/introducing-operator/
- OpenAI, "Introducing ChatGPT agent: bridging research and action" — https://openai.com/index/introducing-chatgpt-agent/
- OpenAI, "Computer-Using Agent" — https://openai.com/index/computer-using-agent/
- Anthropic, "Computer use tool" (Claude Platform Docs) — https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Wikipedia, "Project Mariner" (secondary aggregation of Google's public statements) — https://en.wikipedia.org/wiki/Project_Mariner
- Claude/Anthropic, multi-agent research system blog — https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- LangChain/LangGraph, "Persistence" docs — https://docs.langchain.com/oss/python/langgraph/persistence
- CrewAI Docs — https://docs.crewai.com/
- OpenAI, "Handoffs" / "Guardrails" (Agents SDK docs) — https://openai.github.io/openai-agents-python/handoffs/ ; https://openai.github.io/openai-agents-python/guardrails/
- Google, ADK Technical Overview — https://google.github.io/adk-docs/get-started/about/
- RaftLabs, "Which AI Agent Framework to Choose in 2026" — https://raftlabs.medium.com/which-ai-agent-framework-to-choose-in-2026-5d44f37edea9
