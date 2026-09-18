import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from '../src/api/client.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  responses: { status?: number; body?: unknown }[],
): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift() ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('the API client', () => {
  it('sends the bearer token and asks for JSON', async () => {
    const { calls, fetchImpl } = stubFetch([{ body: { items: [], total: 0 } }]);
    const client = new ApiClient({ baseUrl: 'http://api.test/', token: 'kz_live_x.y', fetchImpl });
    await client.listRuns({ limit: 5, status: 'FAILED,COMPLETED' });

    expect(client.origin).toBe('http://api.test');
    expect(calls[0]?.url).toBe('http://api.test/api/runs?limit=5&status=FAILED%2CCOMPLETED');
    const headers = calls[0]?.init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer kz_live_x.y');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('does not put an authorization header on an anonymous client', async () => {
    const { calls, fetchImpl } = stubFetch([{ body: {} }]);
    const client = new ApiClient({ baseUrl: '', fetchImpl });
    await client.ready();
    expect(calls[0]?.url).toBe('/ready');
    expect((calls[0]?.init?.headers as Headers).get('authorization')).toBeNull();
  });

  it('turns an error body into a typed ApiError', async () => {
    const stub = stubFetch([
      { status: 409, body: { error: { code: 'CONFLICT', message: 'Run is already settled' } } },
    ]);
    const client = new ApiClient({ fetchImpl: stub.fetchImpl });
    await expect(client.runAction('run_1', 'resume')).rejects.toThrowError(ApiError);

    const second = stubFetch([
      { status: 409, body: { error: { code: 'CONFLICT', message: 'Run is already settled' } } },
    ]);
    const other = new ApiClient({ fetchImpl: second.fetchImpl });
    await expect(other.runAction('run_1', 'resume')).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'Run is already settled',
    });
  });

  it('survives a body that is not JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    const client = new ApiClient({ fetchImpl });
    await expect(client.getRun('run_1')).rejects.toMatchObject({
      status: 502,
      code: 'HTTP_ERROR',
      message: 'Request failed with 502',
    });
  });

  it('url-encodes ids so a hostile run id cannot change the route', async () => {
    const { calls, fetchImpl } = stubFetch([{ body: {} }]);
    const client = new ApiClient({ baseUrl: '', fetchImpl });
    await client.getRun('run_1/../../api/keys');
    expect(calls[0]?.url).toBe('/api/runs/run_1%2F..%2F..%2Fapi%2Fkeys');
  });

  it('posts a create run body as JSON', async () => {
    const { calls, fetchImpl } = stubFetch([{ status: 201, body: { run: { id: 'run_1' } } }]);
    const client = new ApiClient({ baseUrl: '', fetchImpl });
    await client.createRun({ agentId: 'developer', goal: 'Fix the tests', limits: { maxSteps: 3 } });
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      agentId: 'developer',
      goal: 'Fix the tests',
      limits: { maxSteps: 3 },
    });
  });

  it('sends a decision to the approval route it belongs to', async () => {
    const { calls, fetchImpl } = stubFetch([{ body: { approval: { id: 'apr_1' } } }]);
    const client = new ApiClient({ baseUrl: '', fetchImpl });
    await client.decideApproval('apr_1', 'deny', { reason: 'not on production' });
    expect(calls[0]?.url).toBe('/api/approvals/apr_1/deny');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ reason: 'not on production' });
  });
});
