# Example: kill a worker, keep the run

The claim this project exists to make, in one command:

```bash
pnpm tsx examples/crash-resume/run.ts
```

It starts a real worker process on a real run, kills that process with `SIGKILL`
three steps in, and then starts a **different** worker process against the same
durable store. The second worker finishes the job from what the first one had
already committed.

```text
── worker #1 ───────────────────────────────────────────────────
pid 49018  started
  committed 3 steps, 3 checkpoints
  SIGKILL — process 49018 is gone

── what survived the crash ─────────────────────────────────────
run status        EXECUTING
steps committed   3
checkpoints       3
journal           3 of 3 action(s) committed
                  filesystem.write  notes/01.txt  succeeded
                  filesystem.write  notes/02.txt  succeeded
                  filesystem.write  notes/03.txt  succeeded
on disk           notes/01.txt notes/02.txt notes/03.txt

── worker #2 ───────────────────────────────────────────────────
pid 49124  started on the same store, with no shared memory

── result ──────────────────────────────────────────────────────
status            COMPLETED
files written     5 / 5
model calls       6
```

## What is real here

- The kill is a real `SIGKILL` to a real OS process (`worker-child.ts`), not a
  simulated exception.
- The two workers share nothing but the store on disk — no memory, no handles.
- The transcript is printed from what is actually persisted: run status, usage
  counters, the action journal and the files in the workspace.
- `model calls 6` for `5` tool calls and a final answer, so the resumed worker
  continued the conversation instead of re-deciding the earlier steps. That is a
  property of the runtime, not of the script: `ContinuationProvider` picks its
  turn from the tool results already in the request, the same way a real model
  would.

## Files

| File | Role |
| --- | --- |
| `run.ts` | Orchestrates the demo and prints the transcript |
| `worker-child.ts` | A real worker process, started by `run.ts` and killed by it |
| `worker.ts` | Spawns the child and turns its JSON lines into events |
| `provider.ts` | The deterministic model, keyed off the conversation it is handed |
| `turns.json` | The decision script: write a file, pause, repeat |

`tests/e2e/crash-resume-example.test.ts` runs this example and asserts the run
finishes, so the demo cannot rot quietly.
