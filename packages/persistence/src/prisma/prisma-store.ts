import { createRequire } from 'node:module';
import {
  ConcurrencyError,
  NotFoundError,
  type ActionJournal,
  type ApiKey,
  type AgentEvent,
  type AgentRun,
  type AgentStateStore,
  type Approval,
  type ApprovalStore,
  type Checkpoint,
  type CheckpointStore,
  type JournalEntry,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryScope,
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
  WebhookDeliveryRecord,
  WebhookListFilter,
  WebhookStore,
  WebhookSubscriptionRecord,
} from '../records.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRecord = Record<string, any>;

const require = createRequire(import.meta.url);

function loadPrismaClient(): any {
  try {
    return require('@prisma/client');
  } catch (error) {
    throw new Error(
      'Prisma client is not generated. Run "pnpm --filter @kazi-ai/agentos-persistence prisma generate" first. ' +
        `Underlying error: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

function json<T>(value: T | null | undefined): any {
  return value === null || value === undefined ? undefined : value;
}

function date(value: number | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

/**
 * Postgres driver backed by Prisma. Tenant scoping is applied on every query so
 * a missing filter cannot leak another organization's data.
 */
export class PrismaStore implements AgentOSStore {
  readonly driver = 'postgres';
  private readonly prisma: any;

  constructor(databaseUrl: string) {
    const client = loadPrismaClient();
    this.prisma = new client.PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }

  async init(): Promise<void> {
    await this.prisma.$connect();
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async () => fn());
  }

  readonly runs: RunStore = {
    create: async (run: AgentRun): Promise<AgentRun> => {
      await this.prisma.run.create({ data: runToRow(run) });
      return run;
    },
    get: async (runId: string): Promise<AgentRun | undefined> => {
      const row = await this.prisma.run.findUnique({ where: { id: runId } });
      return row ? rowToRun(row) : undefined;
    },
    update: async (run: AgentRun, expectedVersion?: number): Promise<AgentRun> => {
      if (expectedVersion !== undefined) {
        const result = await this.prisma.run.updateMany({
          where: { id: run.id, stateVersion: expectedVersion },
          data: runToRow(run),
        });
        if (result.count === 0) {
          const existing = await this.prisma.run.findUnique({ where: { id: run.id }, select: { stateVersion: true } });
          if (!existing) throw new NotFoundError('run', run.id);
          throw new ConcurrencyError(`Stale write rejected for run ${run.id}`, {
            runId: run.id,
            expectedVersion,
            actualVersion: existing.stateVersion,
          });
        }
        return run;
      }
      await this.prisma.run.update({ where: { id: run.id }, data: runToRow(run) });
      return run;
    },
    list: async (filter: RunListFilter = {}): Promise<Paginated<AgentRun>> => {
      const where: AnyRecord = {};
      if (filter.organizationId) where.organizationId = filter.organizationId;
      if (filter.projectId) where.projectId = filter.projectId;
      if (filter.agentId) where.agentId = filter.agentId;
      if (filter.parentRunId) where.parentRunId = filter.parentRunId;
      if (filter.status && filter.status.length > 0) where.status = { in: filter.status };
      const limit = filter.limit ?? 50;
      const offset = filter.offset ?? 0;
      const orderBy = { [filter.orderBy ?? 'createdAt']: filter.direction ?? 'desc' };
      const [rows, total] = await Promise.all([
        this.prisma.run.findMany({ where, orderBy, take: limit, skip: offset }),
        this.prisma.run.count({ where }),
      ]);
      return { items: rows.map(rowToRun), total, limit, offset };
    },
    delete: async (runId: string): Promise<void> => {
      await this.prisma.run.delete({ where: { id: runId } });
    },
    countActive: async (organizationId?: string): Promise<number> =>
      this.prisma.run.count({
        where: {
          ...(organizationId ? { organizationId } : {}),
          status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] },
        },
      }),
  };

  readonly events = {
    append: async (event: AgentEvent): Promise<void> => {
      await this.prisma.runEvent.create({
        data: {
          id: event.id,
          runId: event.runId,
          type: event.type,
          version: event.version,
          sequence: event.sequence,
          organizationId: event.organizationId,
          projectId: event.projectId,
          traceId: event.traceId,
          data: event.data,
          at: new Date(event.at),
        },
      });
    },
    list: async (runId: string, options: { afterSequence?: number; limit?: number } = {}): Promise<AgentEvent[]> => {
      const rows = await this.prisma.runEvent.findMany({
        where: { runId, sequence: { gt: options.afterSequence ?? 0 } },
        orderBy: { sequence: 'asc' },
        ...(options.limit === undefined ? {} : { take: options.limit }),
      });
      return rows.map(rowToEvent);
    },
    nextSequence: async (runId: string): Promise<number> => {
      const last = await this.prisma.runEvent.findFirst({ where: { runId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      return (last?.sequence ?? 0) + 1;
    },
  };

  readonly steps = {
    save: async (step: RunStepRecord): Promise<void> => {
      const data = {
        id: step.id,
        runId: step.runId,
        index: step.index,
        description: step.description,
        phase: step.phase,
        status: step.status,
        toolId: json(step.toolId),
        startedAt: date(step.startedAt),
        finishedAt: date(step.finishedAt),
        durationMs: json(step.durationMs),
        detail: json(step.detail),
        error: json(step.error),
      };
      await this.prisma.runStep.upsert({ where: { id: step.id }, create: data, update: data });
    },
    list: async (runId: string): Promise<RunStepRecord[]> => {
      const rows = await this.prisma.runStep.findMany({ where: { runId }, orderBy: { index: 'asc' } });
      return rows.map(
        (row: AnyRecord): RunStepRecord => ({
          id: row.id,
          runId: row.runId,
          index: row.index,
          description: row.description,
          phase: row.phase,
          status: row.status,
          ...(row.toolId ? { toolId: row.toolId } : {}),
          ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
          ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
          ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
          ...(row.detail === null ? {} : { detail: row.detail }),
          ...(row.error === null ? {} : { error: row.error }),
        }),
      );
    },
  };

  readonly actions: ActionJournal = {
    recordIntent: async (entry): Promise<JournalEntry> => {
      const sequence = await this.events.nextSequence(entry.runId).then(() => this.journalSequence(entry.runId));
      const data = {
        id: entry.id,
        runId: entry.runId,
        sequence,
        stepId: json(entry.stepId),
        toolId: entry.toolId,
        argumentsHash: entry.argumentsHash,
        arguments: entry.arguments ?? {},
        idempotencyKey: entry.idempotencyKey,
        idempotency: entry.idempotency,
        status: entry.status,
        attempt: entry.attempt,
        startedAt: new Date(entry.startedAt),
      };
      await this.prisma.runAction.create({ data });
      return { ...entry, sequence };
    },
    recordCommit: async (entry): Promise<JournalEntry> => {
      const existing = await this.prisma.runAction.findUnique({
        where: { runId_idempotencyKey: { runId: entry.runId, idempotencyKey: entry.idempotencyKey } },
      });
      if (!existing) throw new NotFoundError('journal entry', entry.idempotencyKey);
      const updated = await this.prisma.runAction.update({
        where: { id: existing.id },
        data: {
          status: entry.status,
          finishedAt: new Date(entry.finishedAt),
          result: json(entry.result),
          error: json(entry.error),
        },
      });
      return rowToJournal(updated);
    },
    findByKey: async (runId: string, idempotencyKey: string): Promise<JournalEntry | undefined> => {
      const row = await this.prisma.runAction.findUnique({
        where: { runId_idempotencyKey: { runId, idempotencyKey } },
      });
      return row ? rowToJournal(row) : undefined;
    },
    list: async (runId: string): Promise<JournalEntry[]> => {
      const rows = await this.prisma.runAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
      return rows.map(rowToJournal);
    },
    pending: async (runId: string): Promise<JournalEntry[]> => {
      const rows = await this.prisma.runAction.findMany({
        where: { runId, status: { in: ['pending', 'executing'] } },
        orderBy: { sequence: 'asc' },
      });
      return rows.map(rowToJournal);
    },
    lastCommitted: async (runId: string): Promise<JournalEntry | undefined> => {
      const row = await this.prisma.runAction.findFirst({
        where: { runId, status: { in: ['succeeded', 'failed', 'skipped'] } },
        orderBy: { sequence: 'desc' },
      });
      return row ? rowToJournal(row) : undefined;
    },
  };

  private async journalSequence(runId: string): Promise<number> {
    const last = await this.prisma.runAction.findFirst({ where: { runId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
    return (last?.sequence ?? 0) + 1;
  }

  readonly checkpoints: CheckpointStore = {
    save: async (checkpoint: Checkpoint): Promise<void> => {
      await this.prisma.checkpoint.create({
        data: {
          id: checkpoint.id,
          runId: checkpoint.runId,
          sequence: checkpoint.sequence,
          stateVersion: checkpoint.stateVersion,
          label: json(checkpoint.label),
          state: checkpoint.state,
          contextSnapshot: checkpoint.contextSnapshot,
          environmentSnapshot: json(checkpoint.environmentSnapshot),
          createdAt: new Date(checkpoint.createdAt),
        },
      });
    },
    latest: async (runId: string): Promise<Checkpoint | undefined> => {
      const row = await this.prisma.checkpoint.findFirst({ where: { runId }, orderBy: { sequence: 'desc' } });
      return row ? rowToCheckpoint(row) : undefined;
    },
    get: async (checkpointId: string): Promise<Checkpoint | undefined> => {
      const row = await this.prisma.checkpoint.findUnique({ where: { id: checkpointId } });
      return row ? rowToCheckpoint(row) : undefined;
    },
    list: async (runId: string): Promise<Checkpoint[]> => {
      const rows = await this.prisma.checkpoint.findMany({ where: { runId }, orderBy: { sequence: 'asc' } });
      return rows.map(rowToCheckpoint);
    },
    delete: async (checkpointId: string): Promise<void> => {
      await this.prisma.checkpoint.delete({ where: { id: checkpointId } });
    },
  };

  readonly states: AgentStateStore = {
    load: async (runId: string): Promise<SerializedAgentState | undefined> => {
      const row = await this.prisma.runStateSnapshot.findUnique({ where: { runId } });
      if (!row) return undefined;
      return {
        runId: row.runId,
        status: row.status,
        stateVersion: row.stateVersion,
        goal: row.goal,
        config: row.config,
        usage: row.usage,
        ...(row.plan === null ? {} : { plan: row.plan }),
        ...(row.currentStepId === null ? {} : { currentStepId: row.currentStepId }),
        observations: row.observations,
        context: row.context,
        committedActions: row.committed,
        ...(row.pendingAction === null ? {} : { pendingAction: row.pendingAction }),
      } as SerializedAgentState;
    },
    save: async (state: SerializedAgentState, expectedVersion?: number): Promise<void> => {
      const data = {
        runId: state.runId,
        status: state.status,
        stateVersion: state.stateVersion,
        goal: state.goal,
        config: state.config,
        usage: state.usage,
        plan: json(state.plan),
        currentStepId: json(state.currentStepId),
        observations: state.observations,
        context: state.context,
        committed: state.committedActions,
        pendingAction: json(state.pendingAction),
      };
      if (expectedVersion !== undefined) {
        const result = await this.prisma.runStateSnapshot.updateMany({
          where: { runId: state.runId, stateVersion: expectedVersion },
          data,
        });
        if (result.count === 0) {
          const exists = await this.prisma.runStateSnapshot.findUnique({ where: { runId: state.runId } });
          if (!exists) {
            await this.prisma.runStateSnapshot.create({ data });
            return;
          }
          throw new ConcurrencyError(`Stale state write rejected for run ${state.runId}`, {
            runId: state.runId,
            expectedVersion,
          });
        }
        return;
      }
      await this.prisma.runStateSnapshot.upsert({ where: { runId: state.runId }, create: data, update: data });
    },
  };

  readonly memory: MemoryStore = {
    write: async (entry: MemoryEntry): Promise<void> => {
      const data = {
        id: entry.id,
        organizationId: entry.scope.organizationId,
        projectId: json(entry.scope.projectId),
        runId: json(entry.scope.runId),
        agentId: json(entry.scope.agentId),
        type: entry.type,
        content: entry.content,
        value: json(entry.value),
        importance: entry.importance,
        confidence: entry.confidence,
        source: entry.source,
        trust: entry.trust,
        tags: entry.tags ?? [],
        metadata: json(entry.metadata),
        accessCount: entry.accessCount ?? 0,
        createdAt: new Date(entry.createdAt),
        expiresAt: entry.expiresAt === undefined ? null : new Date(entry.expiresAt),
        lastAccessedAt: date(entry.lastAccessedAt) ?? null,
      };
      await this.prisma.memoryEntry.upsert({ where: { id: entry.id }, create: data, update: data });
    },
    search: async (query: MemoryQuery): Promise<MemoryEntry[]> => {
      const where: AnyRecord = { organizationId: query.scope.organizationId };
      if (query.scope.projectId) where.projectId = query.scope.projectId;
      if (query.scope.runId) where.runId = query.scope.runId;
      if (query.scope.agentId) where.agentId = query.scope.agentId;
      if (query.types && query.types.length > 0) where.type = { in: query.types };
      if (query.minImportance !== undefined) where.importance = { gte: query.minImportance };
      if (query.tags && query.tags.length > 0) where.tags = { hasSome: query.tags };
      if (!query.includeExpired) where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }];
      if (query.text) where.content = { contains: query.text, mode: 'insensitive' };
      const orderBy =
        query.orderBy === 'importance' ? { importance: 'desc' } : { createdAt: 'desc' };
      const rows = await this.prisma.memoryEntry.findMany({ where, orderBy, take: query.limit ?? 20 });
      return rows.map(rowToMemory);
    },
    get: async (id: string): Promise<MemoryEntry | undefined> => {
      const row = await this.prisma.memoryEntry.findUnique({ where: { id } });
      return row ? rowToMemory(row) : undefined;
    },
    delete: async (id: string): Promise<void> => {
      await this.prisma.memoryEntry.delete({ where: { id } });
    },
    clear: async (scope: MemoryScope): Promise<number> => {
      const result = await this.prisma.memoryEntry.deleteMany({ where: scopeFilter(scope) });
      return result.count;
    },
    prune: async (now = Date.now()): Promise<number> => {
      const result = await this.prisma.memoryEntry.deleteMany({ where: { expiresAt: { lte: new Date(now) } } });
      return result.count;
    },
  };

  readonly approvals: ApprovalStore = {
    create: async (approval: Approval): Promise<void> => {
      await this.prisma.approval.create({ data: approvalToRow(approval) });
    },
    get: async (id: string): Promise<Approval | undefined> => {
      const row = await this.prisma.approval.findUnique({ where: { id } });
      return row ? rowToApproval(row) : undefined;
    },
    update: async (approval: Approval): Promise<void> => {
      await this.prisma.approval.update({ where: { id: approval.id }, data: approvalToRow(approval) });
    },
    list: async (filter): Promise<Approval[]> => {
      const where: AnyRecord = {};
      if (filter.runId) where.runId = filter.runId;
      if (filter.organizationId) where.organizationId = filter.organizationId;
      if (filter.status) where.status = filter.status;
      const rows = await this.prisma.approval.findMany({ where, orderBy: { requestedAt: 'desc' } });
      return rows.map(rowToApproval);
    },
    pending: async (organizationId?: string): Promise<Approval[]> => {
      const rows = await this.prisma.approval.findMany({
        where: { status: 'pending', ...(organizationId ? { organizationId } : {}) },
        orderBy: { requestedAt: 'asc' },
      });
      return rows.map(rowToApproval);
    },
  };

  readonly artifacts = {
    save: async (artifact: ArtifactRecord): Promise<void> => {
      await this.prisma.artifact.create({
        data: { ...artifact, createdAt: new Date(artifact.createdAt) },
      });
    },
    list: async (runId: string): Promise<ArtifactRecord[]> => {
      const rows = await this.prisma.artifact.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
      return rows.map((row: AnyRecord) => ({ ...row, createdAt: row.createdAt.getTime() })) as ArtifactRecord[];
    },
    get: async (artifactId: string): Promise<ArtifactRecord | undefined> => {
      const row = await this.prisma.artifact.findUnique({ where: { id: artifactId } });
      return row ? ({ ...row, createdAt: row.createdAt.getTime() } as ArtifactRecord) : undefined;
    },
  };

  readonly usage = {
    record: async (usage: ModelUsageRecord): Promise<void> => {
      await this.prisma.modelUsage.create({
        data: {
          id: usage.id,
          runId: usage.runId,
          organizationId: usage.organizationId,
          projectId: usage.projectId,
          provider: usage.provider,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: json(usage.cachedInputTokens),
          reasoningTokens: json(usage.reasoningTokens),
          latencyMs: usage.latencyMs,
          costUsd: json(usage.costUsd),
          success: usage.success,
          at: new Date(usage.at),
        },
      });
    },
    listByRun: async (runId: string): Promise<ModelUsageRecord[]> => {
      const rows = await this.prisma.modelUsage.findMany({ where: { runId }, orderBy: { at: 'asc' } });
      return rows.map(rowToUsage);
    },
    listByOrganization: async (
      organizationId: string,
      options: { since?: number; until?: number } = {},
    ): Promise<ModelUsageRecord[]> => {
      const at: AnyRecord = {};
      if (options.since !== undefined) at.gte = new Date(options.since);
      if (options.until !== undefined) at.lte = new Date(options.until);
      const rows = await this.prisma.modelUsage.findMany({
        where: { organizationId, ...(Object.keys(at).length > 0 ? { at } : {}) },
        orderBy: { at: 'asc' },
      });
      return rows.map(rowToUsage);
    },
  };

  readonly counters = {
    saveUsage: async (runId: string, usage: RunUsage): Promise<void> => {
      await this.prisma.run.update({ where: { id: runId }, data: { usage } });
    },
    getUsage: async (runId: string): Promise<RunUsage | undefined> => {
      const row = await this.prisma.run.findUnique({ where: { id: runId }, select: { usage: true } });
      return (row?.usage as RunUsage | undefined) ?? undefined;
    },
  };

  readonly failures = {
    save: async (failure: FailureRecord): Promise<void> => {
      await this.prisma.failure.create({
        data: { ...failure, at: new Date(failure.at), detail: json(failure.detail), stepId: json(failure.stepId), toolId: json(failure.toolId) },
      });
    },
    list: async (runId: string): Promise<FailureRecord[]> => {
      const rows = await this.prisma.failure.findMany({ where: { runId }, orderBy: { at: 'asc' } });
      return rows.map((row: AnyRecord) => ({ ...row, at: row.at.getTime() })) as FailureRecord[];
    },
  };

  readonly recoveries = {
    save: async (attempt: RecoveryAttemptRecord): Promise<void> => {
      await this.prisma.recoveryAttempt.create({
        data: {
          ...attempt,
          at: new Date(attempt.at),
          failureId: json(attempt.failureId),
          result: json(attempt.result),
        },
      });
    },
    list: async (runId: string): Promise<RecoveryAttemptRecord[]> => {
      const rows = await this.prisma.recoveryAttempt.findMany({ where: { runId }, orderBy: { at: 'asc' } });
      return rows.map((row: AnyRecord) => ({ ...row, at: row.at.getTime() })) as RecoveryAttemptRecord[];
    },
  };

  readonly invocations = {
    save: async (invocation: ToolInvocationRecord): Promise<void> => {
      await this.prisma.toolInvocation.create({ data: { ...invocation, at: new Date(invocation.at) } });
    },
    list: async (runId: string): Promise<ToolInvocationRecord[]> => {
      const rows = await this.prisma.toolInvocation.findMany({ where: { runId } });
      return rows.map((row: AnyRecord) => ({ ...row, at: row.at.getTime() })) as ToolInvocationRecord[];
    },
  };

  readonly policyDecisions = {
    save: async (decision: PolicyDecisionRecord): Promise<void> => {
      await this.prisma.policyDecision.create({ data: { ...decision, at: new Date(decision.at), actionId: json(decision.actionId) } });
    },
    list: async (runId: string): Promise<PolicyDecisionRecord[]> => {
      const rows = await this.prisma.policyDecision.findMany({ where: { runId } });
      return rows.map((row: AnyRecord) => ({ ...row, at: row.at.getTime() })) as PolicyDecisionRecord[];
    },
  };

  readonly agentDefinitions = {
    save: async (definition: AgentDefinitionRecord): Promise<void> => {
      const agent = await this.prisma.agent.upsert({
        where: { id: definition.id },
        create: {
          id: definition.id,
          organizationId: definition.organizationId,
          projectId: definition.projectId,
          name: definition.name,
        },
        update: { name: definition.name },
      });
      await this.prisma.agentVersion.upsert({
        where: { agentId_version: { agentId: agent.id, version: definition.version } },
        create: {
          agentId: agent.id,
          version: definition.version,
          source: definition.source,
          definition: definition.definition,
          hash: definition.hash,
          createdAt: new Date(definition.createdAt),
        },
        update: { definition: definition.definition, hash: definition.hash, source: definition.source },
      });
    },
    get: async (organizationId: string, agentId: string, version?: string): Promise<AgentDefinitionRecord | undefined> => {
      const agent = await this.prisma.agent.findFirst({ where: { id: agentId, organizationId } });
      if (!agent) return undefined;
      const row = await this.prisma.agentVersion.findFirst({
        where: { agentId: agent.id, ...(version ? { version } : {}) },
        orderBy: { createdAt: 'desc' },
      });
      if (!row) return undefined;
      return {
        id: agent.id,
        organizationId,
        projectId: agent.projectId,
        version: row.version,
        name: agent.name,
        source: row.source,
        definition: row.definition,
        hash: row.hash,
        createdAt: row.createdAt.getTime(),
      };
    },
    list: async (organizationId: string, projectId?: string): Promise<AgentDefinitionRecord[]> => {
      const agents = await this.prisma.agent.findMany({
        where: { organizationId, ...(projectId ? { projectId } : {}) },
        include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      const out: AgentDefinitionRecord[] = [];
      for (const agent of agents) {
        const version = agent.versions[0];
        if (!version) continue;
        out.push({
          id: agent.id,
          organizationId,
          projectId: agent.projectId,
          version: version.version,
          name: agent.name,
          source: version.source,
          definition: version.definition,
          hash: version.hash,
          createdAt: version.createdAt.getTime(),
        });
      }
      return out;
    },
  };

  readonly identity: IdentityStore = {
    organizations: {
      save: async (organization: Organization): Promise<void> => {
        const data = {
          name: organization.name,
          slug: organization.slug,
          settings: json(organization.settings),
          createdAt: new Date(organization.createdAt),
        };
        await this.prisma.organization.upsert({
          where: { id: organization.id },
          create: { id: organization.id, ...data },
          update: data,
        });
      },
      get: async (id: string): Promise<Organization | undefined> => {
        const row = await this.prisma.organization.findUnique({ where: { id } });
        return row ? rowToOrganization(row) : undefined;
      },
      getBySlug: async (slug: string): Promise<Organization | undefined> => {
        const row = await this.prisma.organization.findUnique({ where: { slug } });
        return row ? rowToOrganization(row) : undefined;
      },
      list: async (): Promise<Organization[]> =>
        (await this.prisma.organization.findMany()).map(rowToOrganization),
    },
    projects: {
      save: async (project: Project): Promise<void> => {
        const data = {
          organizationId: project.organizationId,
          name: project.name,
          slug: project.slug,
          settings: json(project.settings),
          createdAt: new Date(project.createdAt),
        };
        await this.prisma.project.upsert({
          where: { id: project.id },
          create: { id: project.id, ...data },
          update: data,
        });
      },
      get: async (id: string): Promise<Project | undefined> => {
        const row = await this.prisma.project.findUnique({ where: { id } });
        return row ? rowToProject(row) : undefined;
      },
      getBySlug: async (organizationId: string, slug: string): Promise<Project | undefined> => {
        const row = await this.prisma.project.findUnique({
          where: { organizationId_slug: { organizationId, slug } },
        });
        return row ? rowToProject(row) : undefined;
      },
      list: async (organizationId: string): Promise<Project[]> =>
        (await this.prisma.project.findMany({ where: { organizationId } })).map(rowToProject),
    },
    users: {
      save: async (user: User): Promise<void> => {
        const data = {
          organizationId: user.organizationId,
          email: user.email,
          name: json(user.name),
          role: user.role,
          disabled: user.disabled === true,
          createdAt: new Date(user.createdAt),
        };
        await this.prisma.user.upsert({
          where: { id: user.id },
          create: { id: user.id, ...data },
          update: data,
        });
      },
      get: async (id: string): Promise<User | undefined> => {
        const row = await this.prisma.user.findUnique({ where: { id } });
        return row ? rowToUser(row) : undefined;
      },
      getByEmail: async (organizationId: string, email: string): Promise<User | undefined> => {
        const row = await this.prisma.user.findUnique({
          where: { organizationId_email: { organizationId, email } },
        });
        return row ? rowToUser(row) : undefined;
      },
      list: async (organizationId: string): Promise<User[]> =>
        (await this.prisma.user.findMany({ where: { organizationId } })).map(rowToUser),
    },
    apiKeys: {
      save: async (apiKey: ApiKey): Promise<void> => {
        const data = {
          organizationId: apiKey.organizationId,
          projectId: json(apiKey.projectId),
          name: apiKey.name,
          hash: apiKey.hash,
          prefix: apiKey.prefix,
          role: apiKey.role,
          createdAt: new Date(apiKey.createdAt),
          lastUsedAt: date(apiKey.lastUsedAt),
          expiresAt: date(apiKey.expiresAt),
          revokedAt: date(apiKey.revokedAt),
        };
        await this.prisma.apiKey.upsert({
          where: { id: apiKey.id },
          create: { id: apiKey.id, ...data },
          update: data,
        });
      },
      get: async (id: string): Promise<ApiKey | undefined> => {
        const row = await this.prisma.apiKey.findUnique({ where: { id } });
        return row ? rowToApiKey(row) : undefined;
      },
      getByPrefix: async (prefix: string): Promise<ApiKey | undefined> => {
        const row = await this.prisma.apiKey.findUnique({ where: { prefix } });
        return row ? rowToApiKey(row) : undefined;
      },
      list: async (organizationId: string): Promise<ApiKey[]> =>
        (await this.prisma.apiKey.findMany({ where: { organizationId } })).map(rowToApiKey),
    },
  };

  readonly webhooks: WebhookStore = {
    save: async (subscription: WebhookSubscriptionRecord): Promise<void> => {
      const data = {
        organizationId: subscription.organizationId,
        projectId: subscription.projectId,
        url: subscription.url,
        events: subscription.events,
        secret: subscription.secret,
        active: subscription.active,
        description: json(subscription.description),
        createdAt: new Date(subscription.createdAt),
        updatedAt: new Date(subscription.updatedAt),
      };
      await this.prisma.webhookSubscription.upsert({
        where: { id: subscription.id },
        create: { id: subscription.id, ...data },
        update: data,
      });
    },
    get: async (id: string): Promise<WebhookSubscriptionRecord | undefined> => {
      const row = await this.prisma.webhookSubscription.findUnique({ where: { id } });
      return row ? rowToWebhook(row) : undefined;
    },
    list: async (filter: WebhookListFilter = {}): Promise<WebhookSubscriptionRecord[]> => {
      const where: AnyRecord = {};
      if (filter.organizationId) where.organizationId = filter.organizationId;
      if (filter.projectId) where.projectId = filter.projectId;
      if (filter.active !== undefined) where.active = filter.active;
      const rows = await this.prisma.webhookSubscription.findMany({ where, orderBy: { createdAt: 'asc' } });
      return rows.map(rowToWebhook);
    },
    remove: async (id: string): Promise<void> => {
      await this.prisma.webhookSubscription.deleteMany({ where: { id } });
    },
    recordDelivery: async (delivery: WebhookDeliveryRecord): Promise<void> => {
      await this.prisma.webhookDelivery.create({
        data: {
          id: delivery.id,
          subscriptionId: delivery.subscriptionId,
          organizationId: delivery.organizationId,
          eventId: delivery.eventId,
          eventType: delivery.eventType,
          runId: json(delivery.runId),
          url: delivery.url,
          status: delivery.status,
          attempts: delivery.attempts,
          responseStatus: json(delivery.responseStatus),
          error: json(delivery.error),
          durationMs: delivery.durationMs,
          at: new Date(delivery.at),
        },
      });
    },
    listDeliveries: async (
      subscriptionId: string,
      options: { limit?: number } = {},
    ): Promise<WebhookDeliveryRecord[]> => {
      const rows = await this.prisma.webhookDelivery.findMany({
        where: { subscriptionId },
        orderBy: { at: 'desc' },
        take: options.limit ?? 50,
      });
      return rows.map(rowToWebhookDelivery);
    },
  };

  readonly policyDefinitions = {
    save: async (definition: PolicyDefinitionRecord): Promise<void> => {
      const data = {
        organizationId: definition.organizationId,
        projectId: definition.projectId,
        name: definition.name,
        version: definition.version,
        definition: definition.definition,
        createdAt: new Date(definition.createdAt),
      };
      await this.prisma.policy.upsert({
        where: { id: definition.id },
        create: { id: definition.id, ...data },
        update: data,
      });
    },
    list: async (organizationId: string, projectId?: string): Promise<PolicyDefinitionRecord[]> => {
      const rows = await this.prisma.policy.findMany({
        where: { organizationId, ...(projectId ? { projectId } : {}) },
        orderBy: { version: 'desc' },
      });
      return rows.map((row: AnyRecord) => ({
        id: row.id,
        organizationId: row.organizationId,
        projectId: row.projectId,
        name: row.name,
        version: row.version,
        definition: row.definition,
        createdAt: row.createdAt.getTime(),
      }));
    },
    remove: async (id: string): Promise<void> => {
      await this.prisma.policy.delete({ where: { id } });
    },
  };
}

function rowToWebhook(row: AnyRecord): WebhookSubscriptionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    url: row.url,
    events: [...(row.events ?? [])],
    secret: row.secret,
    active: row.active,
    ...(row.description === null || row.description === undefined ? {} : { description: row.description }),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function rowToWebhookDelivery(row: AnyRecord): WebhookDeliveryRecord {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    organizationId: row.organizationId,
    eventId: row.eventId,
    eventType: row.eventType,
    ...(row.runId === null || row.runId === undefined ? {} : { runId: row.runId }),
    url: row.url,
    status: row.status === 'delivered' ? 'delivered' : 'failed',
    attempts: row.attempts,
    ...(row.responseStatus === null || row.responseStatus === undefined
      ? {}
      : { responseStatus: row.responseStatus }),
    ...(row.error === null || row.error === undefined ? {} : { error: row.error }),
    durationMs: row.durationMs,
    at: row.at.getTime(),
  };
}

function rowToOrganization(row: AnyRecord): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt.getTime(),
    ...(row.settings ? { settings: row.settings } : {}),
  };
}

function rowToProject(row: AnyRecord): Project {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt.getTime(),
    ...(row.settings ? { settings: row.settings } : {}),
  };
}

function rowToUser(row: AnyRecord): User {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    ...(row.name ? { name: row.name } : {}),
    role: row.role,
    createdAt: row.createdAt.getTime(),
    ...(row.disabled ? { disabled: true } : {}),
  };
}

function rowToApiKey(row: AnyRecord): ApiKey {
  return {
    id: row.id,
    organizationId: row.organizationId,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    name: row.name,
    hash: row.hash,
    prefix: row.prefix,
    role: row.role,
    createdAt: row.createdAt.getTime(),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.getTime() } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.getTime() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.getTime() } : {}),
  };
}

function scopeFilter(scope: MemoryScope): AnyRecord {
  const where: AnyRecord = { organizationId: scope.organizationId };
  if (scope.projectId) where.projectId = scope.projectId;
  if (scope.runId) where.runId = scope.runId;
  if (scope.agentId) where.agentId = scope.agentId;
  return where;
}

function runToRow(run: AgentRun): AnyRecord {
  return {
    id: run.id,
    organizationId: run.organizationId,
    projectId: run.projectId,
    agentId: run.agentId,
    goal: run.goal,
    status: run.status,
    stateVersion: run.stateVersion,
    config: run.config,
    limits: run.limits,
    usage: run.usage,
    plan: json(run.plan),
    currentStepId: json(run.currentStepId),
    parentRunId: json(run.parentRunId),
    rootRunId: run.rootRunId,
    traceId: run.traceId,
    workspaceDir: run.workspaceDir,
    error: json(run.error),
    labels: json(run.labels),
    metadata: json(run.metadata),
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
    startedAt: date(run.startedAt) ?? null,
    finishedAt: date(run.finishedAt) ?? null,
  };
}

function rowToRun(row: AnyRecord): AgentRun {
  return {
    id: row.id,
    goal: row.goal,
    agentId: row.agentId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    status: row.status,
    stateVersion: row.stateVersion,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
    config: row.config,
    limits: row.limits,
    usage: row.usage,
    ...(row.plan === null ? {} : { plan: row.plan }),
    ...(row.currentStepId === null ? {} : { currentStepId: row.currentStepId }),
    ...(row.parentRunId === null ? {} : { parentRunId: row.parentRunId }),
    rootRunId: row.rootRunId,
    traceId: row.traceId,
    workspaceDir: row.workspaceDir,
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.labels === null ? {} : { labels: row.labels }),
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
  };
}

function rowToEvent(row: AnyRecord): AgentEvent {
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    runId: row.runId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    sequence: row.sequence,
    at: row.at.getTime(),
    ...(row.traceId === null ? {} : { traceId: row.traceId }),
    data: row.data ?? {},
  };
}

function rowToJournal(row: AnyRecord): JournalEntry {
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    actionId: row.id,
    idempotencyKey: row.idempotencyKey,
    toolId: row.toolId,
    idempotency: row.idempotency,
    argumentsHash: row.argumentsHash,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.startedAt.getTime(),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.stepId === null ? {} : { stepId: row.stepId }),
  };
}

function rowToCheckpoint(row: AnyRecord): Checkpoint {
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    stateVersion: row.stateVersion,
    state: row.state,
    contextSnapshot: row.contextSnapshot,
    ...(row.environmentSnapshot === null ? {} : { environmentSnapshot: row.environmentSnapshot }),
    ...(row.label === null ? {} : { label: row.label }),
    createdAt: row.createdAt.getTime(),
  };
}

function rowToMemory(row: AnyRecord): MemoryEntry {
  return {
    id: row.id,
    type: row.type,
    scope: {
      organizationId: row.organizationId,
      ...(row.projectId === null ? {} : { projectId: row.projectId }),
      ...(row.runId === null ? {} : { runId: row.runId }),
      ...(row.agentId === null ? {} : { agentId: row.agentId }),
    },
    content: row.content,
    ...(row.value === null ? {} : { value: row.value }),
    importance: row.importance,
    confidence: row.confidence,
    source: row.source,
    trust: row.trust,
    createdAt: row.createdAt.getTime(),
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt.getTime() }),
    ...(row.lastAccessedAt === null ? {} : { lastAccessedAt: row.lastAccessedAt.getTime() }),
    accessCount: row.accessCount,
    tags: row.tags ?? [],
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
  };
}

function approvalToRow(approval: Approval): AnyRecord {
  return {
    id: approval.id,
    runId: approval.runId,
    organizationId: approval.organizationId,
    projectId: approval.projectId,
    actionId: approval.actionId,
    toolId: approval.toolId,
    arguments: approval.arguments,
    actionHash: approval.actionHash,
    risk: approval.risk,
    reason: approval.reason,
    summary: approval.summary,
    status: approval.status,
    requestedAt: new Date(approval.requestedAt),
    decidedAt: date(approval.decidedAt) ?? null,
    decidedBy: json(approval.decidedBy) ?? null,
    decisionReason: json(approval.decisionReason) ?? null,
    modifiedArguments: json(approval.modifiedArguments) ?? null,
    expiresAt: approval.expiresAt === undefined ? null : new Date(approval.expiresAt),
    metadata: json(approval.metadata) ?? null,
  };
}

function rowToApproval(row: AnyRecord): Approval {
  return {
    id: row.id,
    runId: row.runId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    actionId: row.actionId,
    toolId: row.toolId,
    arguments: row.arguments,
    actionHash: row.actionHash,
    risk: row.risk,
    reason: row.reason,
    summary: row.summary,
    status: row.status,
    requestedAt: row.requestedAt.getTime(),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.getTime() } : {}),
    ...(row.decidedBy ? { decidedBy: row.decidedBy } : {}),
    ...(row.decisionReason ? { decisionReason: row.decisionReason } : {}),
    ...(row.modifiedArguments === null ? {} : { modifiedArguments: row.modifiedArguments }),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.getTime() } : {}),
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
  };
}

function rowToUsage(row: AnyRecord): ModelUsageRecord {
  return {
    id: row.id,
    runId: row.runId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    ...(row.cachedInputTokens === null ? {} : { cachedInputTokens: row.cachedInputTokens }),
    ...(row.reasoningTokens === null ? {} : { reasoningTokens: row.reasoningTokens }),
    latencyMs: row.latencyMs,
    ...(row.costUsd === null ? {} : { costUsd: Number(row.costUsd) }),
    success: row.success,
    at: row.at.getTime(),
  };
}
