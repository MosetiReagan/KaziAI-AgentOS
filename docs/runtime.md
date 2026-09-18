# The runtime

`AgentRuntime` is the whole control surface (spec §5):

```typescript
interface AgentRuntime {
  createRun(input: AgentRunInput): Promise<AgentRun>;
  start(runId: string): Promise<void>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  retry(runId: string): Promise<void>;
  getRun(runId: string): Promise<AgentRun>;
  getState(runId: string): Promise<AgentState>;
  getTrace(runId: string): Promise<Trace>;
  checkpoint(runId: string): Promise<Checkpoint>;
}
```

`start` executes the run to its *next resting point* and returns. A resting point
is one of: completed, failed, cancelled, timed out, paused, or **waiting** for a
human approval. Nothing about the caller is durable — a worker, the API and the
CLI all call the same method and can all be killed between two calls.

## The state machine

```text
CREATED → QUEUED → INITIALIZING → PLANNING → EXECUTING → OBSERVING → VERIFYING → COMPLETED
                                     ↑            │            │
                                     │            ↓            │
                                     └────── RECOVERING ←──────┘
                                                  │
                                                  ↓
                                                FAILED
```

Plus `WAITING` (blocked on a human), `PAUSED` (blocked on an operator),
`CANCELLED` and `TIMED_OUT`. The legal transitions are a table in
`packages/core/src/state-machine.ts`; anything not in it throws
`InvalidTransitionError`. No code path mutates `run.status` directly.

Concurrency is guarded by a per-run state version: an update carries the version
it read, and a stale writer is rejected rather than allowed to overwrite a newer
one (spec §81, §82).

## The execution loop

`packages/runtime/src/loop.ts` implements the phases of spec §8 as separate,
independently testable methods:

```text
while not complete:
    checkLimits()                 budgets, duration, step ceiling
    observe()                     reload durable state, fold in observations
    plan()                        once, when there is no plan
    decide()                      ask the model for the next action
    act()                         policy → approval → journal → execute
    record()                      persist outcomes, events, failures
    recover()                     on failure: classify, decide, apply
    checkpointIfRequired()        durability at policy-defined points
```

`iterate` is the only place that loops; every phase returns a `LoopOutcome` when
the run should stop. An exception escaping any phase is caught and *classified*
by `containFailure`, so a run never ends silently (spec §104).

## Actions are authorized, not trusted

A plan is advisory (spec §10). Every action, whoever proposed it, goes through:

```text
action
  → policy engine            ALLOW | DENY | REQUIRE_APPROVAL
  → approval (if required)   durable request, fingerprint-matched decision
  → budget check             independently of the model's opinion
  → journal (intent)         idempotency key recorded before execution
  → tool execution           sandboxed by the run's grant
  → journal (commit/abort)   the record of what happened
  → event                    what the outside world sees
```

The action journal is what makes retries safe: an action that already committed
is never re-run, and a failed action is only retried when its idempotency class
says that repeating it is safe (spec §32).

## Pause, resume, cancel, retry

| Call | What it does |
| --- | --- |
| `pause` | Signals a running run to stop at the next safe point, or checkpoints and parks a run that is between workers |
| `resume` | Re-queues a paused run and starts it |
| `cancel` | Signals cancellation, cancels the run's pending approvals, and ends it as `CANCELLED` |
| `retry` | Moves a `FAILED`/`TIMED_OUT` run back to `QUEUED` and starts it again |
| `checkpoint` | Writes a checkpoint now and returns it |
| `fork` | Creates a *new* run from a checkpoint; the original is untouched |
| `replay` | Re-runs the recorded actions of a finished run (see `replay.ts`) |

## Traces

`getTrace(runId)` returns the run's span tree, assembled from the event log and
the action journal. The phases emit `agent.run`, `agent.plan`, `agent.step`,
`agent.tool`, `agent.verification`, `agent.recovery` and `agent.checkpoint`
spans; with `KZ_TELEMETRY_ENABLED=true` they also go out over OTLP (spec §50).

Secrets resolved from the secret provider are scrubbed from everything the
runtime writes — events, journal entries, failures, logs and spans (spec §66).

## Budgets

Budgets are checked in the loop, not by the model: steps, tool calls, tokens,
cost, duration, recovery attempts, network calls and storage. Exceeding one ends
the run as `TIMED_OUT` or `FAILED` with `resource.exhausted`, and emits
`budget.exceeded` (spec §25).
