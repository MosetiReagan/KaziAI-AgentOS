# Architecture

## Packages

```text
kazi-ai-agentos/
├── apps/
│   ├── api/          Fastify control plane: REST, SSE, OpenAPI
│   ├── dashboard/    React/Vite console: runs, traces, approvals, memory
│   ├── worker/       queue consumer: runs agents outside the request path
│   └── gateway/      reverse proxy and health aggregation
├── packages/
│   ├── core/         contracts, state machine, budgets, errors, redaction
│   ├── runtime/      the execution loop, session, transitions, replay
│   ├── agent/        declarative definitions and parsing
│   ├── planner/      LLM and deterministic planners
│   ├── executor/     policy → approval → journal → tool execution, and the DAG
│   ├── tools/        built-in tools, registries, environments, path guard
│   ├── memory/       pluggable memory stores and scopes
│   ├── context/      context assembly, budgeting and summarisation
│   ├── policies/     policy engine, risk classification, approvals
│   ├── checkpoints/  checkpoint policy, serialization, workspace snapshots
│   ├── recovery/     failure classification, retry, recovery decisions
│   ├── tracing/      OpenTelemetry spans and trace building
│   ├── providers/    model providers behind one interface
│   ├── mcp/          MCP client, transports, tool normalisation
│   ├── evaluation/   metrics, scoring, trajectories, experiments
│   ├── bench/        the KaziAI Bench adapter
│   ├── persistence/  embedded JSONL store and the Prisma store
│   ├── sdk/          AgentOS and Agent: the product surface
│   └── cli/          `kazi-agent`
├── agents/           reference agent definitions
├── examples/         runnable end-to-end examples
├── tests/            integration, end-to-end, security and chaos suites
├── docker/           compose stack and Dockerfiles
└── k8s/              manifests
```

Boundaries are enforced by dependency direction, not by a build tool:
`core` knows nothing about providers, `runtime` coordinates and does not
implement tools, `providers` and `tools` are plugins. Nothing in this runtime
depends on LangChain, LangGraph, CrewAI or AutoGen (spec §101).

## How a run flows

```text
GOAL
  ↓
CONTEXT      what the model is shown, and why
  ↓
PLAN         advisory: a plan never authorizes anything
  ↓
ACT          policy → approval → budget → journal → execute
  ↓
OBSERVE      results become observations, not instructions
  ↓
VERIFY       the runtime runs the checks, not the agent
  ↓
RECOVER      classify, decide, apply; or fail loudly
  ↓
CONTINUE     checkpoint, update state, go round again
  ↓
COMPLETE
```

## The system

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

## What is durable, and what is not

| Thing | Where it lives | Survives a crash |
| --- | --- | --- |
| Run state and status | store (`runs`) | yes |
| Every action attempt | append-only action journal | yes |
| Every event | append-only event log | yes |
| Checkpoints and snapshots | store + snapshot files | yes |
| Approvals and decisions | store | yes |
| Memory entries | memory store | yes |
| Workspace | `dataDir/workspaces/<org>/<run>` | yes |
| Worker memory | process | no, by design |

A worker holds nothing a second worker needs. `AgentRuntime.start(runId)` loads
what it needs from the store, which is why the crash test can `SIGKILL` a worker
and have another one finish the run.

## Where to look in the code

- The loop: `packages/runtime/src/loop.ts`, one method per phase
- State transitions: `packages/core/src/state-machine.ts`
- Action authorization and execution: `packages/executor/src/executor.ts`
- Policy and risk: `packages/policies/src/engine.ts`, `risk.ts`
- Recovery: `packages/recovery/src/engine.ts`, `classify.ts`
- Durability: `packages/persistence/src/store.ts`
