# Build context is the REPO ROOT, not this directory:
#   docker build -f backend/Dockerfile -t ai-platform-api .
# An npm workspaces monorepo needs the whole tree present for `npm ci` to resolve the
# internal @ai-platform/* package symlinks (docs/26_DECISIONS.md ADR-037) -- there is no
# npm registry to install them from.
#
# Never actually run through `docker build` in the environment that authored this file --
# no Docker install exists there (docs/27_RISKS_AND_LIMITATIONS.md). The CI `infrastructure`
# job builds it and boots it in the worker role, which is where this file is really tested.
#
# Debian slim rather than Alpine (ADR-124). The image ships piper, whose released Linux
# binary is linked against glibc; on musl it does not run at all, and gcompat shims it only
# far enough to fail later and less clearly. Builder and runtime share the base deliberately,
# so anything compiled during `npm ci` is loaded by the same libc that built it.

FROM node:24-bookworm-slim AS builder
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

FROM node:24-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# The media binaries the platform actually shells out to (ADR-124).
#
# Without ffmpeg every video render settles `skipped_no_ffmpeg` and every deployment of this
# image reports the long-form pipeline as unavailable -- a capability the product documents,
# that no container could ever perform. Without piper there is no speech provider that runs
# on a server at all: the other offline one is Windows-only (ADR-114).
#
# `--no-install-recommends` keeps the ffmpeg dependency closure to the codecs; the render
# pipeline needs libx264 and the mp4 muxer, both of which are in the Debian ffmpeg build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Piper and one voice, pinned. The archive extracts a `piper/` directory containing the
# binary and the shared objects it loads; the provider puts that directory on
# LD_LIBRARY_PATH itself (backend/packages/media/src/speech-piper.ts), so the layout is
# left exactly as shipped. The .onnx.json sidecar carries the sample rate and phoneme map --
# the voice will not load without it, and the failure reads like a broken binary.
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_VOICE_NAME=en_US-lessac-medium
RUN curl -sSfL -o /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
 && mkdir -p /opt && tar -xzf /tmp/piper.tar.gz -C /opt && rm /tmp/piper.tar.gz \
 && mkdir -p /opt/piper-voices \
 && curl -sSfL -o "/opt/piper-voices/${PIPER_VOICE_NAME}.onnx" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/${PIPER_VOICE_NAME}.onnx" \
 && curl -sSfL -o "/opt/piper-voices/${PIPER_VOICE_NAME}.onnx.json" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/${PIPER_VOICE_NAME}.onnx.json" \
 && apt-get purge -y curl && apt-get autoremove -y

# Named here rather than left to the operator: in THIS image the binary and the voice are
# guaranteed to exist at these paths, so requiring someone to discover them would be a
# capability switched off for no reason. A deployment that wants a hosted voice still sets
# SPEECH_PROVIDER=openai and these are ignored.
ENV FFMPEG_PATH=/usr/bin/ffmpeg \
    SPEECH_PROVIDER=piper \
    PIPER_PATH=/opt/piper/piper \
    PIPER_VOICE=/opt/piper-voices/en_US-lessac-medium.onnx

# Cloud Run injects PORT (typically 8080); backend/src/config.ts already reads
# process.env.PORT via its zod schema, so no code change was needed for this.
COPY --from=builder --chown=node:node /repo /repo
USER node
EXPOSE 8080
CMD ["node", "backend/dist/index.js"]
