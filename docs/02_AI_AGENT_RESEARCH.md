# AI Agent Research: How Modern Agents Actually Work

This document grounds our platform design in publicly documented research and engineering practice on LLM agents as of mid-2026. It covers the core control loop, the major planning patterns, why naive implementations fail in production, and how production systems handle multi-step tasks, approval, and resumability.

Every claim about a specific vendor's internals is tagged **PUBLICLY DOCUMENTED**, **INFERRED**, **ASSUMED**, or **UNKNOWN**. Untagged statements are general, vendor-neutral technical facts (e.g., how transformer attention behaves) or synthesis drawn directly from the cited sources.

---

## 1. The Core Loop: Understand → Plan → Execute → Observe → Verify → Correct

Nearly every production agent, regardless of framework, implements some variant of a single loop. The names differ, but the shape is consistent across the literature:

1. **Understand** — parse the user's request/goal, gather the minimum necessary context (files, prior conversation, retrieved documents) to know what "done" looks like.
2. **Plan** — decide on a next action or a sequence of actions. This can be implicit (a single "next tool call" decision, as in ReAct) or explicit (a written multi-step plan, as in plan-and-execute).
3. **Execute** — call a tool, run code, query an API, or produce a direct answer.
4. **Observe** — read the result: tool output, error, stdout/stderr, retrieved data, or user feedback.
5. **Verify** — check whether the observation satisfies the step's intent (tests pass, data matches schema, task criteria met) — not just "did the tool return without error."
6. **Correct** — if verification fails, decide whether to retry with adjusted arguments, replan, ask the user, or fail explicitly.

The loop is not always distinguishable in a single call — a ReAct-style agent conflates "plan" and "execute" into "decide next tool call," and verification is often implicit in whether the model chooses to keep going. The value of naming these six phases explicitly (as we do in `11_AGENT_LOOP.md`) is that it lets an orchestrator apply different policies per phase — e.g., require human approval only at the Plan→Execute transition, or retry only at Correct.

### 1.1 ReAct: reasoning interleaved with acting

The foundational pattern is **ReAct** (Yao et al., 2022, *"ReAct: Synergizing Reasoning and Acting in Language Models"*, arXiv:2210.03629). ReAct interleaves free-text "Thought" traces with "Action" (tool call) and "Observation" (tool result) steps in a single autoregressive stream, so reasoning can update the plan after every observation and actions can be grounded by real environment feedback rather than the model's own unchecked chain of thought. On HotpotQA and FEVER, ReAct reduced hallucination and error propagation compared to chain-of-thought-only baselines; on ALFWorld and WebShop it beat imitation/RL baselines by 34 and 10 absolute points respectively, using only 1–2 in-context examples. ([arXiv:2210.03629](https://arxiv.org/abs/2210.03629))

ReAct's strength is adaptiveness: because it re-plans after every single observation, it handles environments where each tool result can change what should happen next (browsing, debugging, exploratory search). Its weakness, confirmed by later practitioner writeups, is that it is short-horizon and myopic by construction — the model only ever "sees" one step ahead, so on long tasks it can wander, repeat itself, or lose track of the overall goal, and every step costs a full model call.

### 1.2 Plan-and-execute

The alternative pattern separates planning from execution: a (usually stronger/more expensive) model produces an upfront multi-step plan; a (usually cheaper/faster) model or deterministic executor then carries out each step in sequence, re-invoking the planner only on failure or significant deviation. This is popularized in LangChain/LangGraph's "Plan-and-Execute" reference architecture. Reported tradeoffs:

| Dimension | ReAct | Plan-and-Execute |
|---|---|---|
| Adaptiveness to surprising observations | High — replans every step | Lower — needs explicit replanning trigger |
| Cost profile | N × (strong model call) | 1 × strong model (planner) + N × cheap model (executor) |
| Inspectability / human review before execution | Low (plan is implicit, discovered step by step) | High (plan is an artifact that can be shown and approved) |
| Best fit | Exploratory tasks, unknown environment, unpredictable branching | Tasks with stable, mostly-known structure and reviewable dependencies |

