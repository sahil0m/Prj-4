# The server, for a host that runs a long-lived process.
#
# Built in two stages so the image that ships does not carry the
# TypeScript compiler, the dev dependencies or the two client
# applications. Those are served as static files from somewhere else;
# this image is the API and the socket, and nothing more.

# ---------------------------------------------------------------- build
FROM node:20-slim AS build

WORKDIR /app

# The workspace manifests first. Docker caches this layer, so editing a
# source file does not reinstall every dependency.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY join/package.json join/

# The clients are not built here, but npm needs their manifests to
# resolve the workspace tree.
RUN npm ci --workspace @pulse/shared --workspace @pulse/server --include-workspace-root

COPY shared/ shared/
COPY server/ server/

RUN npm run build --workspace @pulse/shared \
 && npm run build --workspace @pulse/server

# Drop everything only the build needed.
RUN npm prune --omit=dev --workspace @pulse/shared --workspace @pulse/server \
    --include-workspace-root

# ---------------------------------------------------------------- run
FROM node:20-slim AS run

# sharp needs libvips at runtime. The slim image does not carry it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libvips42 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Not root: a process that is compromised should not own the filesystem.
USER node

COPY --from=build --chown=node:node /app/node_modules node_modules/
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/shared/dist shared/dist/
COPY --from=build --chown=node:node /app/shared/package.json shared/
COPY --from=build --chown=node:node /app/shared/node_modules shared/node_modules/
COPY --from=build --chown=node:node /app/server/dist server/dist/
COPY --from=build --chown=node:node /app/server/package.json server/
COPY --from=build --chown=node:node /app/server/node_modules server/node_modules/

# The migrations are read at startup, so they ship with the image.
COPY --from=build --chown=node:node /app/server/drizzle server/drizzle/

EXPOSE 4000

CMD ["node", "server/dist/index.js"]
