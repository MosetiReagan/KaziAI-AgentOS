import { followRun, type RunStreamHandlers } from '../lib/stream.js';
import type {
  AgentEvent,
  AgentRun,
  AgentState,
  AgentSummary,
  Approval,
  ArtifactRecord,
  Checkpoint,
  CheckpointRef,
  FailureRecord,
  Identity,
  MemoryEntry,
  MemorySummary,
  Page,
  PolicyDecisionRecord,
  PolicyRuleView,
  Principal,
  ProviderSummary,
  RecoveryAttemptRecord,
  RiskRuleView,
  RunLimits,
  RunResult,
  RuntimeInfo,
  StepRecord,
  ToolInvocationRecord,
  ToolSummary,
  Trace,
} from './types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Origin of the API. Empty (the default) means the same origin. */
  baseUrl?: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
}

export type ListRunsQuery = {
  status?: string;
  agentId?: string;
  parentRunId?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'updatedAt';
  direction?: 'asc' | 'desc';
};

/**
 * A thin, typed client over the control plane. It holds no state of its own —
 * the run's state lives in the store and is re-read, never mirrored (spec §103).
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | null;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/$/, '');
    this.token = options.token ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  get currentToken(): string | null {
    return this.token;
  }

  get origin(): string {
    return this.baseUrl;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await response.text();
    const payload: unknown = text.length === 0 ? undefined : safeJson(text);
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; detail?: unknown } })
        ?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'HTTP_ERROR',
        error?.message ?? `Request failed with ${response.status}`,
        error?.detail,
      );
    }
    return payload as T;
  }

  private query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    // Sorted keys, so the same query always produces the same URL — easier to
    // read in a log, and safe to use as a cache key.
    for (const [key, value] of Object.entries(params).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (value === undefined || value === '') continue;
      search.set(key, String(value));
    }
    const encoded = search.toString();
    return encoded.length === 0 ? '' : `?${encoded}`;
  }

  // Runs.
  listRuns(query: ListRunsQuery = {}): Promise<Page<AgentRun>> {
    return this.request(`/api/runs${this.query({ ...query })}`);
  }

  getRun(runId: string): Promise<{ run: AgentRun }> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}`);
  }

  createRun(input: {
    agentId: string;
    goal: string;
    limits?: RunLimits;
    labels?: Record<string, string>;
    start?: boolean;
  }): Promise<{ run: AgentRun }> {
    return this.request('/api/runs', { method: 'POST', body: JSON.stringify(input) });
  }

  runAction(
    runId: string,
    action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry',
  ): Promise<{ run: AgentRun }> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST' });
  }

  checkpoint(runId: string): Promise<{ checkpoint: Checkpoint; run: AgentRun }> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/checkpoint`, { method: 'POST' });
  }

  fork(runId: string, body: { checkpointId?: string; goal?: string }): Promise<{ run: AgentRun }> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/fork`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  replay(runId: string, mode?: 'deterministic' | 'approximate' | 'simulation'): Promise<{ report: unknown }> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/replay`, {
      method: 'POST',
      body: JSON.stringify(mode === undefined ? {} : { mode }),
    });
  }

  getState(runId: string): Promise<{ state: AgentState }> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/state`);
  }

  getResult(runId: string): Promise<{ result: RunResult }> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/result`);
  }

  getTrace(runId: string): Promise<{ trace: Trace }> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/trace`);
  }

  listEvents(runId: string, query: { afterSequence?: number; limit?: number } = {}): Promise<Page<AgentEvent>> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/events${this.query({ ...query })}`);
  }

  listSteps(runId: string): Promise<Page<StepRecord>> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/steps`);
  }

  listCheckpoints(runId: string): Promise<Page<Checkpoint>> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/checkpoints`);
  }

  listArtifacts(runId: string): Promise<Page<ArtifactRecord>> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
  }

  listFailures(runId: string): Promise<Page<FailureRecord>> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/failures`);
  }

  listRecoveries(runId: string): Promise<Page<RecoveryAttemptRecord>> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/recoveries`);
  }

  listJournal(runId: string): Promise<Page<ToolInvocationRecord>> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/journal`);
  }

  listDecisions(runId: string): Promise<Page<PolicyDecisionRecord>> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/decisions`);
  }

  follow(runId: string, handlers: RunStreamHandlers & { afterSequence?: number; signal?: AbortSignal }): Promise<void> {
    return followRun({
      runId,
      baseUrl: this.baseUrl,
      token: this.token,
      fetchImpl: this.fetchImpl,
      ...handlers,
    });
  }

  // Approvals.
  listApprovals(query: { runId?: string; status?: string; limit?: number } = {}): Promise<Page<Approval>> {
    return this.request(`/api/approvals${this.query({ ...query })}`);
  }

  decideApproval(
    approvalId: string,
    decision: 'approve' | 'deny' | 'modify',
    body: { reason?: string; modifiedArguments?: unknown } = {},
  ): Promise<{ approval: Approval; run?: AgentRun }> {
    return this.request(`/api/approvals/${encodeURIComponent(approvalId)}/${decision}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // Catalog.
  listAgents(): Promise<Page<AgentSummary>> {
    return this.request('/api/agents');
  }

  listTools(): Promise<Page<ToolSummary>> {
    return this.request('/api/tools');
  }

  listProviders(): Promise<Page<ProviderSummary>> {
    return this.request('/api/providers');
  }

  listPolicies(): Promise<{ items: PolicyRuleView[]; riskRules: RiskRuleView[] }> {
    return this.request('/api/policies');
  }

  getInfo(): Promise<{ info: RuntimeInfo }> {
    return this.request('/api/info');
  }

  // Memory.
  listMemory(
    query: { runId?: string; type?: string; text?: string; minImportance?: number; limit?: number } = {},
  ): Promise<Page<MemoryEntry> & { summary: MemorySummary; scope: Record<string, string> }> {
    return this.request(`/api/memory${this.query({ ...query })}`);
  }

  forgetMemory(id: string): Promise<{ deleted: boolean; id: string }> {
    return this.request(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  pruneMemory(): Promise<{ removed: number }> {
    return this.request('/api/memory/prune', { method: 'POST' });
  }

  // Identity.
  whoami(): Promise<{ principal: Principal; organizationId: string; projectId: string }> {
    return this.request('/api/whoami');
  }

  identity(): Promise<Identity> {
    return this.request('/api/identity');
  }

  health(): Promise<{ status: string; service: string; time: number }> {
    return this.request('/health');
  }

  ready(): Promise<{ status: string; checks: Record<string, { ok: boolean; detail?: string }> }> {
    return this.request('/ready');
  }

  version(): Promise<{ name: string; version: string; runtime: string }> {
    return this.request('/version');
  }
}

function defaultBaseUrl(): string {
  const configured = import.meta.env?.VITE_API_URL;
  return typeof configured === 'string' ? configured : '';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type { CheckpointRef };
