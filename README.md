# KaziAI AgentOS

**The runtime for reliable AI agents.**

An agent is a loop. When the process running that loop dies, the work dies with it.

Everything that matters about an autonomous run lives in the memory of one process
by default — where it is, what it has already done, what it was about to do. That
holds up for a demo and falls apart for real work: a deploy that takes forty
minutes, a migration that runs overnight, a coding task spanning hundreds of tool
calls. Kill the worker and the run is gone, with no way to tell what executed, what
didn't, or what a retry would double-execute.

AgentOS takes that state out of the process. A run is durable, resumable state: a
plan, a context snapshot, an append-only journal of every action, checkpoints you
can restore, and idempotency keys so a retry never quietly executes twice. When a
worker dies mid-step, a different worker loads the run and continues from the last
committed action.

**The model decides what to do. The runtime decides what is allowed, what it costs,
and what survives a crash.**

It is not a chatbot framework, and it is not a wrapper around a model API:
providers are adapters, and the runtime is the product.

```text
                          GOAL
                            │
                            ▼
                     ┌─────────────┐
                     │  AgentOS    │
                     └──────┬──────┘
                            │
   ┌────────────────────────┼────────────────────────┐
   │            │           │           │            │
   ▼            ▼           ▼           ▼            ▼
 CONTEXT       PLAN        ACT       OBSERVE      VERIFY
               │           │
               │           ├── policy:  ALLOW / DENY / REQUIRE_APPROVAL
               │           ├── budget:  steps, tools, tokens, cost, time
               │           ├── journal: intent → execute → commit
               │           └── tools:   filesystem, terminal, git, http, mcp
               │
               ▼
            FAILURE
               │
         ┌─────▼─────┐
         │ RECOVERY  │  classify → decide → retry / replan / restore / escalate
         └─────┬─────┘
               │
         ┌─────▼─────┐
         │CHECKPOINT │  state + context + workspace snapshot
         └─────┬─────┘
               │
            RESUME
               │
            COMPLETE
```

## What the runtime enforces

Each of these is enforced by the runtime rather than by the model's cooperation:

- **Durable execution** — state, the action journal, events and checkpoints
  survive a killed worker; nothing important lives in process memory.
- **Tool control** — every action is authorized before it executes, whatever the
  plan said, and the agent's permissions are intersected into every tool call.
- **Checkpointing** — resumable points with workspace snapshots, plus restore,
  fork and replay.
- **Recovery** — failures are classified, decided on and applied explicitly:
  retry with backoff, re-plan, restore a checkpoint, switch provider, ask a human
  or terminate. Never a blind retry loop.
- **Memory and context** — scoped, TTL'd memory, and a context manager that
  budgets, compresses and never silently drops critical state.
- **Policy enforcement** — risk-classified actions, default-deny for the
  dangerous ones, and durable human approval gates.
- **Observability** — OpenTelemetry traces, an append-only event log and a
  per-run view of what actually happened.
- **Evaluation** — every run produces measured metrics a benchmark can consume.

The proof is a test, not a paragraph: `tests/e2e/crash-recovery.test.ts` starts a
run, kills the worker process partway through, starts a *different* worker against
the same durable store, and asserts the run finishes with the state the first
worker committed.

## Install and run

```bash
pnpm install
pnpm build
```

No Postgres, no Redis, no Docker required: the default store is embedded and
durable, the default queue is in-process, and the default environment is the host
process.

```bash
# a genuinely failing test suite, fixed and verified — offline, no API key
pnpm tsx examples/software-engineering/run.ts
```

