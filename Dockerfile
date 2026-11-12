# Image of the trading service. Two stages: the build stage compiles TypeScript, the runtime stage holds only
# production dependencies, the compiled code and the SQL migrations. The base image is pinned by tag and digest
# (the same Node.js major as "engines" in package.json); Dependabot proposes updates.

# --- build stage -------------------------------------------------------------------------------------------
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
WORKDIR /app

# Dependencies first, so this layer stays cached while only the source changes.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime stage -----------------------------------------------------------------------------------------
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# dist/ holds the service (main.js) and the three commands run by hand inside the container:
# "npm run seed:credits", "npm run replay" and "npm run parked" (see README.md).
COPY --from=build /app/dist ./dist
# The whole tree: migrations/shared (the shared schema) and migrations/tenant (applied to every tenant schema). The
# migrator finds both next to dist/ (../../../migrations from dist/adapters/postgres).
COPY migrations ./migrations
# The gRPC server builds its service from this file at start (dist/web/grpc/debits-proto.js reads ../../../contracts):
# only the proto, never the other contracts or the copies of other services' files.
COPY contracts/trading-debit.proto ./contracts/trading-debit.proto

# The base image's unprivileged user; the Helm chart also enforces a non-root user and a read-only file system.
USER node
# 8080: the public API and the health probes (the gateway routes /v1/trading). 8081: the internal API, which only
# markets, payments and market-maker may reach (NetworkPolicy); the gateway never routes it. 8082: the gRPC debit, which
# only payments may reach (NetworkPolicy).
EXPOSE 8080 8081 8082
CMD ["node", "dist/main.js"]
