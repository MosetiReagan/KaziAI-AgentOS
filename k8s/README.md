# Kubernetes

The same images Docker Compose builds, wired for a cluster. Nothing here is
generated or Helm-templated on purpose: you can read every object.

```bash
# 1. Build and push the two images.
docker build -f docker/node.Dockerfile      -t registry.example.com/kazi-ai-agentos:latest           .
docker build -f docker/dashboard.Dockerfile -t registry.example.com/kazi-ai-agentos-dashboard:latest .

# 2. Fill in the secrets and apply the stack.
cp k8s/secret.example.yaml k8s/secret.yaml   # edit every REPLACE_ME
kubectl apply -k k8s
```

Then point `k8s/ingress.yaml` at your hostname, or port-forward the gateway:

```bash
kubectl -n kazi-agentos port-forward svc/gateway 8080:80
```

## Ordering and probes

- `migrate-job` applies the Prisma schema. The API and the worker need it, so
  run it (and wait for completion) before scaling them up. With `kubectl apply
  -k` they all start together — the API's `startupProbe` keeps it out of service
  until Postgres answers, and readiness is reported by `/ready`, which queries
  the store.
- The worker's `/ready` returns 503 while it is draining, so a rollout takes the
  pod out of the queue before its termination grace period ends.
- `terminationGracePeriodSeconds` is 120s on the worker: a run is paused and
  checkpointed rather than abandoned (spec §84).

## Notes

- `kazi-agentos-data` must be `ReadWriteMany` because the API creates the run's
  workspace and the worker executes in it. On a single node, switch to `standard`.
- Isolation is `local` by default: commands are confined to the container, not
  sandboxed from it. Running `KZ_ENVIRONMENT=docker` inside a pod needs a
  container runtime mounted into the worker and is not recommended; put untrusted
  work on a separate, dedicated node pool instead. See `docs/deployment.md`.
- Scale the API and the gateway with replicas; scale the worker with replicas or
  by raising `KZ_WORKER_CONCURRENCY`.