```text
KaziAI AgentOS

Run:           run_01M2TG3H2EERE4MAP96J6Y3EXF
Agent:         developer-replay
Model:         deterministic replay

Goal:
Fix the failing tests in this repository and prove the suite passes.

[01] Planning
[02] filesystem.read
[03] terminal.exec
[04] filesystem.edit
[05] terminal.exec
[06] Verification
[07] Recovery (tool_failure on terminal.exec)
[08] Checkpoint #1
[09] Checkpoint #2
[10] Checkpoint #3
[11] Checkpoint #4
[12] Checkpoint #5
[13] Checkpoint #6

Verification:
✓ All 2 verifier(s) passed

Result:
COMPLETED

Steps:         5
Tool calls:    4
Recovery:      1
Duration:      961ms
Cost:          $0.000
```

That output is produced by the real runtime. The suite is red before the run and
green after it, in the run's own workspace, checked by the repository's own test
command — the end-to-end test asserts all of it.

With a model:

```bash
export OPENAI_API_KEY=sk-...
kazi-agent run developer-agent --goal "Fix the failing tests in this repository."
kazi-agent inspect run_01M2...
```

## Three examples, three hard problems

| Example | What it proves |
| --- | --- |
| [`examples/software-engineering`](examples/software-engineering) | The agent really fixes the code, and the runtime's verifier — not the agent's summary — proves it |
| [`examples/recovery`](examples/recovery) | A real database lock, a real retry of the same action, and a run that fails loudly when the outage outlasts recovery |
| [`examples/approvals`](examples/approvals) | A granted permission that still cannot push, because policy sends it to a human |

## The CLI

```bash
kazi-agent init                     # agentos.yaml + agents/developer.yaml
kazi-agent agents                   # what this project can run
kazi-agent run <agent> --goal "..." # execute a goal
kazi-agent runs | inspect <run> | logs <run> --follow
kazi-agent pause | resume | cancel | retry <run>
kazi-agent checkpoint <run> | fork <run> --checkpoint <id> | replay <run>
kazi-agent approvals | approve <id> | deny <id>
kazi-agent tools | policies | policies --tool git --args '{"operation":"push"}'
kazi-agent doctor                   # what is reachable, and what to do about it
```

## The SDK

```typescript
import { createAgentOS } from '@kazi-ai/agentos';

const os = await createAgentOS({ dataDir: './.kazi' });
const agent = os.agent({
  id: 'developer',
  model: { provider: 'openai', model: 'gpt-5.6' },
  tools: ['filesystem', 'terminal', 'git'],
  permissions: { git: { push: false } },
});

const run = await agent.createRun({ goal: 'Fix the failing tests.', workspace: { copyFrom: '.' } });
await agent.start(run.id);
console.log(await agent.result(run.id));   // measured, not self-reported
await os.close();
```

Planners, executors, memory, context, recovery, policy, verifiers, environments
and persistence are all replaceable constructor arguments — not forks
([sdk.md](docs/sdk.md)).

## Architecture

```text
                    ┌─────────────────────┐
                    │      AgentOS API    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Runtime Engine    │
                    └──────────┬──────────┘
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
       ┌─────▼─────┐     ┌────▼────┐      ┌─────▼─────┐
       │  Planner  │     │ Context │      │  Policy   │
       └─────┬─────┘     └────┬────┘      └─────┬─────┘
             │                │                  │
             └────────────────┼──────────────────┘
                              │
                       ┌──────▼──────┐
                       │   Executor  │
                       └──────┬──────┘
                              │
                 ┌────────────┼────────────┐
                 │            │            │
              Tools         MCP        Providers
                 │
          ┌──────▼──────┐
          │ Environment │
          └──────┬──────┘
                 │
       ┌─────────▼──────────┐
       │ Checkpoint / State │
       └─────────┬──────────┘
                 │
          ┌──────▼──────┐
          │  Recovery   │
          └─────────────┘
```

Packages: `core`, `runtime`, `agent`, `planner`, `executor`, `tools`, `memory`,
`context`, `policies`, `checkpoints`, `recovery`, `tracing`, `providers`, `mcp`,
`evaluation`, `bench`, `persistence`, `sdk`, `cli`. Apps: `api`, `worker`,
`dashboard`, `gateway`. See [docs/architecture.md](docs/architecture.md).

