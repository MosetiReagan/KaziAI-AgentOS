# Benchmarking

AgentOS ships an official adapter so KaziAI Bench can drive agents on this
runtime and get a measured trajectory back (spec §59). The adapter is a library
(`@kazi-ai/agentos-bench`); the `kazi-bench` CLI belongs to Bench and consumes
what the adapter exports.

## A case

```json
{
  "id": "coding.fix-auth",
  "name": "Fix the failing auth tests",
  "goal": "Make the test suite pass without changing the tests.",
  "agentId": "developer-agent",
  "tags": ["coding", "node"],
  "setup": {
    "files": [{ "path": "src/auth.js", "content": "// ...\n" }]
  },
  "expectations": {
    "files": [
      { "path": "src/auth.js", "contains": "timingSafeEqual" },
      { "path": "SECRETS.md", "absent": true }
    ],
    "verification": "required"
  }
}
```

`expectations` is the part that matters: the case is graded on the **workspace**
and on whether a verifier actually passed — never on the agent's summary of its
own work. `verification: "required"` fails a case that ends without one.

## Running it

```typescript
import { BenchAdapter, BenchRunner, parseBenchCase } from '@kazi-ai/agentos-bench';

const adapter = new BenchAdapter({ store: os.store });
const runner = new BenchRunner({
  runtime: os.runtime,
  adapter,
  buildRunInput: (benchCase) => ({
    agentId: benchCase.agentId,
    goal: benchCase.goal,
    organizationId: 'org_bench',
    projectId: 'prj_bench',
  }),
});

const exported = await runner.runCase(parseBenchCase(caseJson));
console.log(exported.caseSuccess, exported.score, exported.trajectory.steps.length);
```

`runner` creates the run, seeds the workspace, waits for a terminal state and
exports. `adapter.exportRun(runId)` produces the same export for a run that was
executed by something else — a worker, or a different process entirely.

## The export

```typescript
interface BenchRunExport {
  version: number;              // BENCH_EXPORT_VERSION; Bench rejects versions it cannot read
  caseId: string;
  runId: string;
  agentId: string;
  goal: string;
  status: string;
  success: boolean;             // the run reached COMPLETED
  caseSuccess: boolean;         // and every expectation passed
  expectations: ExpectationResult[];
  result: AgentRunResult;
  metrics: RunMetrics;
  score: ReliabilityReport;
  trajectory: RunTrajectory;
  exportedAt: number;
  labels?: Record<string, string>;
  metadata?: JsonValue;
}
```

Everything in it is read back from durable records: the trajectory, the tool
calls, the failures, the recoveries, the cost and the latency. That is what makes
an export reproducible and comparable after the fact.

## What Bench gets that it could not get elsewhere

```text
trajectory      every step, tool call and observation, in order
actions         what was attempted, what policy decided, what committed
failures        classified, not just logged
recovery        the strategy, the attempt and whether it worked
cost            tokens and dollars, per run and per step
latency         per phase
verification    what was checked and whether it passed
```

## Comparing configurations

The same case can be run against two agent definitions that differ in one
declared variable — planning on/off, memory on/off, recovery on/off — because
those are definition fields, not code changes. Group the exports by `labels` or
by `metadata.experiment` and compare; see [research.md](research.md).

## What it does not do

It does not compare models for you, decide which run was "better", or produce a
leaderboard number from a single execution. It measures runs; judgement is yours.
