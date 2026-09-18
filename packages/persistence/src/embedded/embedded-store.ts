import { mkdirSync } from 'node:fs';
import {
  ConcurrencyError,
  NotFoundError,
  toAgentError,
  type ActionJournal,
  type AgentEvent,
  type AgentRun,
  type AgentStateStore,
  type ApiKey,
  type Approval,
  type ApprovalStore,
  type Checkpoint,
  type CheckpointStore,
  type JournalEntry,
  type MemoryStore,
  type Organization,
  type Project,
  type RunUsage,
  type SerializedAgentState,
  type User,
} from '@kazi-ai/agentos-core';
import type { AgentOSStore, IdentityStore, RunStore } from '../store.js';
import type {
  AgentDefinitionRecord,
  ArtifactRecord,
  FailureRecord,
  ModelUsageRecord,
  Paginated,
  PolicyDecisionRecord,
  PolicyDefinitionRecord,
  RecoveryAttemptRecord,
  RunListFilter,
  RunStepRecord,
  ToolInvocationRecord,
} from '../records.js';
import { JsonlAppendLog, JsonlLog } from './jsonl.js';
import { EmbeddedMemoryStore } from './memory-store.js';

export interface EmbeddedStoreOptions {
  dir?: string;
  name?: string;
  /** Injectable clock so TTL behaviour is testable. */
  now?: () => number;
}

