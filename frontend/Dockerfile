# Build context is the REPO ROOT, not this directory:
#   docker build -f frontend/Dockerfile -t ai-platform-web .
# Same monorepo reasoning as backend/Dockerfile (docs/26_DECISIONS.md ADR-037).
#
# Never actually run through `docker build` in the environment that authored this file --
# no Docker install exists there (docs/27_RISKS_AND_LIMITATIONS.md).

FROM node:24-alpine AS builder
WORKDIR /repo
COPY . .
# Optional build secret `build_ca` — see backend/Dockerfile.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && npm ci
RUN npm run build:packages
# NEXT_PUBLIC_* vars are inlined into the client bundle at BUILD time, not read at
# container start (frontend/app/lib/api.ts) -- must be supplied as a build arg pointing at
# the real deployed API URL, e.g.:
#   docker build --build-arg NEXT_PUBLIC_API_URL=https://<api-service>.run.app ...
# Left unset, it falls through to the http://localhost:8787 dev default, which is wrong for
# any real deployment -- see the deployment runbook (infrastructure/DEPLOYMENT_RUNBOOK.md).
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build --workspace=@ai-platform/web

# Next.js's `output: "standalone"` (frontend/next.config.mjs) traces the actual runtime
# import graph and produces a minimal, already-pruned server bundle plus only the
# node_modules it really needs -- unlike backend, there is no separate `npm prune` step
# here because this trace already excludes devDependencies and unused workspace packages.
FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /repo/frontend/.next/standalone ./
COPY --from=builder --chown=node:node /repo/frontend/.next/static ./frontend/.next/static
USER node
EXPOSE 3000
CMD ["node", "frontend/server.js"]
