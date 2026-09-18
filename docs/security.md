# Security

This document describes what the runtime defends against, and — just as
importantly — what it does not claim to.

## What is trusted, and what is not

Trusted (spec §105):

- the agent definition's system prompt
- the policy engine and its rules
- a run's configuration snapshot

Untrusted:

- model output, including tool calls
- tool output: files, command output, HTTP bodies, database rows, MCP results
- repository content, issues, web pages
- user-supplied prompts and goals

Untrusted content is labelled with its provenance, treated as data, and never
promoted to instructions. Tool output cannot change the permissions a run holds,
and cannot authorize anything: policy evaluates the *action*, not the story
around it.

## Prompt injection

The runtime does not claim to solve prompt injection (spec §68). It reduces the
blast radius:

- an injected instruction cannot exceed the run's grant, because the grant is
  intersected into every tool call
- an injected instruction cannot take an irreversible action, because high-risk
  actions are gated by policy and approvals
- an injected instruction cannot hide: every action, decision and result is in
  the journal and the event log

An approval prompt shows the operator the *action* — the tool, the arguments and
the risk — not the agent's description of it.

## Isolation

| Environment | Isolation |
| --- | --- |
| `local` (default) | process confinement: workspace-relative paths, allow-listed environment, limits. **Not a security boundary.** |
| `docker` | a container per run, no network by default, dropped capabilities |

A tool that declares `requiresIsolation` is refused on `local` unless the run
grants `terminal.allowUnisolated`, and that grant appears in the run's
configuration snapshot and in the policy decision that allowed it.

## Boundaries that are tested

`tests/security/sandbox.test.ts` and the tool suites assert, with real commands:

- `filesystem.read` of `../../etc/passwd`, an absolute path, and a symlink out of
  the workspace are all refused
- `terminal.exec` cannot reach `/etc/passwd` through the filesystem tool's guard,
  and a command needing isolation is refused on a non-isolating environment
- `http.request` to `127.0.0.1`, `169.254.169.254`, `localhost`, `*.internal` and
  a hostname resolving to a private address are all refused
- a command that a policy denies is denied even when the plan named it
- a push without a granted permission is refused before execution
- secrets resolved by the runtime do not appear in events, journal entries,
  failures, tool results or logs

## Secrets

```typescript
interface SecretProvider {
  get(name: string): Promise<string>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}
```

Tools reference secrets as `secret://github/token` or a connection name such as
`db/analytics`, and the runtime resolves them at the edge. Every resolved value
is registered with the redactor, so it is scrubbed from anything written
afterwards — including command output that happens to quote it (spec §66).

## Multi-tenancy

Runs, traces, actions, checkpoints, memory and artifacts are scoped by
`organizationId` and `projectId`. The API derives the tenant from the
authenticated principal and never from a request body, and cross-tenant reads are
a `404` rather than a `403`, so the API does not confirm that another tenant's
run exists (spec §64, §65).

Authentication is API keys with roles (`admin`, `operator`, `developer`,
`viewer`); a local install with no keys configured runs as a single local
operator.

## Reporting a vulnerability

Open a private security advisory rather than a public issue. Include the run id,
the trace, and the smallest definition that reproduces it — the trace usually
contains everything needed.
