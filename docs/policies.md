# Policies

Every action is authorized before it runs, whatever the plan said (spec §10, §22).

```typescript
interface PolicyEngine {
  evaluate(action: AgentAction, context: PolicyContext): Promise<PolicyDecision>;
}
```

A decision is `ALLOW`, `DENY` or `REQUIRE_APPROVAL`, and it carries the rule that
produced it, a reason, and a risk level. The evaluation is recorded: the API's
`GET /api/runs/:id/decisions` and `kazi-agent inspect` both show it.

## Risk classification

Risk is inferred from the action's arguments, not just its tool (spec §24):

| Action | Risk |
| --- | --- |
| read a file, list, search, `git status` | `LOW` |
| write or edit a file, run an ordinary command, an HTTP request, a commit | `MEDIUM` |
| delete data, write to a database | `HIGH` |
| delete production data, a push, DDL, a destructive shell command | `CRITICAL` |

Rules live in `packages/policies/src/risk.ts` and can be extended with
`createAgentOS({ policyRules })`. A tool's declared `risk` is a floor.

## The default rules

```text
deny.sandbox.unisolated            a tool needing isolation, on an environment that is not one
deny.filesystem.delete.production  deleting production data without an explicit override
require-approval.git.push          every git push
deny.terminal.force-push           force-pushing shared history
```

Anything unmatched falls through to: `ALLOW` below `HIGH`, `REQUIRE_APPROVAL` at
`HIGH`, `DENY` at `CRITICAL` if `denyRisk` is configured.

A rule that throws is treated as `DENY`. Failures in policy code must never
become permissions.

## Approvals

When policy says `REQUIRE_APPROVAL`, the executor writes a durable approval
request and the run stops in `WAITING`:

```typescript
const pending = await os.runtime.pendingApprovals();
await os.runtime.decideApproval({
  approvalId: pending[0].id,
  decision: 'approve',            // or 'deny' | 'modify'
  decidedBy: 'operator@example.com',
  reason: 'Reviewed the commit.',
});
await os.runtime.resume(runId);
```

Three properties make this more than a prompt (spec §23):

- **The request is persisted before the run waits.** A restart does not lose it.
- **The decision is matched by action fingerprint**, not by object identity: an
  approval made against different arguments does not authorize this action, and
  re-issuing the same action after a pause finds the operator's answer instead of
  re-asking forever.
- **`modify` substitutes arguments** and the runtime executes what the approver
  approved, not what the agent proposed.

`examples/approvals` walks through this end to end, including the denial path.

## Sentinel, later

```typescript
interface PolicyProvider {
  authorize(action: AgentAction): Promise<PolicyDecision>;
}
```

The local engine implements this, and a composite engine can delegate to a
remote one (`packages/policies/src/remote.ts`). Nothing requires a remote
policy service: the local engine is complete on its own.

## Budgets as policy

Budgets are a second, independent gate (spec §25). A run carries limits for
steps, tool calls, tokens, cost, duration, network calls and storage; they are
checked in the loop before each action, and exceeding one ends the run rather
than letting it spend without a ceiling.
