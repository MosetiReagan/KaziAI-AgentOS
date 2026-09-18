// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import type { AgentRun, Approval } from '../src/api/types.js';
import { AppProvider } from '../src/AppContext.js';
import { ApprovalsPage } from '../src/pages/Approvals.js';
import { OverviewPage } from '../src/pages/Overview.js';
import { RunsPage } from '../src/pages/Runs.js';

/**
 * These tests drive the console against a stubbed control plane, so the page's
 * own logic (what it asks for, what it shows, what a click sends) is what is
 * under test rather than a live server.
 */

/**
 * `AgentRun['id']` is a branded `RunId` on the wire; a test fixture wants to
 * write `'run_live'`, so the helper takes plain strings and brands them on the
 * way out rather than making every call site cast.
 */
function run(overrides: Partial<Omit<AgentRun, 'id'>> & { id?: string } = {}): AgentRun {
  return {
    id: 'run_1' as AgentRun['id'],
    goal: 'Fix the failing tests in this repository.',
    agentId: 'developer',
    organizationId: 'org_1',
    projectId: 'prj_1',
    status: 'COMPLETED',
    stateVersion: 3,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 30_000,
    startedAt: Date.now() - 59_000,
    finishedAt: Date.now() - 30_000,
    config: {
      agentId: 'developer',
      model: 'stub-model',
      provider: 'stub',
      tools: ['filesystem'],
      limits: { maxSteps: 10 },
      permissions: {},
      memoryEnabled: false,
      planningEnabled: true,
      verificationEnabled: true,
      recoveryEnabled: true,
    },
    limits: { maxSteps: 10, maxCostUsd: 5 },
    usage: {
      steps: 5,
      toolCalls: 4,
      tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      costUsd: 0.071,
      networkRequests: 0,
      storageBytes: 0,
      durationMs: 43_800,
      recoveryCount: 1,
      checkpointCount: 2,
      modelCalls: 3,
    },
    rootRunId: 'run_1',
    traceId: 'trace_1',
    workspaceDir: '/workspaces/org_1/run_1',
    ...overrides,
  } as unknown as AgentRun;
}

const pendingApproval = {
  id: 'apr_1',
  runId: 'run_1',
  organizationId: 'org_1',
  projectId: 'prj_1',
  actionId: 'action_1',
  toolId: 'git.push',
  arguments: { operation: 'push', remote: 'origin', branch: 'main' },
  risk: 'CRITICAL',
  reason: 'Agent requested permission to push changes.',
  summary: 'git push origin main',
  status: 'pending',
  requestedAt: Date.now() - 5_000,
  actionHash: 'abcdef0123456789',
} as unknown as Approval;

function stubApi(handlers: Record<string, (init: RequestInit | undefined, url: string) => unknown>) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    const key = Object.keys(handlers).find((pattern) => url.startsWith(pattern));
    if (key === undefined) throw new Error(`unexpected request: ${method} ${url}`);
    const handler = handlers[key];
    if (handler === undefined) throw new Error('no handler');
    const result = handler(init, url);
    return new Response(JSON.stringify(result ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  globalThis.localStorage?.clear();
  return { calls, fetchImpl };
}

function renderPage(node: React.ReactNode, fetchImpl: typeof fetch) {
  const client = new ApiClient({ baseUrl: '', fetchImpl });
  return render(
    <MemoryRouter>
      <AppProvider client={client}>{node}</AppProvider>
    </MemoryRouter>,
  );
}

describe('the overview page', () => {
  it('counts runs by state and shows the running ones', async () => {
    const { fetchImpl } = stubApi({
      '/api/runs': () => ({
        items: [
          run({ id: 'run_live', status: 'EXECUTING' }),
          run({ id: 'run_done', status: 'COMPLETED' }),
          run({ id: 'run_bad', status: 'FAILED', error: { message: 'verification failed' } }),
        ],
        total: 3,
      }),
      '/api/approvals': () => ({ items: [pendingApproval] }),
      '/api/agents': () => ({ items: [] }),
      '/api/tools': () => ({ items: [] }),
      '/api/providers': () => ({ items: [] }),
      '/api/info': () => ({ info: { dataDir: '/tmp/.kazi', driver: 'memory', agents: 0 } }),
    });
    renderPage(<OverviewPage />, fetchImpl);

    await waitFor(() => expect(screen.getByText('Overview')).toBeDefined());
    expect(await screen.findByText('run_live')).toBeDefined();
    expect(screen.getByText('Waiting on a human')).toBeDefined();
    expect(screen.getByText('verification failed')).toBeDefined();
    expect(screen.getByText('$0.213')).toBeDefined(); // three runs at $0.071
  });
});

describe('the runs page', () => {
  it('sends the filter to the API and renders what comes back', async () => {
    const { calls, fetchImpl } = stubApi({
      '/api/runs': () => ({ items: [run({ id: 'run_filtered' })], total: 1 }),
      '/api/agents': () => ({ items: [{ id: 'developer', version: '1.0.0', model: { provider: 'stub', model: 'm' }, tools: [], source: 'file' }] }),
    });
    renderPage(<RunsPage />, fetchImpl);
    await waitFor(() => expect(screen.getByText('run_filtered')).toBeDefined());
    expect(calls.some((call) => call.url.startsWith('/api/runs?limit=100'))).toBe(true);
  });
});

describe('the approvals page', () => {
  it('shows the risk and the arguments, and sends the decision to the API', async () => {
    const decisions: { url: string; body: unknown }[] = [];
    const { fetchImpl } = stubApi({
      '/api/approvals/apr_1/deny': (init) => {
        decisions.push({ url: '/api/approvals/apr_1/deny', body: init?.body });
        return { approval: { ...pendingApproval, status: 'denied' } };
      },
      // The pending queue is asked for first and explicitly; history is empty.
      '/api/approvals?limit=100&status=pending': () => ({ items: [pendingApproval] }),
      '/api/approvals': () => ({ items: [] }),
    });
    renderPage(<ApprovalsPage />, fetchImpl);

    await waitFor(() => expect(screen.getByText('git push origin main')).toBeDefined());
    expect(screen.getByText('CRITICAL')).toBeDefined();
    expect(screen.getByText(/Agent requested permission to push changes/)).toBeDefined();
    expect(screen.getByText(/fingerprinted as abcdef012345/)).toBeDefined();

    screen.getByText('Deny').click();
    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(JSON.parse(String(decisions[0]?.body))).toEqual({});
  });
});