(Comparison synthesized from multiple 2025–2026 practitioner sources on LangGraph plan-and-execute vs. ReAct; general pattern description, not vendor-specific internals.)

### 1.3 Plan-Execute-Verify and Reflection

A third family adds an explicit verification/self-critique step after execution, rather than relying on the next planning step to notice failure implicitly. **Reflexion** (Shinn et al., 2023) is the most-cited version: after each attempt, the agent generates a verbal self-critique of what went wrong, stores it in an episodic memory buffer, and uses it to condition the next attempt. Reported result: substantially higher pass rates on coding/decision benchmarks over repeated attempts versus one-shot generation.

Two caveats are important for our design, both raised in 2025–2026 replication and production-reliability literature:

- **Self-critique from the same model that generated the output tends to repeat the same blind spots** — a 2025 replication found single-agent Reflexion agents re-making the same misconception across retries because critic and generator share weights and priors. This argues for either an independent verifier (a different prompt context, a different model, or a deterministic check like tests/schema validation) rather than "ask the same model if it's right."
- Verification must be **grounded** (tests, execution results, schema checks, retrieved facts) wherever possible rather than purely linguistic self-assessment, echoing Anthropic's point that agents should get "ground truth from the environment at each step" rather than trusting their own narrative of success. ([anthropic.com/engineering/building-effective-agents](https://www.anthropic.com/engineering/building-effective-agents))

### 1.4 Workflows vs. agents — Anthropic's framing

Anthropic's widely cited engineering post **"Building Effective Agents"** draws a deliberate distinction that we adopt as vocabulary:

- **Workflows**: LLMs and tools orchestrated through *predefined code paths* — prompt chaining, routing, parallelization (sectioning/voting), orchestrator-workers, evaluator-optimizer. Predictable, testable, cheaper.
- **Agents**: systems where the *LLM dynamically directs its own process and tool use*, retaining control over how a task is accomplished, typically running open-loop until a stopping condition or human checkpoint.

