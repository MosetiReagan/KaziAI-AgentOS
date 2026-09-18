# Recovery

Failures are classified, decided on, and applied — explicitly, in that order
(spec §34):

```typescript
interface RecoveryEngine {
  classify(error: AgentError): FailureClassification;
  decide(context: RecoveryContext): Promise<RecoveryDecision>;
  execute(decision: RecoveryDecision): Promise<RecoveryResult>;
}
```

## Classification

The classifier maps an error code to a *kind*, a category, a risk level,
retryability, idempotency and terminality. It never guesses: an unclassified
error is not assumed safe to retry (`packages/recovery/src/classify.ts`).

```text
tool.timeout          → tool_timeout          retryable
tool.command_failed   → tool_failure          retryable
tool.invalid_input    → invalid_arguments     not retryable
provider.rate_limit   → provider_unavailable  retryable
provider.authentication → authentication_failure  not retryable
environment.*         → environment_failure
storage.*             → resource_exhausted    retryable (a store outage is weather, not a plan problem)
budget.exceeded       → budget_exceeded       terminal
policy.denied         → policy_denied         terminal
```

## Policy

A map from kind to strategy, with the agent definition's `recovery:` block
overriding the deployment default (spec §35):

```yaml
recovery:
  tool_failure:        { strategy: retry_with_backoff, max_attempts: 3, base_delay_ms: 1000 }
  tool_timeout:        { strategy: retry_with_backoff, max_attempts: 3 }
  invalid_arguments:   { strategy: replan }
  environment_failure: { strategy: restore_checkpoint, max_attempts: 2 }
  authentication_failure: { strategy: ask_human }
  budget_exceeded:     { strategy: terminate }
```

The defaults are in `packages/recovery/src/policies.ts`. A definition naming an
unknown strategy fails at load time.

## Three rules that override the map

1. **A non-retryable error is never retried**, whatever the map says. Recovery
   re-plans instead, because repeating an error that cannot succeed only burns
   budget (spec §37).
2. **A non-idempotent action with an uncommitted journal entry goes to a human.**
   The runtime does not guess whether the side effect landed (spec §32).
3. **An open circuit breaker changes the decision.** If the dependency is known
   to be failing, retrying is replaced by failover or escalation instead of
   hammering it (spec §36).

## What `execute` actually does

| Strategy | Effect |
| --- | --- |
| `retry`, `retry_with_backoff` | waits out the backoff, then **re-executes the same action** |
| `replan` | asks the planner to revise the plan |
| `restore_checkpoint` | rewinds state (and workspace) to the last good checkpoint |
| `switch_provider` | moves the run to the next configured model |
| `ask_human` | creates a durable approval request and parks the run in `WAITING` |
| `skip_step` | marks the step failed and moves on |
| `terminate` | ends the run as `FAILED` with the original error |

A retry is not a second model call. `retry_with_backoff` re-runs the action in
the executor and the model only sees the outcome — which is why a retry cannot be
"talked out of" by the model, and why the journal shows one action idempotency
key with attempts.

## Retries

Exponential backoff with full jitter by default, a maximum attempt count, and a
classification check before every attempt. `RetryEngine` also takes
`alreadyExecuted()`, so a non-idempotent operation is verified as not-yet-applied
before it is repeated.

## Circuit breakers

Per dependency (provider, MCP server, HTTP host, database connection):

```text
CLOSED → (failures over threshold) → OPEN → (cooldown) → HALF_OPEN → CLOSED | OPEN
```

An open breaker is visible in the run's decisions and in the trace, and it
changes recovery from "retry" to "fail over or escalate".

## What recovery is not

It is not a retry-everything loop. Every attempt is recorded — `recoveries` rows
with the decision, the strategy and whether it was applied — every attempt counts
against `max_recovery_attempts`, and a run that exhausts them fails loudly with
the original error rather than a summary of the retries.

`examples/recovery` shows the whole path against a database that is really
locked: `TOOL FAILURE → RECOVERY → RETRY → SUCCESS`, and the failing case where
the outage outlasts recovery and the run fails instead of inventing an answer.
