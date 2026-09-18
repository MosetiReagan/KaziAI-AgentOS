# Research mode

Agent reliability questions are empirical: does planning help, does memory help,
does recovery pay for itself? Answering them needs runs that differ in *one*
declared variable, and records rich enough to compare afterwards (spec §91, §92).

## Metadata instead of guesswork

An agent definition can carry an experiment label:

```yaml
experiment:
  name: no-memory
  variables:
    memory: false
    planning: true
    recovery: true
```

and the deployment can turn on extra capture:

```yaml
research:
  enabled: true
  experimentName: no-memory
  variables: { memory: false }
```

```bash
KZ_RESEARCH_ENABLED=true kazi-agent run developer-agent --goal "..."
```

The label lands on the run, so metrics can be grouped by variant without
cross-referencing a lab notebook.

## Experiments as a first-class object

```typescript
import { parseExperiment, runExperiment } from '@kazi-ai/agentos-evaluation';

const experiment = parseExperiment({
  name: 'memory-ablation',
  goal: 'Fix the failing tests in this repository.',
  agentId: 'developer-agent',
  repetitions: 3,
  variants: [
    { name: 'memory-on',  variables: { memory: true } },
    { name: 'memory-off', variables: { memory: false } },
  ],
});

const report = await runExperiment({ experiment, executor });
report.variants;     // per-variant aggregate metrics
report.comparisons;  // per-variant deltas against the first variant, the baseline
report.runs;         // every individual run behind those aggregates
```

`repetitions` exists because a single run is an anecdote. The executor runs one
variant and returns its measured result; the experiment never invents a run, and
never reports a comparison it did not measure.

## What to record

The runtime already captures the variables that matter:

```text
planner version and whether planning ran
context strategy and what was compressed
memory strategy: what was recalled, what was written
recovery strategy per failure, and whether it applied
tool selection: which tools were offered, which were called
model switches, with the reason and the trace event
checkpoint frequency
policy decisions and approvals
```

## What research mode is not

It is not a hidden chain-of-thought capture (spec §40). The runtime stores
structured, operational metadata — status, observed issue, next action,
confidence — and never the model's private reasoning. The trace shows what the
agent *did*, which is what can be reproduced and compared.