Their recommendation, which we treat as a design constraint rather than a suggestion: **start with the simplest structure that solves the problem — a single call with good retrieval and few-shot examples is often enough — and only escalate to a full agent loop when the task genuinely requires open-ended, unpredictable tool use.** Agentic systems trade latency and cost for flexibility and should be justified per use case, not applied by default. ([anthropic.com/engineering/building-effective-agents](https://www.anthropic.com/engineering/building-effective-agents))

The post also introduces the **Agent-Computer Interface (ACI)** concept: tool definitions deserve as much design investment as a human-facing UI. Concretely documented recommendations: give tools clear boundaries and example usage in their descriptions, favor formats that avoid incidental overhead (e.g., don't make the model count lines or escape strings unnecessarily), test tools with many example inputs and iterate on the docstring, and use "poka-yoke" (mistake-proofing) argument design — e.g., Anthropic's own SWE-bench agent improved materially just by requiring absolute file paths instead of relative ones, because relative paths after a `cd` were a recurring source of model error. This directly informs our tool registry design in `10_TOOL_AND_MCP_ARCHITECTURE.md`.

---

## 2. Context Window Management

### 2.1 Context is a finite, decaying resource — not just a size limit

Anthropic's follow-up post **"Effective Context Engineering for AI Agents"** (Sept 2025) reframes the problem: the question isn't just "does it fit," but "what is the highest-signal set of tokens to include." Documented strategies:

- **Compaction**: when a conversation nears its context limit, summarize it and restart with the compressed summary, explicitly preserving architectural decisions and open issues while discarding redundant tool output and resolved side-quests.
- **Structured note-taking / agentic memory**: the agent writes persistent notes *outside* the context window (a scratchpad file, a task list) so it can track long-running state without keeping it all in-context. Anthropic cites their "Claude plays Pokémon" demo maintaining exact game-state tallies across thousands of steps this way.
- **Sub-agent architectures with context isolation**: instead of one agent accumulating unbounded history, specialized sub-agents work in their own clean context window and return a condensed summary (Anthropic cites 1,000–2,000 tokens) to the coordinator, rather than their full transcript.
- **Just-in-time retrieval over upfront pre-loading**: rather than stuffing all potentially relevant data into the system prompt at the start, maintain lightweight references (file paths, IDs) and let the agent pull data via tool calls when it actually needs it — closer to how a human keeps a mental index and looks things up rather than memorizing a codebase. Anthropic recommends a hybrid: some upfront retrieval for known-necessary context, plus autonomous exploration for the rest.
([anthropic.com/engineering/effective-context-engineering-for-ai-agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents))

### 2.2 Context rot: why "it still fits" isn't "it still works"

Chroma's 2025 research report, **"Context Rot: How Increasing Input Tokens Impacts LLM Performance"**, tested 18 frontier models (including GPT-4.1, Claude Opus/Sonnet 4, Gemini 2.5, Qwen3) and found that reliability degrades measurably as input length grows — even well below the model's advertised context limit, and even on simple tasks like retrieval or verbatim text replication. This is treated as an **architectural property of transformer attention, not a capability gap trainable away**: RoPE's long-term decay reduces similarity scores between distant token pairs, and softmax normalization concentrates attention further, producing the well-known "lost-in-the-middle" effect where models attend well to the start/end of context and poorly to the middle (reported degradations of 30%+ on some tasks). ([Chroma report via zenml.io summary](https://www.zenml.io/llmops-database/context-rot-evaluating-llm-performance-degradation-with-increasing-input-tokens); [redis.io/blog/context-rot](https://redis.io/blog/context-rot/))

**Design implication**: a "just keep appending to one long conversation" agent will get *less* reliable the longer it runs, independent of whether it technically still fits in the context window. This is the strongest argument for compaction, sub-agent isolation, and structured external memory rather than an ever-growing transcript — see `11_AGENT_LOOP.md` §context management and `08_MEMORY_ARCHITECTURE.md`.

### 2.3 Multi-agent context isolation in practice

Anthropic's own **multi-agent research system** (the architecture behind Claude's "Research" feature) is a documented case study in using sub-agent context isolation to fight both context rot and error compounding: a lead/orchestrator agent plans and spawns 3–5 subagents in parallel, each with its own context window, tools, and exploration trajectory; the orchestrator synthesizes their condensed results, with a separate citation-verification pass at the end. Anthropic reports this beat single-agent Opus 4 by 90.2% on their internal research eval — at roughly 15x the token cost of a single chat turn. Anthropic is explicit that this pattern is *not* universally good: "domains that require all agents to share the same context or involve many dependencies between agents are not a good fit for multi-agent systems today" — they specifically call out coding and most tightly-coupled agentic workflows as poor fits for this decomposition. **PUBLICLY DOCUMENTED** (Anthropic engineering blog); the 90.2%/15x figures are Anthropic's own reported internal eval numbers, not independently verified. ([claude.com/blog/building-multi-agent-systems...](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them))

---

## 3. Why Naive Single-Prompt-Loop Agents Fail

A "naive agent" here means: one long-running conversation, one model, a `while (tool_call) { execute; append result; }` loop with no separate planning artifact, no verification step distinct from "did the tool error," and no context management beyond truncation.

Three compounding failure mechanisms are consistently documented in 2025–2026 practitioner and research literature:

1. **Context rot** (§2.2) — reliability silently degrades with transcript length, so a naive agent gets worse the longer the task runs, exactly when long tasks need it to get *better* at tracking state.
2. **Error/tool-call compounding** — a small per-step error rate compounds multiplicatively across dependent steps. A model with a 95% chance of doing any single step correctly has roughly a 60% chance of completing a 10-step chain correctly if errors are independent and uncorrected (0.95^10 ≈ 0.60), and much worse if errors are correlated or a wrong action changes the state that later steps depend on ("binding drift" — a reference to an entity/variable that was correct at step 1 silently becomes wrong later and is not caught because nothing re-validates it). Because agent frameworks typically treat tool calls as atomic success/fail, a *non-atomic* mismatch — the tool "succeeded" but did something subtly different from what the model's belief-state assumed — is a documented, hard-to-detect failure class. ([arXiv:2607.18316 "Binding Drift"](https://arxiv.org/html/2607.18316); [arXiv:2608.02645 "Verified Tool Calls"](https://arxiv.org/html/2608.02645v1))
3. **No grounded verification step** — if "keep going" is the only implicit check on correctness, the agent has no mechanism to notice it solved the wrong problem, satisfied the letter of an instruction while violating its intent, or silently dropped a constraint stated earlier in a now-decayed context. Documented recurring long-horizon failure modes include: losing explicit constraints (required formats, naming rules) stated early in the task; overlooking information revealed mid-execution; proceeding on missing evidence instead of asking; and getting stuck in repetitive loops without recognizing a local optimum — benchmarks like WebArena report success rates often under 15% on long-horizon tasks partly for this reason. ([Openlayer, "AI Agent Failure Modes"](https://www.openlayer.com/blog/ai-agent-failure-modes-tool-calling-loops-propagation); [arXiv:2604.11978 "The Long-Horizon Task Mirage"](https://arxiv.org/html/2604.11978v1))

The practical conclusion cited across sources: **demos look reliable because they're short and the environment behaves; production is long-horizon, has messy tool outputs, and accumulates state that can silently corrupt.** Mitigations that recur across the literature — explicit plan artifacts that persist and can be re-checked, sub-agent/context isolation, independent (not self-referential) verification, idempotent and re-checkable tool calls, and bounded retry with escalation rather than infinite retry loops — are exactly the mechanisms we build into the state machine in `11_AGENT_LOOP.md`.

---

## 4. How Production Agents Handle Multi-Step Tasks

Cross-referencing the coding-agent survey in `03_EXISTING_AGENT_ARCHITECTURES.md`, the recurring structural elements for multi-step task handling are:

- **An explicit, persisted plan/task list** the agent (and the user) can inspect and that survives longer than a single model call — e.g., a todo/task list artifact updated as steps complete, rather than the plan existing only implicitly in conversation history.
- **Sub-task delegation with bounded context** — breaking a large task into smaller units each executed with a fresh or pruned context window, and only a summary flowing back up.
- **Environment grounding at every step** — running tests, linters, type checkers, or schema validators as the actual verification oracle instead of asking the model to self-assess.
- **Bounded iteration with escalation** — a cap on retries per step, after which the agent should surface the failure to the user/orchestrator rather than loop indefinitely.
- **Incremental externalized progress** — writing partial results out (draft PRs, intermediate files, checkpoints) so a crash or timeout doesn't lose all progress, and so a human can inspect in-flight state.

## 5. Human-in-the-Loop (HITL) Approval Patterns

The field increasingly distinguishes two oversight models:

- **Human-in-the-Loop (HITL)**: the human is *inside* the control loop — the agent blocks and waits for explicit approval before taking a given action. Used for irreversible or high-risk actions.
- **Human-on-the-Loop (HOTL)**: the human monitors execution asynchronously and intervenes only on anomaly/exception — the agent proceeds by default. Used for low-risk, easily-reversible, or high-volume actions where blocking on every step would be impractical.

A commonly recommended design approach (Galileo, Strata, and others, 2025–2026) is **risk-tiered, not blanket, approval**: map each action type an agent can take against how hard it is to reverse (read-only query vs. sending an email vs. deleting production data vs. spending money), and require pre-action human approval only for actions landing in the high-risk/irreversible tier; use confidence-based or anomaly-based routing (HOTL) for the rest. This is reinforced by regulation: the **EU AI Act, Article 14**, effective August 2, 2026, mandates demonstrable, measurable human oversight capability for high-risk AI systems — meaning "a human could theoretically look at logs" is not sufficient; the design must support a human meaningfully stopping/reversing an action before harm occurs. ([AvePoint 2026 HITL guide](https://www.avepoint.com/blog/strategy-blog/human-in-the-loop-ai); [Galileo HITL oversight](https://galileo.ai/blog/human-in-the-loop-agent-oversight))

**Design implication for our platform**: approval should be a first-class transition in the agent state machine (`WAITING_FOR_APPROVAL`), configurable per tool/action by risk tier (see the permission-level field in the tool registry design in `10_TOOL_AND_MCP_ARCHITECTURE.md`), not a single global "ask before every tool call" toggle — the latter is what makes agentic coding tools annoying to use at HITL-everything settings and unsafe at HOTL-everything settings.

## 6. Agent State Persistence and Resumability

For any agent that runs longer than a single request/response cycle (multi-step tasks, async coding agents, long research jobs), the system must survive process restarts, timeouts, and human-approval pauses without losing progress. The documented pattern, most explicitly in LangGraph's persistence layer, is **checkpointing**:

- State is serialized and written to durable storage (LangGraph explicitly recommends Postgres/SQLite-backed checkpointers for production; an in-memory saver is dev-only) after every logical step ("super-step"), keyed by a thread/session ID.
- On resume — after a crash, an approval wait, or a deliberate pause — the runtime reloads the last checkpoint and continues from there rather than from the beginning.
- This same mechanism is documented as the basis for **time-travel debugging** (replaying/branching from an earlier checkpoint) and for **human-in-the-loop interrupts** (the graph pauses at a node, persists state, and waits for external input before continuing).
- A documented caveat: checkpointing state is *not* the same guarantee as full durable execution (à la Temporal) — side effects and non-deterministic operations that happen inside a step before a checkpoint can re-run on resume if not made idempotent, so mutating tool calls (writes, sends, payments) need idempotency keys or a pre-check ("did this already happen?") independent of the checkpoint mechanism.
([docs.langchain.com/oss/python/langgraph/persistence](https://docs.langchain.com/oss/python/langgraph/persistence); [Diagrid, "Why Checkpoints Aren't Durable Execution"](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows))

This directly informs the persistence model in `11_AGENT_LOOP.md`: every state transition in our task graph is written to durable storage before the next action is taken, tool calls that mutate external state carry idempotency keys, and resumability is a first-class requirement rather than a best-effort feature.

---

## Sources

- Yao et al., "ReAct: Synergizing Reasoning and Acting in Language Models," arXiv:2210.03629 — https://arxiv.org/abs/2210.03629
- Anthropic, "Building Effective Agents" — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, "Effective Context Engineering for AI Agents" (Sept 2025) — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Claude/Anthropic, "How we built our multi-agent research system" — https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- Chroma, "Context Rot: Evaluating LLM Performance Degradation with Increasing Input Tokens" (summary) — https://www.zenml.io/llmops-database/context-rot-evaluating-llm-performance-degradation-with-increasing-input-tokens ; https://redis.io/blog/context-rot/
- "Binding Drift in Multi-Step Tool-Augmented Agents," arXiv:2607.18316 — https://arxiv.org/html/2607.18316
- "Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures," arXiv:2608.02645 — https://arxiv.org/html/2608.02645v1
- "The Long-Horizon Task Mirage? Diagnosing Where and Why Agentic Systems Break," arXiv:2604.11978 — https://arxiv.org/html/2604.11978v1
- Openlayer, "AI Agent Failure Modes: Tool-Calling Errors, Infinite Loops & Propagation" — https://www.openlayer.com/blog/ai-agent-failure-modes-tool-calling-loops-propagation
- LangChain/LangGraph, "Persistence" docs — https://docs.langchain.com/oss/python/langgraph/persistence
- Diagrid, "Why Checkpoints Aren't Durable Execution" — https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows
- AvePoint, "Human-in-the-Loop AI: When (and Why) Machines Still Need a Person" (2026) — https://www.avepoint.com/blog/strategy-blog/human-in-the-loop-ai
- Galileo, "How to Build Human-in-the-Loop Oversight for AI Agents" — https://galileo.ai/blog/human-in-the-loop-agent-oversight
