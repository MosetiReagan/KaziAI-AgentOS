# syntax=docker/dockerfile:1.7
#
# One build stage, three run targets. The API, the worker and the gateway share
# the same compiled workspace, so they differ only in the command they run.
# Build from the repository root:
#
#   docker build -f docker/node.Dockerfile --target api .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PNPM_STORE_DIR=/pnpm/store \
    PATH=/pnpm:$PATH \
    NODE_OPTIONS=--enable-source-maps
# git and curl are not there for the runtime's own sake: the agent's filesystem,
# terminal and git tools are how it does real work inside the container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl bash \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Generate the Prisma client before compiling: the Postgres store type-checks
# against it, and operators should not need a second build step to deploy.
RUN pnpm --filter @kazi-ai/agentos-persistence prisma:generate
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production \
    KZ_DATA_DIR=/var/lib/kazi \
    KZ_AGENT_DIRS=/app/agents
COPY --from=build /app /app
RUN mkdir -p /var/lib/kazi /var/lib/kazi/workspaces \
 && chown -R node:node /var/lib/kazi
USER node
VOLUME ["/var/lib/kazi"]

FROM runtime AS api
ENV KZ_API_HOST=0.0.0.0 KZ_API_PORT=4000 KZ_QUEUE=store KZ_STORAGE_DRIVER=postgres
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KZ_API_PORT||4000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/bin.js"]

FROM runtime AS worker
ENV KZ_WORKER_HOST=0.0.0.0 KZ_WORKER_PORT=4100 KZ_QUEUE=bullmq KZ_STORAGE_DRIVER=postgres
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KZ_WORKER_PORT||4100)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/worker/dist/bin.js"]

FROM runtime AS gateway
ENV KZ_GATEWAY_HOST=0.0.0.0 KZ_GATEWAY_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KZ_GATEWAY_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/gateway/dist/bin.js"]