function paginate<T>(items: T[], limit = 50, offset = 0): Paginated<T> {
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

/**
 * Embedded storage driver. With a directory it is durable across process
 * restarts (each write is flushed to an append-only log); without one it is a
 * fast in-memory store for tests.
 */
export class EmbeddedStore implements AgentOSStore {
  readonly driver: string;
  private readonly dir: string | undefined;
  private readonly runLog: JsonlLog<AgentRun>;
  private readonly eventLog: JsonlAppendLog<AgentEvent>;
  private readonly stepLog: JsonlLog<RunStepRecord>;
  private readonly journalLog: JsonlAppendLog<JournalEntry>;
  private readonly checkpointLog: JsonlLog<Checkpoint>;
  private readonly stateLog: JsonlLog<SerializedAgentState & { id: string }>;
  private readonly approvalLog: JsonlLog<Approval>;
  private readonly artifactLog: JsonlLog<ArtifactRecord>;
  private readonly usageLog: JsonlAppendLog<ModelUsageRecord>;
  private readonly counterLog: JsonlLog<{ id: string; runId: string; usage: RunUsage }>;
  private readonly failureLog: JsonlLog<FailureRecord>;
  private readonly recoveryLog: JsonlAppendLog<RecoveryAttemptRecord>;
  private readonly invocationLog: JsonlAppendLog<ToolInvocationRecord>;
  private readonly policyDecisionLog: JsonlAppendLog<PolicyDecisionRecord>;
  private readonly agentDefinitionLog: JsonlLog<AgentDefinitionRecord>;
  private readonly policyDefinitionLog: JsonlLog<PolicyDefinitionRecord>;
  private readonly organizationLog: JsonlLog<Organization>;
  private readonly projectLog: JsonlLog<Project>;
  private readonly userLog: JsonlLog<User>;
  private readonly apiKeyLog: JsonlLog<ApiKey>;
  private readonly memoryStore: EmbeddedMemoryStore;
  private readonly sequences = new Map<string, number>();
  private readonly journalSequences = new Map<string, number>();
  private initialized = false;

  constructor(options: EmbeddedStoreOptions = {}) {
    this.dir = options.dir;
    const name = options.name ?? 'agentos';
    if (this.dir) mkdirSync(this.dir, { recursive: true });
    const opts = (collection: string): { dir?: string; name: string } => ({
      name: `${name}-${collection}`,
      ...(this.dir ? { dir: this.dir } : {}),
    });
    this.driver = this.dir ? 'memory-file' : 'memory';
    this.runLog = new JsonlLog<AgentRun>(opts('runs'));
    this.eventLog = new JsonlAppendLog<AgentEvent>(opts('events'));
    this.stepLog = new JsonlLog<RunStepRecord>(opts('steps'));
    this.journalLog = new JsonlAppendLog<JournalEntry>(opts('journal'));
    this.checkpointLog = new JsonlLog<Checkpoint>(opts('checkpoints'));
    this.stateLog = new JsonlLog<SerializedAgentState & { id: string }>(opts('states'));
    this.approvalLog = new JsonlLog<Approval>(opts('approvals'));
    this.artifactLog = new JsonlLog<ArtifactRecord>(opts('artifacts'));
    this.usageLog = new JsonlAppendLog<ModelUsageRecord>(opts('usage'));
    this.counterLog = new JsonlLog<{ id: string; runId: string; usage: RunUsage }>(opts('counters'));
    this.failureLog = new JsonlLog<FailureRecord>(opts('failures'));
    this.recoveryLog = new JsonlAppendLog<RecoveryAttemptRecord>(opts('recoveries'));
    this.invocationLog = new JsonlAppendLog<ToolInvocationRecord>(opts('invocations'));
    this.policyDecisionLog = new JsonlAppendLog<PolicyDecisionRecord>(opts('policy-decisions'));
    this.agentDefinitionLog = new JsonlLog<AgentDefinitionRecord>(opts('agent-definitions'));
    this.policyDefinitionLog = new JsonlLog<PolicyDefinitionRecord>(opts('policy-definitions'));
    this.organizationLog = new JsonlLog<Organization>(opts('organizations'));
    this.projectLog = new JsonlLog<Project>(opts('projects'));
    this.userLog = new JsonlLog<User>(opts('users'));
    this.apiKeyLog = new JsonlLog<ApiKey>(opts('api-keys'));
    this.memoryStore = new EmbeddedMemoryStore({ ...(this.dir ? { dir: this.dir } : {}), now: options.now });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    // Rebuild per-run sequence counters from durable state so restarts continue
    // numbering instead of colliding.
    for (const event of this.eventLog.all()) {
      this.sequences.set(event.runId, Math.max(this.sequences.get(event.runId) ?? 0, event.sequence));
    }
    for (const entry of this.journalLog.all()) {
      this.journalSequences.set(entry.runId, Math.max(this.journalSequences.get(entry.runId) ?? 0, entry.sequence));
    }
  }

  async close(): Promise<void> {
    for (const log of [this.runLog, this.checkpointLog, this.stateLog, this.approvalLog, this.policyDefinitionLog]) {
      log.compact();
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: this.dir ? `embedded store at ${this.dir}` : 'embedded in-memory store' };
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Single-process store: the caller already holds the run lock, which is the
    // only mutual exclusion that matters. Failures here must not half-apply, so
    // the caller is expected to order appends before state mutation.
    return fn();
  }

  readonly runs: RunStore = {
    create: async (run: AgentRun): Promise<AgentRun> => {
      if (this.runLog.has(run.id)) throw new ConcurrencyError(`Run already exists: ${run.id}`, { runId: run.id });
      this.runLog.put(run);
      return run;
    },
    get: async (runId: string): Promise<AgentRun | undefined> => this.runLog.get(runId),
    update: async (run: AgentRun, expectedVersion?: number): Promise<AgentRun> => {
      const existing = this.runLog.get(run.id);
      if (!existing) throw new NotFoundError('run', run.id);
      if (expectedVersion !== undefined && existing.stateVersion !== expectedVersion) {
        throw new ConcurrencyError(
          `Stale write rejected for run ${run.id}: expected version ${expectedVersion}, found ${existing.stateVersion}`,
          { runId: run.id, expectedVersion, actualVersion: existing.stateVersion },
        );
      }
      this.runLog.put(run);
      return run;
    },
    list: async (filter: RunListFilter = {}): Promise<Paginated<AgentRun>> => {
      const limit = filter.limit ?? 50;
      const offset = filter.offset ?? 0;
      const direction = filter.direction ?? 'desc';
      const key = filter.orderBy ?? 'createdAt';
      let items = this.runLog.filter((run) => {
        if (filter.organizationId && run.organizationId !== filter.organizationId) return false;
        if (filter.projectId && run.projectId !== filter.projectId) return false;
        if (filter.agentId && run.agentId !== filter.agentId) return false;
        if (filter.parentRunId && run.parentRunId !== filter.parentRunId) return false;
        if (filter.status && filter.status.length > 0 && !filter.status.includes(run.status)) return false;
        return true;
      });
      items = items.sort((left, right) => {
        const delta = (left[key] as number) - (right[key] as number);
        return direction === 'asc' ? delta : -delta;
      });
      return paginate(items, limit, offset);
    },
    delete: async (runId: string): Promise<void> => {
      this.runLog.delete(runId);
    },
    countActive: async (organizationId?: string): Promise<number> =>
      this.runLog.filter((run) => {
        if (organizationId && run.organizationId !== organizationId) return false;
        return !['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.status);
      }).length,
  };

  readonly events = {
    append: async (event: AgentEvent): Promise<void> => {
      const current = this.sequences.get(event.runId) ?? 0;
      if (event.sequence <= current) {
        throw new ConcurrencyError(`Event sequence must increase for run ${event.runId}`, {
          runId: event.runId,
          sequence: event.sequence,
          current,
        });
      }
      this.sequences.set(event.runId, event.sequence);
      this.eventLog.append(event);
    },
    list: async (runId: string, options: { afterSequence?: number; limit?: number } = {}): Promise<AgentEvent[]> => {
      const after = options.afterSequence ?? 0;
      const events = this.eventLog.filter((event) => event.runId === runId && event.sequence > after);
      events.sort((left, right) => left.sequence - right.sequence);
      return options.limit === undefined ? events : events.slice(0, options.limit);
    },
    nextSequence: async (runId: string): Promise<number> => (this.sequences.get(runId) ?? 0) + 1,
  };

  readonly steps = {
    save: async (step: RunStepRecord): Promise<void> => {
      this.stepLog.put(step);
    },
    list: async (runId: string): Promise<RunStepRecord[]> =>
      this.stepLog.filter((step) => step.runId === runId).sort((left, right) => left.index - right.index),
  };

  /**
   * Journal semantics: `recordIntent` writes a durable record *before* the tool
   * runs. `recordCommit` appends the outcome. A crash between the two leaves an
   * uncommitted intent that recovery must resolve before replaying.
   */
  readonly actions: ActionJournal = {
    recordIntent: async (entry): Promise<JournalEntry> => {
      const sequence = (this.journalSequences.get(entry.runId) ?? 0) + 1;
      this.journalSequences.set(entry.runId, sequence);
      const record: JournalEntry = { ...entry, sequence };
      this.journalLog.append(record);
      return record;
    },
    recordCommit: async (entry): Promise<JournalEntry> => {
      const previous = [...this.journalLog.all()]
        .reverse()
        .find((item) => item.runId === entry.runId && item.idempotencyKey === entry.idempotencyKey);
      const sequence = (this.journalSequences.get(entry.runId) ?? 0) + 1;
      this.journalSequences.set(entry.runId, sequence);
      const record: JournalEntry = {
        id: previous?.id ?? entry.idempotencyKey,
        runId: entry.runId,
        sequence,
        actionId: previous?.actionId ?? entry.idempotencyKey,
        idempotencyKey: entry.idempotencyKey,
        toolId: previous?.toolId ?? 'unknown',
        ...(previous?.idempotency ? { idempotency: previous.idempotency } : {}),
        argumentsHash: previous?.argumentsHash ?? '',
        status: entry.status,
        attempt: previous?.attempt ?? 1,
        startedAt: previous?.startedAt ?? entry.finishedAt,
        finishedAt: entry.finishedAt,
        ...(entry.result === undefined ? {} : { result: entry.result }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
        ...(previous?.stepId ? { stepId: previous.stepId } : {}),
      };
      this.journalLog.append(record);
      return record;
    },
    findByKey: async (runId: string, idempotencyKey: string): Promise<JournalEntry | undefined> =>
      [...this.journalLog.all()]
        .reverse()
        .find((item) => item.runId === runId && item.idempotencyKey === idempotencyKey),
    list: async (runId: string): Promise<JournalEntry[]> =>
      this.journalLog
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.sequence - right.sequence),
    pending: async (runId: string): Promise<JournalEntry[]> => {
      const latest = new Map<string, JournalEntry>();
      for (const entry of this.journalLog.filter((item) => item.runId === runId)) {
        latest.set(entry.idempotencyKey, entry);
      }
      return [...latest.values()]
        .filter((entry) => entry.status === 'pending' || entry.status === 'executing')
        .sort((left, right) => left.sequence - right.sequence);
    },
    lastCommitted: async (runId: string): Promise<JournalEntry | undefined> => {
      const committed = this.journalLog
        .filter(
          (item) =>
            item.runId === runId &&
            (item.status === 'succeeded' || item.status === 'failed' || item.status === 'skipped'),
        )
        .sort((left, right) => left.sequence - right.sequence);
      return committed[committed.length - 1];
    },
  };

  readonly checkpoints: CheckpointStore = {
    save: async (checkpoint: Checkpoint): Promise<void> => {
      this.checkpointLog.put(checkpoint);
    },
    latest: async (runId: string): Promise<Checkpoint | undefined> => {
      const list = this.checkpointLog.filter((checkpoint) => checkpoint.runId === runId);
      return list.sort((left, right) => right.sequence - left.sequence)[0];
    },
    get: async (checkpointId: string): Promise<Checkpoint | undefined> => this.checkpointLog.get(checkpointId),
    list: async (runId: string): Promise<Checkpoint[]> =>
      this.checkpointLog.filter((checkpoint) => checkpoint.runId === runId).sort((a, b) => a.sequence - b.sequence),
    delete: async (checkpointId: string): Promise<void> => {
      this.checkpointLog.delete(checkpointId);
    },
  };

  readonly identity: IdentityStore = {
    organizations: {
      save: async (organization: Organization): Promise<void> => {
        this.organizationLog.put(organization);
      },
      get: async (id: string): Promise<Organization | undefined> => this.organizationLog.get(id),
      getBySlug: async (slug: string): Promise<Organization | undefined> =>
        this.organizationLog.all().find((organization) => organization.slug === slug),
      list: async (): Promise<Organization[]> => this.organizationLog.all(),
    },
    projects: {
      save: async (project: Project): Promise<void> => {
        this.projectLog.put(project);
      },
      get: async (id: string): Promise<Project | undefined> => this.projectLog.get(id),
      getBySlug: async (organizationId: string, slug: string): Promise<Project | undefined> =>
        this.projectLog
          .all()
          .find((project) => project.organizationId === organizationId && project.slug === slug),
      list: async (organizationId: string): Promise<Project[]> =>
        this.projectLog.all().filter((project) => project.organizationId === organizationId),
    },
    users: {
      save: async (user: User): Promise<void> => {
        this.userLog.put(user);
      },
      get: async (id: string): Promise<User | undefined> => this.userLog.get(id),
      getByEmail: async (organizationId: string, email: string): Promise<User | undefined> =>
        this.userLog
          .all()
          .find((user) => user.organizationId === organizationId && user.email.toLowerCase() === email.toLowerCase()),
      list: async (organizationId: string): Promise<User[]> =>
        this.userLog.all().filter((user) => user.organizationId === organizationId),
    },
    apiKeys: {
      save: async (apiKey: ApiKey): Promise<void> => {
        this.apiKeyLog.put(apiKey);
      },
      get: async (id: string): Promise<ApiKey | undefined> => this.apiKeyLog.get(id),
      getByPrefix: async (prefix: string): Promise<ApiKey | undefined> =>
        this.apiKeyLog.all().find((apiKey) => apiKey.prefix === prefix),
      list: async (organizationId: string): Promise<ApiKey[]> =>
        this.apiKeyLog.all().filter((apiKey) => apiKey.organizationId === organizationId),
    },
  };

  readonly states: AgentStateStore = {
    load: async (runId: string): Promise<SerializedAgentState | undefined> => {
      const stored = this.stateLog.get(runId);
      if (!stored) return undefined;
      const { id: _id, ...state } = stored;
      return state;
    },
    save: async (state: SerializedAgentState, expectedVersion?: number): Promise<void> => {
      const existing = this.stateLog.get(state.runId);
      if (expectedVersion !== undefined && existing && existing.stateVersion !== expectedVersion) {
        throw new ConcurrencyError(
          `Stale state write rejected for run ${state.runId}: expected ${expectedVersion}, found ${existing.stateVersion}`,
          { runId: state.runId, expectedVersion, actualVersion: existing.stateVersion },
        );
      }
      this.stateLog.put({ ...state, id: state.runId });
    },
  };

  get memory(): MemoryStore {
    return this.memoryStore;
  }

  readonly approvals: ApprovalStore = {
    create: async (approval: Approval): Promise<void> => {
      this.approvalLog.put(approval);
    },
    get: async (id: string): Promise<Approval | undefined> => this.approvalLog.get(id),
    update: async (approval: Approval): Promise<void> => {
      this.approvalLog.put(approval);
    },
    list: async (filter): Promise<Approval[]> =>
      this.approvalLog
        .filter((approval) => {
          if (filter.runId && approval.runId !== filter.runId) return false;
          if (filter.organizationId && approval.organizationId !== filter.organizationId) return false;
          if (filter.status && approval.status !== filter.status) return false;
          return true;
        })
        .sort((left, right) => right.requestedAt - left.requestedAt),
    pending: async (organizationId?: string): Promise<Approval[]> =>
      this.approvalLog
        .filter((approval) => {
          if (organizationId && approval.organizationId !== organizationId) return false;
          return approval.status === 'pending';
        })
        .sort((left, right) => left.requestedAt - right.requestedAt),
  };

  readonly artifacts = {
    save: async (artifact: ArtifactRecord): Promise<void> => {
      this.artifactLog.put(artifact);
    },
    list: async (runId: string): Promise<ArtifactRecord[]> =>
      this.artifactLog.filter((artifact) => artifact.runId === runId),
    get: async (artifactId: string): Promise<ArtifactRecord | undefined> => this.artifactLog.get(artifactId),
  };

  readonly usage = {
    record: async (usage: ModelUsageRecord): Promise<void> => {
      this.usageLog.append(usage);
    },
    listByRun: async (runId: string): Promise<ModelUsageRecord[]> =>
      this.usageLog.filter((record) => record.runId === runId).sort((a, b) => a.at - b.at),
    listByOrganization: async (organizationId: string, options: { since?: number; until?: number } = {}): Promise<ModelUsageRecord[]> =>
      this.usageLog.filter((record) => {
        if (record.organizationId !== organizationId) return false;
        if (options.since !== undefined && record.at < options.since) return false;
        if (options.until !== undefined && record.at > options.until) return false;
        return true;
      }),
  };

  readonly counters = {
    saveUsage: async (runId: string, usage: RunUsage): Promise<void> => {
      this.counterLog.put({ id: runId, runId, usage });
    },
    getUsage: async (runId: string): Promise<RunUsage | undefined> => this.counterLog.get(runId)?.usage,
  };

  readonly failures = {
    save: async (failure: FailureRecord): Promise<void> => {
      this.failureLog.put(failure);
    },
    list: async (runId: string): Promise<FailureRecord[]> =>
      this.failureLog.filter((failure) => failure.runId === runId).sort((a, b) => a.at - b.at),
  };

  readonly recoveries = {
    save: async (attempt: RecoveryAttemptRecord): Promise<void> => {
      this.recoveryLog.append(attempt);
    },
    list: async (runId: string): Promise<RecoveryAttemptRecord[]> =>
      this.recoveryLog.filter((attempt) => attempt.runId === runId).sort((a, b) => a.at - b.at),
  };

  readonly invocations = {
    save: async (invocation: ToolInvocationRecord): Promise<void> => {
      this.invocationLog.append(invocation);
    },
    list: async (runId: string): Promise<ToolInvocationRecord[]> =>
      this.invocationLog.filter((invocation) => invocation.runId === runId),
  };

  readonly policyDecisions = {
    save: async (decision: PolicyDecisionRecord): Promise<void> => {
      this.policyDecisionLog.append(decision);
    },
    list: async (runId: string): Promise<PolicyDecisionRecord[]> =>
      this.policyDecisionLog.filter((decision) => decision.runId === runId),
  };

  readonly agentDefinitions = {
    save: async (definition: AgentDefinitionRecord): Promise<void> => {
      this.agentDefinitionLog.put(definition);
    },
    get: async (organizationId: string, agentId: string, version?: string): Promise<AgentDefinitionRecord | undefined> => {
      const matches = this.agentDefinitionLog.filter(
        (definition) =>
          definition.organizationId === organizationId &&
          definition.id === agentId &&
          (version === undefined || definition.version === version),
      );
      return matches.sort((left, right) => right.createdAt - left.createdAt)[0];
    },
    list: async (organizationId: string, projectId?: string): Promise<AgentDefinitionRecord[]> =>
      this.agentDefinitionLog
        .filter(
          (definition) =>
            definition.organizationId === organizationId && (projectId === undefined || definition.projectId === projectId),
        )
        .sort((left, right) => right.createdAt - left.createdAt),
  };

  readonly policyDefinitions = {
    save: async (definition: PolicyDefinitionRecord): Promise<void> => {
      this.policyDefinitionLog.put(definition);
    },
    list: async (organizationId: string, projectId?: string): Promise<PolicyDefinitionRecord[]> =>
      this.policyDefinitionLog
        .filter(
          (definition) =>
            definition.organizationId === organizationId && (projectId === undefined || definition.projectId === projectId),
        )
        .sort((left, right) => right.version - left.version),
    remove: async (id: string): Promise<void> => {
      this.policyDefinitionLog.delete(id);
    },
  };

  /** Test helper: run everything and surface the first failure with context. */
  async assertHealthy(): Promise<void> {
    const health = await this.healthCheck();
    if (!health.ok) throw toAgentError(new Error(health.detail ?? 'store unhealthy'));
  }
}
