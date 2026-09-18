# Reference agents

Four declarative definitions (spec §93). They exist to be read and copied, and
they are deliberately simple: each one is a starting point, not a product.

| Agent | Tools | What it is for |
| --- | --- | --- |
| `developer-agent` | filesystem, terminal, git | Fix a failing test suite and prove it passes |
| `research-agent` | filesystem, http.request | Fetch sources, keep notes, write a cited summary |
| `devops-agent` | filesystem, terminal, git | Inspect and change infrastructure, stopping at the destructive parts |
| `database-agent` | filesystem, database | Answer questions from a read-only, pre-authorized connection |

They load from the directory the CLI already searches, so from a checkout:

```bash
kazi-agent agents
kazi-agent run developer-agent --goal "Fix the failing tests in this repository."
```

What they have in common is the point:

- **Nothing is granted that is not used.** No agent here can delete, and none can
  push; `devops-agent` is the only one with a shell, and it says out loud that
  its shell is not an isolation boundary.
- **Every limit is finite.** Steps, tool calls, tokens, cost and duration all have
  a ceiling, because the runtime enforces them whether or not the model agrees
  (spec §25).
- **Verification is never a check that always passes.** `developer-agent` runs a
  real test command; the agents whose work has no cheap check say
  `verification: enabled: false` rather than shipping a verifier that is theatre
  (spec §39).
- **Recovery is named per failure.** A red test suite and an unreachable database
  are different situations and get different policies (spec §35).

`tests/integration/reference-agents.test.ts` keeps them honest: it asserts they
parse, and that none of them has quietly gained a capability the set is supposed
to withhold.
