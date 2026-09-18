# Contributing

## Getting set up

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Node 20+ and pnpm 10. Docker, PostgreSQL and Redis are optional for development:
the default store is embedded, the default queue is inline and the default
environment is the host process.

## The checks that have to pass

```bash
pnpm lint          # eslint
pnpm typecheck     # tsc -b --dry, tsc -p tsconfig.json --noEmit, dashboard typecheck
pnpm test          # unit
pnpm test:integration
pnpm test:e2e
pnpm test:security
pnpm test:chaos
pnpm build
```

CI runs all of them. A broken `main` is a bug in the change, not in CI.

## How this codebase is organised

Dependencies point one way: `core` ← everything, `runtime` coordinates, `tools`
and `providers` are plugins. If a change needs `runtime` to import from
`providers`, the abstraction is in the wrong place.

- one package per concern, listed in [architecture.md](architecture.md)
- the execution loop is `packages/runtime/src/loop.ts`, one method per phase
- contracts live in `packages/core/src/contracts`
- tests live next to what they test (`packages/*/test`) or in `tests/` for
  cross-package work

## Writing tests

- Unit tests go in `packages/*/test` and run under the `unit` project.
- Cross-package behaviour goes in `tests/integration`.
- Anything that proves a user-visible guarantee goes in `tests/e2e` — the crash
  test (`tests/e2e/crash-recovery.test.ts`) is the model: real process, real
  `SIGKILL`, real recovery.
- Anything that proves a boundary holds goes in `tests/security`.
- Anything that proves the runtime survives a fault goes in `tests/chaos`, which
  has a fault injector (`tests/helpers/chaos.ts`) that wraps tools, providers and
  stores and records every fault it injected.

Never test against a live model API. `FakeModelProvider` produces scripted
decisions, which is what makes an execution loop test deterministic (spec §87).

## Standards

- Strict TypeScript. `noUncheckedIndexedAccess` is on; a possibly-missing value
  is handled, not asserted away.
- No `TODO` in core functionality. If it is not done, say so in a doc and open an
  issue.
- No silent failure: every `catch` either handles, classifies or rethrows.
- No fake behaviour in tests: a test that cannot fail is not a test.
- Comments explain *why*, especially where the code is doing something
  deliberately conservative.
- Security-relevant behaviour needs a test that would catch its removal.

## Commits and pull requests

One coherent change per commit, imperative subject, and a body that explains the
problem rather than restating the diff. If a change alters a default that has a
security consequence, say so explicitly — reviewers should not have to diff the
policy engine to find it.

A pull request should state: what changed, why, how it was verified (the actual
command and its result), and what it deliberately does not do.

## Documentation

If behaviour changes, the matching document in `docs/` changes in the same
commit. `docs/architecture.md` is the map; if you add a package, add it there.
