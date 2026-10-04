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

# Both workspaces extend this, so without it tsc silently falls back to
# its own defaults and fails on every modern iterator in the codebase.
COPY tsconfig.base.json ./

COPY shared/ shared/
COPY server/ server/

RUN npm run build --workspace @pulse/shared \
 && npm run build --workspace @pulse/server

# Drop everything only the build needed: the dev dependencies, the
# TypeScript source that was compiled, and the configs that compiled it.
# What is left is what runs.
RUN npm prune --omit=dev --workspace @pulse/shared --workspace @pulse/server \
    --include-workspace-root \
 && rm -rf shared/src server/src tsconfig.base.json \
    shared/tsconfig*.json server/tsconfig*.json \
    shared/*.tsbuildinfo server/*.tsbuildinfo

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

# The whole tree, in one step.
#
# Copying the parts by hand needs each path to exist, and under npm
# workspaces that depends on what hoisted: shared/node_modules is absent
# entirely because everything it needs went to the root, while
# server/node_modules exists for the few packages that could not. A
# build that lists them individually fails on whichever is missing
# today and silently drops whichever appears tomorrow.
#
# It also keeps the workspace symlinks intact. node_modules/@pulse/shared
# is a link to ../../shared, which only resolves if both arrive together
# at the same relative paths.
#
# The build stage has already pruned the dev dependencies and the source,
# so this carries no more than the hand-written list did.
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/server ./server

# The port is read from the environment at run time; this is only the
# default for a plain `docker run`. A host that sets PORT gets that
# instead, and the server listens on whatever it is given.
EXPOSE 4000

CMD ["node", "server/dist/index.js"]
