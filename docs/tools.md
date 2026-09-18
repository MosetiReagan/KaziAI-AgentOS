# Tools

A tool is the only way an agent touches the world (spec §13):

```typescript
interface AgentTool {
  id: string;                        // namespaced: filesystem.read
  description: string;
  inputSchema: ZodSchema;            // validated before execute
  permissions?: ToolPermissions;     // what it needs; the run's grant is authoritative
  risk?: RiskLevel;                  // a floor for classification
  sandbox?: ToolSandboxRequirements; // workspaceConfined, requiresIsolation
  defaultIdempotency?: IdempotencyClass;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}
```

Every tool gets: schema validation, a permission check, a timeout, logging,
resource limits, artifact capture and secret redaction of everything it returns.

## Namespaces

```text
filesystem.read   filesystem.write   filesystem.edit   filesystem.list
filesystem.search filesystem.delete  filesystem.move
terminal.exec
http.request
git
database.query
mcp.<server>.<tool>
<your.namespace>.<tool>
```

A definition may name a family (`filesystem`), a specific tool
(`filesystem.read`), or a wildcard (`mcp.github.*`).

## The built-in tools

### `filesystem`

`read`, `write`, `edit`, `list`, `search`, `delete`, `move`. Everything is
resolved through a `PathGuard` rooted at the run workspace, so `../` and symlink
escapes are refused before a syscall happens. Reads are `LOW` risk, writes and
moves `MEDIUM`, deletes `HIGH` — or `CRITICAL` when the arguments mention
production (spec §16, §24).

### `terminal`

The security-sensitive one (spec §15). It runs a program with an argument vector
— never a shell string — with a working directory inside the workspace, an
allow-listed environment, CPU/memory/process/output limits and a timeout. The
host-process environment is a *confinement*, not a boundary, so a command that
declares `requiresIsolation` is refused there unless the run grants
`terminal.allowUnisolated`. Point the runtime at the Docker environment for real
isolation.

### `http.request`

`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, with timeouts, header
allow-listing, response size caps, and `follow_redirects` **off** by default.
Private, loopback, link-local and internal names are refused, and a hostname that
resolves to a blocked address is refused too — SSRF protection is on unless the
run's permissions say otherwise (spec §17).

### `git`

`status`, `diff`, `log`, `branch`, `checkout`, `add`, `commit`, `push`, `show`,
`rev_parse`. Reads are `LOW` risk, commits `MEDIUM`, pushes `CRITICAL`, and the
default policy engine turns every push into a human approval. `git.push` is also
a *permission*, off unless the run grants it (spec §18, §96).

### `database.query`

Parameterized SQL against a named connection. The agent cannot invent a
connection: it may only name one the run's permissions already list, and the
connection string itself is resolved from the secret provider. Read-only unless
the run grants `database.write`. The tool declares itself `HIGH` risk, so by
default policy sends its calls to a human.

## The registry

```typescript
interface ToolRegistry {
  register(tool: AgentTool): void;      // throws if the id is taken
  override(tool: AgentTool): void;      // replace deliberately
  unregister(toolId: string): void;
  get(toolId: string): AgentTool | undefined;
  list(): AgentTool[];
  resolve(ids: string[]): AgentTool[];
}
```

`os.tools` is the shared registry, so a custom tool is registered once and is
available to every agent whose definition names it.

## Custom tools (spec §73)

```typescript
import { z } from 'zod';
import { defineTool } from '@kazi-ai/agentos-tools';

const weather = defineTool({
  id: 'weather.get',
  description: 'Current weather for a city',
  risk: 'LOW',
  idempotency: 'idempotent',
  permissions: { network: { enabled: true, allowedHosts: ['api.example.com'] } },
  input: z.object({ city: z.string() }),
  async execute(input, context) {
    const response = await fetch(`https://api.example.com/${encodeURIComponent(input.city)}`);
    return { city: input.city, celsius: (await response.json()).temp_c };
  },
});

os.tools.register(weather);
```

Return a value or a full `ToolResult`. Throw an `AgentError` when you know
something the runtime does not — in particular, mark a transient failure
`retryable: true`, or the recovery engine will refuse to retry it and re-plan
instead (spec §37). `examples/recovery/database.ts` is a worked example.

A declared `risk` is a **floor**: classification rules may raise it, never lower
it. That is why `defineTool({ risk: 'CRITICAL' })` reliably gets an approval gate.

## Verified tools, not trusted tools

A tool's output is untrusted content (spec §67, §105). It is labelled with its
source, treated as data rather than instructions, and can never widen the agent's
permissions. `tools/testing.ts` provides helpers for exercising tools against a
throwaway workspace in unit tests.
