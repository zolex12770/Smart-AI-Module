# Project Structure

Concrete layout implementing the decisions in [[26_DECISIONS]] (npm workspaces monorepo, TypeScript everywhere). This is the structure Phase 1 scaffolding creates — see [[25_IMPLEMENTATION_ROADMAP]].

```
/
├── apps/
│   ├── web/                 # Next.js frontend (chat, agent UI, image/video UI, admin)
│   ├── api/                 # Fastify HTTP API (/api/v1/*), owns auth, SSE streaming
│   └── worker/               # Background job processor (media generation, long-form video pipeline)
│
├── packages/
│   ├── agent-core/          # Agent loop, state machine, task graph (docs 11)
│   ├── model-router/         # ModelRegistry, ModelRouter, CapabilityRegistry, fallback logic (docs 12)
│   ├── providers/            # One adapter per provider + mocks
│   │   ├── llm-anthropic/
│   │   ├── llm-openai/
│   │   ├── llm-google/
│   │   ├── llm-mock/
│   │   ├── image-mock/       # real image adapters added here once credentials exist (ADR-009)
│   │   └── video-mock/       # real video adapters added here once credentials exist (ADR-009)
│   ├── tools/                 # Tool registry + built-in tools (filesystem, terminal, git, web, mcp-bridge)
│   ├── mcp/                   # MCP client: discovery, config, invocation, permission gating (docs 10)
│   ├── memory/                 # Conversation/user/project/task memory + summarization (docs 08)
│   ├── rag/                    # Document parsing, chunking, embeddings, retrieval, reranking (docs 09)
│   ├── jobs/                   # Job/Queue/Worker abstractions, retry/backoff/idempotency (docs 07)
│   ├── media/                   # Image/video pipeline orchestration, long-form video scene manifest (docs 06, 07)
│   ├── database/                 # Drizzle schema, migrations, repository interfaces (SQLite + Postgres impls)
│   ├── security/                  # AuthProvider, RBAC, permission checks, prompt-injection guards (docs 13)
│   ├── observability/               # Structured logging, metrics, tracing helpers (docs 20)
│   └── shared/                       # Cross-cutting types/schemas (TaskRequest, ToolResult, AgentMessage, etc. — docs 54)
│
├── docs/                       # This documentation set
│   └── research/                # Raw research notes backing the numbered docs
│
├── infrastructure/              # Dockerfiles, IaC (not applied — see ADR-011), docker-compose for optional local Postgres/Redis
├── scripts/                      # Setup/dev/seed scripts
├── tests/                         # Cross-package e2e tests (Playwright); unit/integration tests live beside their package
├── PROJECT_STATUS.md
├── README.md
├── package.json                    # npm workspaces root
└── tsconfig.base.json
```

## Dependency direction (enforced by convention, checked by lint rule once ESLint boundaries are configured)

```
apps/web       → apps/api (HTTP/SSE only, no direct package imports of business logic)
apps/api       → agent-core, model-router, tools, mcp, memory, rag, jobs, media, database, security, observability, shared
apps/worker    → jobs, media, providers, database, observability, shared
agent-core     → model-router, tools, memory, shared          (no direct provider imports)
model-router   → providers/*, shared                          (only place that knows provider SDK shapes)
tools, mcp     → shared                                        (no direct database imports — receive context via injection)
memory, rag    → database, model-router (for embeddings), shared
media          → providers/image-*, providers/video-*, jobs, database, shared
```

Rule of thumb enforced from ADR-010/ADR-009: **no package outside `packages/providers/*` imports a provider SDK directly.** Everything else talks to `model-router` / `media`'s provider-agnostic interfaces. This is what NFR-011 in [[01_REQUIREMENTS]] checks for.

## Why apps are separate from packages

`apps/*` are deployable units (each gets its own Dockerfile under `infrastructure/`); `packages/*` are libraries with no deployment identity of their own. This maps directly onto the Cloud Run service boundaries in [[18_CLOUD_ARCHITECTURE]] once that phase is reached.
