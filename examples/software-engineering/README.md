# Example: a software engineering agent

A repository with a genuinely failing test suite, and the developer agent that
fixes it. Nothing here is staged for the demo: `node --test` really fails before
the run and really passes after it, and the last thing the runtime does is run
the suite itself.

```bash
pnpm tsx examples/software-engineering/run.ts
```

```text
KaziAI AgentOS

Run:           run_01J...
Agent:         developer
Model:         deterministic replay

Goal:
Fix the failing tests in this repository and prove the suite passes.

[01] Planning
[02] filesystem.read
[03] terminal.exec
[04] filesystem.edit
[05] terminal.exec
[06] Verification
[07] Recovery (tool_failure on terminal.exec)
[08] Checkpoint #1
...

Verification:
✓ All 2 verifier(s) passed

Result:
COMPLETED

Steps:         5
Tool calls:    4
Recovery:      1
Duration:      936ms
Cost:          $0.000
```

## What actually happens

1. `run.ts` asks the runtime for a run and hands it `repo/` as a **workspace
   seed**. The runtime copies the repository into a workspace that belongs to
   that run alone, so the agent can only touch the copy (spec §70).
2. Planning is on in `agent.yaml`, so the first model call is the planner's and
   the plan is durable before anything executes.
3. The agent reads `src/cart.js`, runs the suite, sees the failure, edits the
   one line that is wrong, and runs the suite again.
4. When the agent says it is done, the runtime does not take its word for it:
   `verification.commands` in `agent.yaml` is `node --test`, and the runtime
   runs that itself in the run's environment. The verification result — not the
   agent's summary — is what the report above shows (spec §39).

The timeline, the token counts, the recovery and the checkpoints are read back
from the durable store after the run; they are not a separate narration.

## Run it against a real model

```bash
export OPENAI_API_KEY=...
pnpm tsx examples/software-engineering/run.ts --live
```

The default mode replays `replay.json` through the deterministic provider
(spec §87), which is why this example needs no credentials and runs in CI. The
provider is the only thing that changes: the runtime, the sandbox, the tools,
the policy engine and the verifier are identical in both modes.

## Why `tool_failure: skip_step` is in `agent.yaml`

A test command that exits non-zero is *information*: the suite is red and the
next thing to do is fix the code. The runtime's default policy for an
unrepeatable tool failure is to re-plan, which is the right answer for a broken
dependency and the wrong one for a failing test, so this agent declares what it
wants instead (spec §35). It is one line in the definition:

```yaml
recovery:
  tool_failure:
    strategy: skip_step
    max_attempts: 3
```

## Files

| Path | What it is |
| --- | --- |
| `agent.yaml` | The agent definition: model, tools, permissions, limits, verification, recovery. |
| `replay.json` | A recorded decision script for the deterministic provider, including the planner's answer. |
| `repo/` | The repository under test — a real failing suite, no fixtures. |
| `run.ts` | The runnable example. |
