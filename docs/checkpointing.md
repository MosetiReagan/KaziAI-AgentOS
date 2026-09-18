# Checkpointing

A checkpoint is a point a run can be resumed, inspected, forked or restored from
(spec §30):

```typescript
interface Checkpoint {
  id: string;
  runId: string;
  sequence: number;
  state: SerializedAgentState;
  contextSnapshot: ContextSnapshot;
  environmentSnapshot?: EnvironmentSnapshot;
  createdAt: Date;
}
```

## When checkpoints happen

The policy is declarative (`packages/checkpoints/src/policy.ts`), and the
defaults are:

| Trigger | Default |
| --- | --- |
| after the plan is created | on |
| after a successful tool call | on |
| after a state change | off |
| before a risky action (`HIGH`/`CRITICAL`) | on |
| before recovery | on |
| before pause | on |
| every N steps | 10 |
| periodic | 60s |
| workspace snapshot alongside state | on |
| retained per run | 50, labelled ones never pruned |

An agent definition can override any of these under `checkpointing:`. A run can
also be checkpointed on demand:

```bash
kazi-agent checkpoint run_123
```

```typescript
await os.runtime.checkpoint(runId);
```

## What is in one

- the serialized agent state: objective, plan, current step, usage
- the context snapshot: completed steps, pending steps, observations, tool
  results, memory references, verification state
- the environment snapshot: the workspace's files with their hashes and sizes

The workspace is content-addressed (`blobs/` plus a manifest), so a snapshot with
one changed file does not copy the whole tree, and a restore can detect a file
that changed underneath it.

## Resume, restore, fork

| Operation | Effect on the original run |
| --- | --- |
| resume | continues it |
| restore | rewinds its state to the checkpoint and continues from there |
| fork | **nothing** — a new run is created from the checkpoint |
| replay | nothing — the recorded actions are re-executed in a new run |

Forking is the safe way to experiment, because it cannot damage the run you were
investigating (spec §56):

```bash
kazi-agent fork run_123 --checkpoint cp_42 --goal "Try the other approach"
```

```typescript
const forked = await os.runtime.fork(runId, { checkpointId, goal: '...' });
```

The fork gets its own workspace seeded from the checkpoint's snapshot, its own
budgets and its own trace, and the API links the two runs so the lineage is
visible.

## Inspecting one

`GET /api/runs/:id/checkpoints` lists them; the dashboard's run page shows the
state, plan, completed actions and environment snapshot for each. Restoring is
deliberately a two-step operation in the UI — pick the checkpoint, then confirm —
because it discards work.
