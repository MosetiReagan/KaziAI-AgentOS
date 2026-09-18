# Evaluation

Every run produces a measured result (spec §58, §89):

```typescript
interface AgentRunResult {
  runId: string;
  status: RunStatus;
  success: boolean;
  durationMs: number;
  steps: number;
  toolCalls: number;
  tokenUsage: TokenUsage;
  costUsd?: number;
  recoveryCount: number;
  policyViolations: number;
  artifacts: Artifact[];
  traceId: string;
}
```

Read it back with `agent.result(runId)`, `GET /api/runs/:id/result`, or
`kazi-agent inspect <run>`; it is assembled from durable records, so it can be
produced by a different process than the one that ran the agent.

## Metrics

`MetricsCollector` derives the per-run measures the specification asks for:

```text
task success            steps                tool calls
failed tool calls       recovery count       recovery success rate
duration                tokens               cost
policy violations       human approvals      checkpoints
terminal failures       artifacts
```

They are exposed individually. A single number hides the difference between a
run that succeeded slowly and one that failed fast for the right reason.

## Scoring, if you want it

```typescript
const report = scoreRun(metrics, {
  reliability: { weight: 0.4, target: 1 },
  efficiency:  { weight: 0.2, target: 20 },   // steps
  safety:      { weight: 0.2, target: 0 },    // violations
  recovery:    { weight: 0.2, target: 1 },
});
```

Weights and targets are configuration, not constants, and every component reports
the inputs it used and an explanation. A score that cannot be explained is not
usable for a decision (spec §90).

## Trajectories

`buildTrajectory(runId)` turns a run into an ordered sequence of steps, tool
calls, observations, recoveries, checkpoints and approvals — enough to compare
two runs, or two configurations on one task, without reading logs.

## Experiments

```yaml
experiment:
  name: no-memory
  variables:
    memory: false
    planning: true
    recovery: true
```

The metadata lands on the run, so `aggregateMetrics` can group runs by variant
and compare the outcome. Running the same case with one variable changed is the
point (spec §91, §92).

## Where evaluation stops

The runtime measures what it can observe: steps, calls, failures, recoveries,
cost, and whether verification passed. It does not judge whether the work was
*good*, and it does not accept the agent's summary as a result — `verification`
in the result comes from a verifier that ran, not from a claim.
