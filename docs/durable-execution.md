# Durable execution

The runtime is built for runs that last minutes or hours, on infrastructure that
restarts (spec §41, §42).

## State is never only in memory

```text
desired state    what the operator asked for: run, pause, resume, cancel
current state    where the run is: status, state version, plan, usage
execution event  what happened, appended, never rewritten
checkpoint       a point the run can be resumed from
```

A worker holds nothing durable. `start(runId)` loads the run, its state, its
journal and its checkpoint from the store; if the process disappears, the same
call in another process continues the work. There is no worker-affinity, no
in-memory session registry, and no "the other worker has it" failure mode.

## Where work goes

| `KZ_QUEUE` | Behaviour |
| --- | --- |
| `inline` (default) | the API or CLI executes the run in-process |
| `store` | runs are claimed from the durable store — no Redis needed, and a dead worker's claim expires |
| `bullmq` | runs go on `agentos-runs` in Redis |

The store-backed queue is the one that matters for correctness: a claim is a
durable record with a `workerId` and a heartbeat, `CLAIMABLE` includes in-flight
states — `INITIALIZING`, `PLANNING`, `EXECUTING`, `OBSERVING`, `VERIFYING`,
`RECOVERING` — so a run whose worker died mid-execution is picked up by the next
worker sweeping for stale claims. The worker sweeps on every tick, not only when
it claimed something, because an orphaned run has nobody to notice it otherwise.

An unknown `KZ_QUEUE` value is a configuration error: the runtime never silently
falls back to executing runs in the API process.

## Exactly-once is not claimed

Distributed systems do not give exactly-once execution, and this runtime does not
pretend otherwise (spec §32). Instead, every action is classified:

```text
idempotent        safe to repeat
retry-safe        repeating is acceptable
non-idempotent    repeating may double-apply
unknown           assume the worst
```

The append-only action journal holds an entry per attempt with an idempotency
key, the arguments hash, the status and the result. Before re-running anything
the executor checks the journal:

- a **committed** action is never re-run, whatever the caller wants
- a **failed** action is only retried when it is `idempotent` or `retry-safe`
- a non-idempotent action whose intent is journaled but whose outcome is unknown
  goes to a human rather than being guessed at

`tests/e2e/crash-recovery.test.ts` is the mandatory test (spec §114): a real
child-process worker executes part of a run, is `SIGKILL`ed, and another worker
finishes the run to the correct terminal state.

## Idempotency keys and deduplication

Job ids are derived from the run and the dispatch, so enqueueing the same work
twice is a no-op rather than a second execution. The journal's idempotency keys
do the same job one level down, per action.

## Graceful shutdown

Workers stop accepting new work, let safe operations finish, checkpoint the runs
they were executing, release their claims and locks, close their connections and
exit (spec §84). A run that cannot finish safely is released back to the queue
rather than abandoned in `EXECUTING`.

## Backpressure

Concurrency ceilings — runs per process, runs per organization, tool executions,
containers, queue depth — are enforced with explicit `RESOURCE_EXHAUSTED`
failures rather than unbounded growth (spec §83).

## What is not built yet

The specification sketches finer-grained queues (`agent-step`, `tool-execution`,
`verification`, `recovery`, `checkpoint`, `cleanup`). What exists is one run
queue, because a step is executed inside the run's process and splitting it out
would add a hop without adding durability — the journal already makes a step
resumable. Splitting those queues is a scaling change behind the same
`RunQueue` interface, not a correctness change.
