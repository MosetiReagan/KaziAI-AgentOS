# Context

The context manager decides what the model is shown, and it is a component rather
than an emergent property of how messages happen to be appended (spec §26).

## What it assembles

- the system prompt (inline or resolved from a prompt registry)
- the objective and the current plan, with the current step marked
- observations from tool results, labelled with their provenance
- retrieved memory, when the agent has memory enabled
- verification state, after a verifier has run
- the tools the run is actually allowed to use

## Budgeting

```typescript
interface ContextBudget {
  maxTokens: number;          // the ceiling for one request
  reserveForResponse: number; // headroom for the model's answer
  minRecentObservations: number;
}
```

Assembly is ordered by value, not by recency: the objective, the plan and the
current step are never dropped; observations are trimmed from the oldest and
least relevant; oversized tool output is replaced by a summary that names what
was truncated and where the full result is stored.

Nothing is discarded silently. When the manager compresses, it records a
`CompressionRecord` — what was dropped, what replaced it, and how many tokens
were saved — which lands in the trace and in the context snapshot:

```typescript
const built = await context.build({ run, state, observations, tools });
built.estimatedTokens;    // what this request will cost before it is sent
built.compressed;         // whether summarisation happened
built.records;            // what was compressed and why
```

## Summarisation

`ExtractiveSummarizer` is the default: it selects the lines that carry the
result (errors, exit codes, diffs, numbers) rather than paraphrasing with another
model call. A model-backed summarizer can be substituted through
`ContextManagerOptions.summarizer`, which is a trade of money for fidelity that
should be a deliberate choice.

## Snapshots

The context snapshot is what makes a run resumable after a crash: the objective,
the plan, completed and pending steps, important observations, tool results,
memory references and verification state (spec §27). It is written with each
checkpoint and restored with the run, so a resumed agent does not start from an
empty conversation and does not re-discover what it already learned.

## Why it is a package

Context behaviour is the most-studied variable in agent reliability — what you
show the model decides what it does. Keeping it behind `ContextManager` means an
experiment can change one thing (retrieval strategy, summariser, budget) and
measure the difference, without touching the loop or the tools (spec §91, §92).
