# Getting started

KaziAI AgentOS is a runtime: you give it a goal, it gives an agent controlled
access to tools and context, and it produces a durable, auditable execution
trace. Nothing here needs a database server or a container runtime to try.

## Requirements

- Node.js 20 or newer (24 is what CI uses)
- pnpm 10
- Optional: Docker (isolation), PostgreSQL + Redis (the server deployment)

## From a checkout

```bash
pnpm install
pnpm build            # or: pnpm typecheck, for types only
./node_modules/.bin/tsx packages/cli/src/bin.ts doctor
```

`doctor` checks Node, Docker, the API, workers, providers, MCP, the workspace
directory, permissions and configuration, and tells you what to do about
whatever it finds.

## Run the examples first

Both examples run offline, with no API key, because the decisions come from the
deterministic provider (spec §87) while everything else — the runtime, the tools,
the sandbox, the verification — is real.

```bash
# Fix a genuinely failing test suite, then prove the suite passes
pnpm tsx examples/software-engineering/run.ts

# Recover from a database that is really locked by a real second connection
pnpm tsx examples/recovery/run.ts

# Stop at a human approval gate before an irreversible push
pnpm tsx examples/approvals/run.ts
```

Each of those prints the run's timeline, its result and the evidence behind it;
their READMEs explain what to look at.

## Your first agent

```bash
./node_modules/.bin/tsx packages/cli/src/bin.ts init
export OPENAI_API_KEY=sk-...
./node_modules/.bin/tsx packages/cli/src/bin.ts run developer --goal "Fix the failing tests in this repository."
```

`init` writes `agentos.yaml` and `agents/developer.yaml`. The definition is the
whole contract: tools, limits, verification and permissions. Edit it rather than
passing flags for things that should be policy.

The repository also ships four reference agents in `agents/`, which the CLI finds
automatically:

```bash
kazi-agent agents
kazi-agent run developer-agent --goal "Fix the failing tests in this repository."
```

## Run your first agent from code

```ts
import { createAgentOS } from '@kazi-ai/agentos';

const os = await createAgentOS({ dataDir: './.kazi' });
const agent = os.agent({
  id: 'developer',
  model: { provider: 'openai', model: 'gpt-5.6' },
  tools: ['filesystem', 'terminal', 'git'],
  permissions: {
    filesystem: { read: true, write: true, delete: false },
    terminal: { execute: true, allowUnisolated: true },
    git: { read: true, commit: true, push: false },
  },
});

const run = await agent.createRun({ goal: 'Fix the failing tests.', workspace: { copyFrom: '.' } });
await agent.start(run.id);
console.log(await agent.result(run.id));
await os.close();
```

`permissions.terminal.allowUnisolated` is not a formality: the default
environment runs commands as your user, which is a confinement rather than an
isolation boundary, and a tool that needs a real sandbox is refused there unless
the run says out loud that it accepts that (spec §15).

## Where state lives

Everything durable lives under `dataDir` (`.kazi` by default):

```text
.kazi/
  logs/agentos-events.jsonl      append-only event log
  actions/*.jsonl                the action journal
  workspaces/<org>/<run>/        the run's own workspace
  snapshots/<run>/               environment snapshots
  runs/, checkpoints/, ...
```

The store is an embedded, durable JSONL store by default: no external services,
but still a real store that survives a process dying — which is what the crash
test in `tests/e2e/crash-recovery.test.ts` demonstrates.

## Next

- [architecture.md](architecture.md) — what the pieces are and how a run flows
- [runtime.md](runtime.md) — the execution loop, phase by phase
- [agent-definition.md](agent-definition.md) — every field in a definition
- [tools.md](tools.md) — the built-in tools and their permissions
- [policies.md](policies.md) — what the runtime refuses, and why
- [deployment.md](deployment.md) — running the server stack