## Deployment

```bash
cd docker && cp .env.example .env && docker compose up -d
```

API, worker, dashboard, gateway, Postgres and Redis, with health-gated startup
ordering. Kubernetes manifests are in `k8s/`. Nothing is required to *try* the
runtime — the embedded store is the default, and it is durable.

## Documentation

| | |
| --- | --- |
| [getting-started](docs/getting-started.md) | install, first agent, where state lives |
| [architecture](docs/architecture.md) | packages, boundaries, the flow of a run |
| [runtime](docs/runtime.md) | the execution loop, phase by phase |
| [agent-definition](docs/agent-definition.md) | every field, and what it changes |
| [tools](docs/tools.md) | built-in tools, permissions, custom tools |
| [policies](docs/policies.md) | risk, decisions, approvals, budgets |
| [security](docs/security.md) | trust boundaries, isolation, what is *not* claimed |
| [memory](docs/memory.md) | scoped, TTL'd, pluggable |
| [context](docs/context.md) | budgeting, compression, snapshots |
| [checkpointing](docs/checkpointing.md) | when, what, and how to restore or fork |
| [recovery](docs/recovery.md) | classification, strategies, retries, circuit breakers |
| [durable-execution](docs/durable-execution.md) | queues, exactly-once honesty, crash recovery |
| [providers](docs/providers.md) | adapters, normalisation, failover |
| [mcp](docs/mcp.md) | remote tools as first-class tools |
| [sdk](docs/sdk.md) | embedding, custom tools, replacing components |
| [api](docs/api.md) | REST, SSE, OpenAPI, errors, tenancy |
| [evaluation](docs/evaluation.md) | metrics, scoring, trajectories, experiments |
| [benchmarking](docs/benchmarking.md) | the KaziAI Bench adapter |
| [research](docs/research.md) | ablation runs and what to record |
| [contributing](docs/contributing.md) | layout, tests, standards |
| [deployment](docs/deployment.md) | compose, Kubernetes, configuration |

## Tests

```bash
pnpm lint
pnpm typecheck
pnpm test              # unit
pnpm test:integration
pnpm test:e2e
pnpm test:security
pnpm test:chaos
pnpm build
```

The suite that matters most:

- `tests/e2e/crash-recovery.test.ts` — start a run, `SIGKILL` the worker
  mid-execution, watch another worker finish it correctly (spec §114)
- `tests/security/sandbox.test.ts` — workspace escapes, `/etc/passwd`, SSRF to
  `169.254.169.254`, permission bypass, secret leakage (spec §115)
- `tests/chaos/` — injected tool, provider and store faults, then a consistency
  check that demands a clean outcome and no duplicate side effects (spec §88)
- `examples/*` — every documented command is executed by a test

## Status

Implemented and tested: the runtime loop and state machine, the tool runtime and
its built-in tools, policy and approvals, budgets, the action journal,
checkpointing and crash recovery, recovery and retries, memory and context, MCP,
providers and failover, the API, the CLI, the dashboard, evaluation, the Bench
adapter, the security and chaos suites, Docker and Kubernetes manifests.

Known limits, stated plainly:

- The default environment confines commands but does not isolate them. Point the
  runtime at the Docker environment for untrusted code.
- The queue is one run queue with three drivers (`inline`, `store`, `bullmq`).
  The finer-grained queues sketched in the spec are a scaling change behind the
  same interface, not a durability gap.
- The embedded store is durable and crash-safe but single-writer; use Postgres
  for a multi-worker deployment.
- The Prisma/Postgres store implements the same `AgentOSStore` contract as the
  embedded one, but nothing in this repository runs it against a live Postgres:
  CI validates the image and the compose configuration instead. Treat the
  embedded store as the tested default and Postgres as the deployment target.

## License

Apache-2.0.
