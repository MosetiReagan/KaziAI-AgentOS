# Memory

Memory is pluggable and scoped. It is not a transcript, and it is not automatic:
nothing is persisted forever by default (spec §28).

```typescript
interface MemoryStore {
  write(entry: MemoryEntry): Promise<void>;
  search(query: MemoryQuery): Promise<MemoryEntry[]>;
  delete(id: string): Promise<void>;
  clear(scope: MemoryScope): Promise<void>;
}
```

An entry carries `scope`, `ttl`, `importance`, `source`, `confidence` and
`permissions`, so a stored fact can be judged later rather than taken on trust.

## Types and scopes

```text
working memory    this run, this moment — usually context, not storage
episodic memory   what happened: attempts, outcomes, dead ends
semantic memory   what is true: facts, preferences, conventions
task memory       what is known about this task class
```

An entry is written explicitly, with `type`, `scope`, `content`, `source` and a
confidence; a single entry is capped (16 KiB by default) and truncated rather
than allowed to grow without bound.

Scopes nest, and a search walks the chain from narrow to broad:

```text
run  →  agent  →  project  →  organization
```

Which means an organization-wide convention is available to every agent, while a
run's scratch notes stay in the run.

## Using it

The runtime writes run-scoped memory itself when an agent's definition enables
it, and an embedder can hold the manager directly:

```typescript
import { MemoryManager } from '@kazi-ai/agentos-memory';
import { runScope } from '@kazi-ai/agentos-memory';

const memory = new MemoryManager({ store: os.store.memory, enabled: true });

await memory.remember({
  type: 'episodic',
  scope: runScope(organizationId, projectId, runId),
  content: 'approach "shim" failed with a type error',
  value: { attempt: 2, approach: 'shim', outcome: 'failed' },
  importance: 0.6,
  confidence: 1,
  source: 'recovery:trial-2',
  tags: ['approach', 'failure'],
});

const prior = await memory.recall({ scope: runScope(organizationId, projectId, runId), query: 'failed approach', limit: 5 });
await memory.forget(entry.id);         // or clearScope(scope), pruneExpired()
```

`recallScoped` walks the scope chain (run → agent → project → organization) so a
narrow query can fall back to broader knowledge.

The API exposes `GET /api/memory`, `DELETE /api/memory/:id` and
`POST /api/memory/prune` so an operator can see and retract what an agent kept.

## TTL, importance and pruning

```yaml
memory:
  enabled: true
  ttl_seconds: 604800     # a week
  scopes: [run, agent]
  max_entries: 1000
```

Expired entries are not returned and are removable by the pruner. `importance`
orders what survives a prune, so a run's incidental observations go before its
conclusions.

## Storage

The default implementation is the same durable store as everything else, with
tenant and scope on every row and indexes on `organization_id`, `project_id`,
`run_id` and `created_at`. The interface is storage-agnostic on purpose: a vector
store is a second implementation of `search`, not a redesign (spec §29).
