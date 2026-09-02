# Build context is the REPO ROOT, not this directory:
#   docker build -f apps/api/Dockerfile -t ai-platform-api .
# An npm workspaces monorepo needs the whole tree present for `npm ci` to resolve the
# internal @ai-platform/* package symlinks (docs/26_DECISIONS.md ADR-037) -- there is no
# npm registry to install them from.
#
# Never actually run through `docker build` in the environment that authored this file --
# no Docker install exists there (docs/27_RISKS_AND_LIMITATIONS.md). Written to match the
# already-verified local build sequence (`npm ci && npm run build:packages && npm run build
# --workspace=@ai-platform/api`) exactly, and reviewed line by line, but that is not the
# same as a real `docker build` having actually run.

FROM node:24-alpine AS builder
WORKDIR /repo

# One npm ci over the whole source tree, not a dependency-only layer copied ahead of the
# rest -- an npm workspaces monorepo's lockfile already covers every package, and listing
# each package.json individually here would silently go stale the next time a package is
# added. Simpler and more robust over Docker's own layer-caching benefit, a deliberate
# trade-off given this Dockerfile has never been run even once to measure whether that
# caching would matter in practice.
COPY . .
RUN npm ci
RUN npm run build:packages
RUN npm run build --workspace=@ai-platform/api
# Strips devDependencies (typescript, vitest, tsx, drizzle-kit, ...) from every workspace's
# node_modules while preserving the production deps @ai-platform/api's dist/index.js
# actually imports at runtime -- including @modelcontextprotocol/server-filesystem, moved
# to a real `dependencies` entry (not `devDependencies`) specifically because index.ts
# spawns it as a real subprocess in production code, not just in tests (found while writing
# this Dockerfile -- see docs/26_DECISIONS.md ADR-037).
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
# Cloud Run injects PORT (typically 8080); apps/api/src/config.ts already reads
# process.env.PORT via its zod schema, so no code change was needed for this.
COPY --from=builder --chown=node:node /repo /repo
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]
