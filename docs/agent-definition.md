# Agent definitions

An agent is a declarative document (spec §6). The CLI reads `agents/*.yaml`,
`agents/*.yml` and `agents/*.json` from the current directory and from
`~/.config/kazi-agentos/agents`; the API reads the same shape from its store.

```yaml
id: developer-agent
version: 1.0.0
name: Developer Agent
description: Fixes failing tests in a repository workspace.

model:
  provider: openai-compatible
  model: gpt-5.6

providers:                      # optional failover (spec §38)
  primary: { provider: openai-compatible, model: gpt-5.6 }
  fallback: [{ provider: ollama, model: qwen3:32b }]

system_prompt: |
  You are a software engineering agent.

tools:
  - filesystem
  - terminal
  - git

memory:
  enabled: true
  ttl_seconds: 604800
  max_entries: 1000

planning:
  enabled: true

verification:
  enabled: true
  commands:
    - node --test

recovery:
  enabled: true
  tool_timeout: { strategy: retry_with_backoff, max_attempts: 3 }

limits:
  max_steps: 100
  max_tool_calls: 200
  max_tokens: 200000
  max_cost_usd: 5
  max_duration_seconds: 1800
  max_recovery_attempts: 3

permissions:
  filesystem: { read: true, write: true, delete: false }
  terminal: { execute: true, allow_unisolated: true }
  network: { enabled: false }
  git: { read: true, commit: true, push: false }
  database: { read: true, write: false, connections: [analytics] }

checkpointing:
  after_tool_call: true
  before_risky_action: true
  interval_ms: 60000
  retain: 50

experiment:                     # optional research metadata (spec §91)
  name: no-memory
  variables: { memory: false }
```

## Fields that change behaviour

**`model` / `providers`.** Which provider and model a run starts on, and where it
may fail over to. Every failover is recorded in the trace; the runtime never
switches models silently (spec §38).

**`tools`.** Families expand: `filesystem` means `filesystem.*`. Everything else
is a literal id, and may be a custom tool or an MCP tool such as
`mcp.github.create_issue`. A tool that is not in the list is not offered to the
model *and* cannot be executed.

**`verification.enabled`.** Whether the runtime runs the checks at the end and
feeds the result back to the agent. `commands` are real programs run in the run's
environment; shell metacharacters are rejected rather than interpreted.

**`recovery`.** A map from failure *kind* to strategy (spec §35). The kinds are
the ones the classifier produces: `tool_failure`, `tool_timeout`,
`tool_unavailable`, `invalid_arguments`, `provider_unavailable`,
`authentication_failure`, `environment_failure`, `verification_failed`,
`budget_exceeded`, `policy_denied`, `approval_denied`, `state_conflict`,
`resource_exhausted`, `configuration_error`, `unknown`. Strategies: `retry`,
`retry_with_backoff`, `modify_arguments`, `replan`, `switch_tool`,
`switch_provider`, `restore_checkpoint`, `ask_human`, `terminate`, `skip_step`.
An unknown strategy name is a load error, not a silent fallback.

**`limits`.** Enforced by the runtime independently of the model. Omitting one
means the deployment default applies; it does not mean unlimited.

**`permissions`.** The ceiling. A run request may narrow this and never widen it,
and each tool's own declared permissions are intersected with it before the tool
runs (spec §21).

## Run configuration snapshots

A run records the effective configuration it started with:

```json
{
  "agent": "developer-agent",
  "model": "gpt-5.6",
  "provider": "openai",
  "tools": ["filesystem.*", "terminal.*", "git.*"],
  "limits": { "maxSteps": 100, "maxCostUsd": 5 },
  "permissions": { "git": { "push": false } }
}
```

The snapshot is what makes a run reproducible and a bug report actionable: it is
the configuration that was in force, not the one that is in force now (spec §78).

## Prompt references

`system_prompt` may be a reference to a prompt registry instead of inline text
(spec §61):

```yaml
system_prompt:
  registry: kazi://agents/coding/system
  version: "2.1.0"
```

The resolved prompt id, version and hash are recorded on the run.

## Parsing, and why it is strict

`parseAgentDefinition` rejects unknown keys. A typo like `max_step: 100` fails at
load time instead of silently leaving the step limit at its default — the failure
mode of a permissive parser here is an agent with limits nobody intended.
