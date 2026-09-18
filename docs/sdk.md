# SDK

Two entry points: `AgentOS`, which owns the deployment, and `Agent`, which owns
one definition.

## AgentOS

```typescript
import { createAgentOS } from '@kazi-ai/agentos';

const os = await createAgentOS({
  dataDir: './.kazi',              // or driver: 'postgres' + databaseUrl
  store: myStore,                  // bring your own persistence (spec §74)
  organizationId: 'org_local',
  projectId: 'prj_default',
  providersFromEnv: true,          // OPENAI_API_KEY, ANTHROPIC_API_KEY, ...
  providers: [],                   // or register them explicitly
  tools: [myCustomTool],           // overrides built-ins with the same id
  policies: myPolicyEngine,
  approvals: myApprovalManager,
  memory: myMemoryManager,
  context: myContextManager,
  environment: { kind: 'docker', workspaceRoot: '/workspaces' },
  secrets: { get: (name) => vault.read(name) },
  logger: myLogger,
  clock: myClock,                  // inject time in tests
  runtime: { maxNoProgressIterations: 3 },
});
```

Everything the runtime coordinates is replaceable without forking it (spec §74):
planner, executor, memory, context, recovery, policy, verifier, environment and
persistence are constructor arguments.

## Agent

```typescript
const agent = os.agent({
  id: 'developer',
  model: { provider: 'openai', model: 'gpt-5.6' },
  tools: ['filesystem', 'terminal', 'git'],
  permissions: { git: { push: false } },
  planner: myPlanner,              // per-agent override
  verifier: myVerifier,
});

await agent.register();
const run = await agent.createRun({
  goal: 'Fix the failing tests.',
  workspace: { copyFrom: '/path/to/repo', ignore: ['node_modules', '.git'] },
  limits: { maxCostUsd: 1 },       // may narrow the definition, never widen it
});

await agent.start(run.id);
console.log(await agent.result(run.id));
```

| Method | Purpose |
| --- | --- |
| `createRun` / `run` | create a durable run, or create and execute it |
| `start` / `pause` / `resume` / `cancel` / `retry` | lifecycle |
| `getRun` / `getState` / `getTrace` / `result` | read back what happened |
| `checkpoint` | checkpoint now |
| `fork` | new run from a checkpoint |
| `runInput` | the configuration a run *would* use, before creating it |

`agent.tools` is the shared registry, so `agent.tools.register(tool)` is the same
as registering on the OS.

## Custom tools

See [tools.md](tools.md#custom-tools-spec-73). `defineTool` validates input,
classifies errors, and carries your declared risk and idempotency into policy and
recovery.

## Custom planners, verifiers, recovery

```typescript
interface Planner {
  createPlan(context: PlanningContext): Promise<Plan>;
  revisePlan(context: PlanningContext, previous: Plan, failure: Failure): Promise<Plan>;
}

interface ProgressVerifier {
  verify(context: VerificationContext): Promise<VerificationResult>;
}
```

A deterministic planner is a first-class citizen: `DeterministicPlanner` ships in
`packages/planner` and is what the examples' tests use to make a trajectory
reproducible.

## Embedding without the CLI

```typescript
const os = await createAgentOS({ dataDir });
const result = await os.agent(definition).run({ goal: 'Summarise this repo.' });
await os.close();
```

For a long-running service, keep one `AgentOS` per process and let the worker or
the API drive runs; do not create one per request.
