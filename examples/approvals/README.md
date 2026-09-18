# The human approval gate

An agent is asked to release. It can read the repository, write files and commit —
all of that is allowed, and all of it is reversible. The last step, `git push`,
is neither. So the run stops, a person is asked, and the run continues from their
answer.

The point of the example is the pair of lines at the bottom of `agent.yaml`:
this agent is **granted** `git.push`. It still cannot push. Authorization is not
a property of the tool, and it is not a promise the planner made (spec §10). It
is a decision the policy engine makes about one specific action, in front of one
specific run, and `require-approval.git.push` sends every push to a human.

```bash
pnpm tsx examples/approvals/run.ts
pnpm tsx examples/approvals/run.ts --deny
```

Both modes run offline with the deterministic provider from spec §87, so the
example works in CI with no API key. `--live` puts a real model in the same seat.

## What actually happens

```text
Run:           run_01M2TEXEWYVK9B2EWV1VH0H04B
Agent:         release-agent-replay
Workspace:     .../workspaces/org_example/run_01M2TEXEWYVK9B2EWV1VH0H04B
Remote:        .../remotes/run_01M2TEXEWYVK9B2EWV1VH0H04B.git

Goal:
Prepare the release note, commit it, and push the release to origin.

Approval 1 of 1 (apr_01M2TEXFCTXTMR3QNTTW3CHE13)

Action:        git push origin main
Risk:          CRITICAL
Reason:        Pushing to a remote repository always requires human approval
Target:        git

Status:  WAITING — persisted, not held in memory.

Decision: approve (operator@example.com)

[01] git
[02] filesystem.edit
[03] git
[04] git
[05] git
[06] Approval requested: git
[07] Checkpoint #1
...

Result:
COMPLETED

Steps:         7
Tool calls:    6
Recovery:      0
Duration:      637ms
Cost:          $0.000

Evidence:
Local commits: 2
Remote commits: 2

  origin/main 1004e33 release: note the approval-gated flow
  origin/main c0614bd chore: initial import

✓ The approved push landed on the remote, and it took a human to let it happen.
```

The last block is the part that matters. The agent's summary is not the evidence;
the driver reads the remote it set up, after the run, and reports what is on it.
`--deny` prints `Remote commits: 0` and exits 0 for the same reason: the gate held.

## What the run leaves behind

- **A durable request.** `os.runtime.pendingApprovals()` reads the request back
  out of storage, and the approval carries a fingerprint of the action it
  authorises. An approval made against different arguments does not authorise
  this one (spec §23).
- **A resting point, not a held process.** At the gate the run is `WAITING` at a
  checkpoint. The example's own test closes the runtime entirely, reopens it on
  the same data directory, and resumes: the pending request is still there,
  matched by fingerprint rather than by object identity.
- **A record of the decision.** `approval.requested`, `approval.granted` /
  `approval.denied` in the event log, the decision, the decider and their reason
  on the approval row, and the risk that triggered it all (spec §54).
- **Nothing irreversible before the decision.** The action journal contains no
  push attempt, and the remote is empty while the run waits.
- **Work that was safe to keep.** A denial does not throw away the commit the
  agent already made. Reversible work stays; the irreversible step does not
  happen.

## Where the pieces live

| File | What it is |
| --- | --- |
| `agent.yaml` | The reference agent: tools, limits, and a granted-but-gated `git.push` |
| `replay.json` | The recorded decisions, including the re-issued push after the gate |
| `repository.ts` | The world the example needs: a repository and a bare remote |
| `repo/` | The workspace seed |
| `run.ts` | The driver: start, read the queue, decide, resume, check the remote |
