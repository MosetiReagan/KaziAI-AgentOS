# Deployment

## Docker Compose (spec §106)

```bash
cd docker
cp .env.example .env
docker compose up -d
docker compose ps
curl localhost:4000/health
```

The stack is:

| Service | What it is |
| --- | --- |
| `postgres` | durable state (Prisma) |
| `redis` | BullMQ queue |
| `migrate` | one-shot schema step; everything waits for it to *complete* |
| `api` | the Fastify control plane |
| `worker` | runs agents outside the request path |
| `dashboard` | the console |
| `gateway` | reverse proxy and aggregated health |

Every service declares a health check and the compose file uses
`depends_on: condition: service_healthy`, so startup order is enforced rather
than hoped for. Postgres and Redis keep their data in named volumes; the API and
worker share one data volume so a run created by the API can be executed by the
worker against the same workspace.

The images are `docker/node.Dockerfile` (API and worker, from a shared build
stage) and `docker/dashboard.Dockerfile` (static dashboard behind nginx). CI
builds both; it does not run the stack, because the test suite covers the
behaviour the stack composes.

## Configuration

Precedence, highest first:

```text
CLI flags  >  environment  >  project config (agentos.yaml)  >  user config  >  defaults
```

The useful environment variables:

```text
KZ_STORAGE_DRIVER=postgres        DATABASE_URL=postgres://...
KZ_QUEUE_DRIVER=bullmq            REDIS_URL=redis://redis:6379
KZ_QUEUE=bullmq                   # where the API dispatches runs: inline|store|bullmq
KZ_ENVIRONMENT=docker             # isolate each run in a container
KZ_DOCKER_IMAGE=kazi-agentos/run:0.1.0
KZ_WORKSPACE_ROOT=/workspaces
KZ_API_HOST=0.0.0.0               KZ_API_PORT=4000   # the config default is 4319
KZ_API_KEY=...                    # required as soon as the port is exposed
KZ_CORS_ORIGINS=https://console.example.com
KZ_MAX_CONCURRENT_RUNS=8          KZ_MAX_RUNS_PER_ORG=32
KZ_TELEMETRY_ENABLED=true         KZ_OTLP_ENDPOINT=http://otel:4318
KZ_AGENT_DIRS=/app/agents
```

Secrets are references, never values in a config file: model keys come from
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or a secret provider
you wire in), and tool secrets are `secret://` references resolved at the edge.

### Isolation

The compose stack runs the worker with the Docker environment available so each
run gets a container of its own; that requires mounting the Docker socket into
the worker, which is a real privilege. If you are not ready for that, leave
`KZ_ENVIRONMENT=local`: commands then run as the worker's user on the worker's
host, under process confinement and with `terminal.allowUnisolated` required per
run. Do not point that at untrusted code.

## Kubernetes

`k8s/` contains a kustomize base: namespace, config map, Postgres, Redis, API,
worker, dashboard, gateway, ingress, a migration job and a PVC. It is deliberately
minimal (spec §107):

```bash
kubectl apply -k k8s/
kubectl -n kazi rollout status deploy/kazi-api
```

Things to change before production: Postgres and Redis are single instances, the
secret is an example file (`k8s/secret.example.yaml`), and the ingress assumes a
cluster with an ingress controller and a certificate issuer. Scale the worker
with replicas — it is stateless, and the queue plus the durable store make
horizontal scaling safe.

## Health and readiness

```text
GET /health    process is up
GET /ready     store reachable, providers registered, configuration valid
```

Point liveness at `/health` (a restart fixes a stuck process) and readiness at
`/ready` (a restart does not fix a misconfigured one).

## Operating it

```bash
kazi-agent doctor                      # what is reachable, and what to do about the rest
kazi-agent runs --status FAILED        # what has gone wrong
kazi-agent inspect run_123             # state, trace, timeline
kazi-agent approvals                   # what is waiting on a human
kazi-agent resume run_123              # continue a paused or orphaned run
```

Workers shut down gracefully: they stop accepting work, finish safe operations,
checkpoint active runs, release claims and locks, and exit. A `SIGTERM` during a
deploy is not a lost run.
