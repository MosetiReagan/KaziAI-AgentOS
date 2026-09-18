# syntax=docker/dockerfile:1.7
#
# Build the console, then hand the static bundle to nginx. Build from the
# repository root:
#
#   docker build -f docker/dashboard.Dockerfile .

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PNPM_STORE_DIR=/pnpm/store PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @kazi-ai/agentos-dashboard run build

FROM nginx:1.27-alpine AS runtime
COPY docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
