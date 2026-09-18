import type {
  ActionJournal,
  AgentRun,
  AgentStateStore,
  AgentEvent,
  Approval,
  ApprovalStore,
  Checkpoint,
  CheckpointStore,
  MemoryEntry,
  MemoryQuery,
  MemoryScope,
  ApiKey,
  MemoryStore,
  Organization,
  Project,
  RunUsage,
  User,
} from '@kazi-ai/agentos-core';
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
  WebhookStore,
} from './records.js';

export interface RunStore {
  create(run: AgentRun): Promise<AgentRun>;
  get(runId: string): Promise<AgentRun | undefined>;
  /** Optimistic update: fails if the stored stateVersion differs from expected. */
  update(run: AgentRun, expectedVersion?: number): Promise<AgentRun>;
  list(filter?: RunListFilter): Promise<Paginated<AgentRun>>;
  delete(runId: string): Promise<void>;
  countActive(organizationId?: string): Promise<number>;
}

export interface EventStore {
  append(event: AgentEvent): Promise<void>;
  list(runId: string, options?: { afterSequence?: number; limit?: number }): Promise<AgentEvent[]>;
  /** Next sequence number for a run. */
  nextSequence(runId: string): Promise<number>;
}

export interface StepStore {
  save(step: RunStepRecord): Promise<void>;
  list(runId: string): Promise<RunStepRecord[]>;
}

export interface ArtifactStore {
  save(artifact: ArtifactRecord): Promise<void>;
  list(runId: string): Promise<ArtifactRecord[]>;
  get(artifactId: string): Promise<ArtifactRecord | undefined>;
}

export interface UsageStore {
  record(usage: ModelUsageRecord): Promise<void>;
  listByRun(runId: string): Promise<ModelUsageRecord[]>;
  listByOrganization(organizationId: string, options?: { since?: number; until?: number }): Promise<ModelUsageRecord[]>;
}

export interface FailureStore {
  save(failure: FailureRecord): Promise<void>;
  list(runId: string): Promise<FailureRecord[]>;
}

export interface RecoveryStore {
  save(attempt: RecoveryAttemptRecord): Promise<void>;
  list(runId: string): Promise<RecoveryAttemptRecord[]>;
}

export interface ToolInvocationStore {
  save(invocation: ToolInvocationRecord): Promise<void>;
  list(runId: string): Promise<ToolInvocationRecord[]>;
}

export interface PolicyDecisionStore {
  save(decision: PolicyDecisionRecord): Promise<void>;
  list(runId: string): Promise<PolicyDecisionRecord[]>;
}

export interface AgentDefinitionStore {
  save(definition: AgentDefinitionRecord): Promise<void>;
  get(organizationId: string, agentId: string, version?: string): Promise<AgentDefinitionRecord | undefined>;
  list(organizationId: string, projectId?: string): Promise<AgentDefinitionRecord[]>;
}

export interface PolicyDefinitionStore {
  save(definition: PolicyDefinitionRecord): Promise<void>;
  list(organizationId: string, projectId?: string): Promise<PolicyDefinitionRecord[]>;
  remove(id: string): Promise<void>;
}

export interface UsageCounterStore {
  /** Per-run usage snapshot, kept separately from the run row for fast reads. */
  saveUsage(runId: string, usage: RunUsage): Promise<void>;
  getUsage(runId: string): Promise<RunUsage | undefined>;
}

/**
 * The persistence surface the runtime depends on. Both the embedded driver and
 * the Postgres/Prisma driver satisfy it, so the runtime is storage-agnostic.
 */
export interface AgentOSStore {
  readonly driver: string;
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;

  runs: RunStore;
  events: EventStore;
  steps: StepStore;
  actions: ActionJournal;
  checkpoints: CheckpointStore;
  states: AgentStateStore;
  memory: MemoryStore;
  approvals: ApprovalStore;
  artifacts: ArtifactStore;
  usage: UsageStore;
  counters: UsageCounterStore;
  failures: FailureStore;
  recoveries: RecoveryStore;
  invocations: ToolInvocationStore;
  policyDecisions: PolicyDecisionStore;
  agentDefinitions: AgentDefinitionStore;
  policyDefinitions: PolicyDefinitionStore;
  identity: IdentityStore;
  webhooks: WebhookStore;

  /** Escape hatch for tests and one-off queries. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Tenants, users and API keys (spec §64, §65, §79). Every other record carries
 * `organizationId`; this is where those organizations are defined.
 */
export interface IdentityStore {
  organizations: {
    save(organization: Organization): Promise<void>;
    get(id: string): Promise<Organization | undefined>;
    getBySlug(slug: string): Promise<Organization | undefined>;
    list(): Promise<Organization[]>;
  };
  projects: {
    save(project: Project): Promise<void>;
    get(id: string): Promise<Project | undefined>;
    getBySlug(organizationId: string, slug: string): Promise<Project | undefined>;
    list(organizationId: string): Promise<Project[]>;
  };
  users: {
    save(user: User): Promise<void>;
    get(id: string): Promise<User | undefined>;
    getByEmail(organizationId: string, email: string): Promise<User | undefined>;
    list(organizationId: string): Promise<User[]>;
  };
  apiKeys: {
    save(apiKey: ApiKey): Promise<void>;
    get(id: string): Promise<ApiKey | undefined>;
    /** Lookup by the visible key prefix, used to authenticate a request. */
    getByPrefix(prefix: string): Promise<ApiKey | undefined>;
    list(organizationId: string): Promise<ApiKey[]>;
  };
}

export interface CreateStoreOptions {
  driver?: 'memory' | 'postgres';
  databaseUrl?: string;
  /** Directory for the embedded driver's durable files. */
  dataDir?: string;
}

export type { AgentRun, AgentEvent, Approval, Checkpoint, MemoryEntry, MemoryQuery, MemoryScope, RunUsage };

