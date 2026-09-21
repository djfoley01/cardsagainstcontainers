# syntax=docker/dockerfile:1

# Cards Against Containers, in a container. Obviously.
#
# Two stages: the first installs everything and bundles the client, the second
# keeps only what the server needs at runtime.
#
# Note there is no server build step. We run TypeScript directly under Node's
# native type stripping, so the runtime stage ships .ts sources. That is the
# same thing that runs in development, which removes a whole class of
# "works locally, breaks in the image" problems.

# ---------------------------------------------------------------- build stage
# Fully qualified so this builds under Podman too, which has no unqualified
# search registry by default. Docker and the Fly builder accept it unchanged.
FROM docker.io/library/node:26-alpine AS build
WORKDIR /app

# Copy manifests first so dependency layers cache independently of source.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY decks/ decks/
COPY scripts/ scripts/

# Fail the build rather than ship code Node cannot execute: `tsc` accepts
# parameter properties, enums and namespaces, but strip-only mode rejects them
# at import time.
RUN node --no-warnings scripts/check-strip-safe.ts
RUN npm run build --workspace @cac/client

# -------------------------------------------------------------- runtime stage
FROM docker.io/library/node:26-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Minimal init so signals are handled from the very first instant. See the
# ENTRYPOINT comment at the bottom for why this is not optional here.
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --omit=dev && npm cache clean --force

# Server and shared sources run as-is; tests and the client source do not ship.
COPY packages/shared/src/ packages/shared/src/
COPY packages/server/src/ packages/server/src/
COPY decks/*.json decks/

# The bundled client, which is all the server needs to serve the UI.
COPY --from=build /app/packages/client/dist/ packages/client/dist/

# Drop the test files that live beside the source.
RUN find packages -name '*.test.ts' -delete && rm -f packages/server/src/engine/testkit.ts

# A NUMERIC uid, not `USER node`. Kubernetes cannot resolve a username against
# the image to confirm it is non-root, so `runAsNonRoot: true` fails with
# CreateContainerConfigError against a named user.
#
# OpenShift overrides this anyway with an arbitrary high uid from the
# namespace range, gid 0, and no /etc/passwd entry. That works here without
# the usual `chgrp -R 0 && chmod -R g=u` fixup: that pattern grants group
# *write* access, which only matters for images that write inside their own
# directory. This one writes nothing at runtime — game state is in memory and
# the decks are read-only — and the default 644/755 root-owned permissions are
# already group-readable. Running the fixup anyway rewrites every file,
# including node_modules, and cost 23 MB of duplicated layer for nothing.
USER 1000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node registers SIGTERM/SIGINT handlers in index.ts, but it cannot register
# them before it has finished loading its own modules — and as PID 1 the kernel
# *discards* any signal with no handler installed. A container stopped during
# that first moment of startup therefore ignores SIGTERM completely and has to
# be SIGKILLed once the grace period expires (10s under podman, 30s under the
# Helm chart's terminationGracePeriodSeconds).
#
# tini as PID 1 closes that window: it has handlers from its first instruction,
# and forwards the signal to node, which is no longer PID 1 and so gets the
# normal default-terminate behaviour even before its own handlers are up.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/src/index.ts"]
