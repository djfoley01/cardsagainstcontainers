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

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node registers its own SIGTERM/SIGINT handlers in index.ts, so it can be PID 1.
CMD ["node", "packages/server/src/index.ts"]
