# Recovering from a real outage

The agent is asked a question whose answer is in a SQLite database. While it asks,
a second connection holds a write lock on that database — the kind of thing a
migration or a backup does — so the first query comes back `database is locked`.

That is not an answer, and it is not a reason to re-plan. It is a transient
outage, and the runtime recovers from it by running *the same action* again.

```bash
pnpm tsx examples/recovery/run.ts
```

The example runs offline with the deterministic provider from spec §87, so it
works in CI with no API key. `--live` puts a real model in the same seat.

## What actually happens

```text
[01] ledger.orders_over
[02] ledger.orders_over
[03] filesystem.write
[04] Verification
[05] Recovery (tool_failure on ledger.orders_over)
[06] Checkpoint #1
...

Verification:
✓ All 2 verifier(s) passed

Result:
COMPLETED

Steps:         3
Tool calls:    3
Recovery:      1
Duration:      936ms
Cost:          $0.000

What the runtime recorded:
  TOOL FAILURE   ledger.orders_over - database is locked
  RECOVERY       tool_failure
  RETRY          retry_with_backoff (applied: true)
  SUCCESS        ledger.orders_over
  SUCCESS        filesystem.write

Recovery:      attempt 1 · retry_with_backoff · applied
Outage:        maintenance job finished
```

The last block is read back from the append-only journal, the failure records and
the recovery records — not from the agent's narration.

## Recovery, precisely

- **The failure is real.** `database is locked` is SQLite refusing a read because
  another connection holds `BEGIN EXCLUSIVE`. Nothing throws a stand-in error.
- **The retry is a second execution.** The runtime does not ask the model again to
  recover from a failed tool call: `retry_with_backoff` re-executes the same
  action, and the journal proves it — one action idempotency key, `failed` on
  attempt 0 and `succeeded` on attempt 1 (spec §32, §33).
- **The classification decides.** `tool.database_locked` classifies as
  `tool_failure`, which the agent's `recovery:` block maps to `retry_with_backoff`
  with three attempts (spec §35). A non-retryable error would be re-planned
  instead, never repeated (spec §37).
- **Giving up is loud.** Keep the lock held and the run ends `FAILED` after its
  attempts are exhausted. It does not report a number it could not read; there is
  a test for exactly that.
- **The answer is verified independently.** The runtime runs `node verify.mjs`
  after the agent claims to be done, and that check reads `report.md` and fails
  unless the total is the one the seeded ledger adds up to (spec §39).
- **Replay is a recorded trajectory.** The decisions in `replay.json` are what a
  model produced; the tools they name are real. `--live` replaces the script with
  a real model, and the report content then comes from the model too.

## Why the example ships its own tool

The built-in `database.query` is a general SQL runner and declares itself **HIGH**
risk, so policy sends every call to a human — the right default for a tool that
can be pointed at any statement. This example wants to show recovery rather than
approval, so it ships the narrower tool an organisation would ship anyway:
`ledger.orders_over` runs exactly one read, cannot express a write, and declares
its permissions (`database.read`, connection `shop`) so the executor intersects
them with the run's grant (spec §21, §73).

The connection string never reaches the model. The tool resolves `db/shop` from
the secret provider and gets a filesystem path the agent has no other way to
learn (spec §66).

## Where the pieces live

| File | What it is |
| --- | --- |
| `agent.yaml` | The analyst agent: tools, limits, verification command, recovery policy |
| `replay.json` | The recorded decisions — note there is no turn for the retry |
| `database.ts` | The database, the maintenance job that locks it, and the ledger tool |
| `repo/verify.mjs` | The independent check the runtime runs after the run claims to be done |
| `run.ts` | The driver: build the world, run the agent, read the record back |
