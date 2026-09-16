import { describe, expect, it, vi } from 'vitest';
import { JsonRpcClient } from '../src/jsonrpc.js';
import { InProcessTransport, type MessageHandler } from '../src/transports/in-process.js';

function client(handler: MessageHandler, options: { requestTimeoutMs?: number } = {}) {
  const notifications: unknown[] = [];
  const rpc = new JsonRpcClient({
    serverId: 'test',
    transport: new InProcessTransport({ id: 'test', handler }),
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
    onNotification: (notification) => notifications.push(notification),
  });
  return { rpc, notifications };
}

describe('JSON-RPC client', () => {
  it('correlates responses to the request that asked for them', async () => {
    const { rpc } = client((message, reply) => {
      const request = message as { id: number; method: string; params?: { value?: number } };
      // Answer out of order to prove correlation, not ordering, is what counts.
      const delay = request.params?.value === 1 ? 20 : 0;
      setTimeout(() => reply({ jsonrpc: '2.0', id: request.id, result: `answer-${String(request.params?.value)}` }), delay);
    });

    const [first, second] = await Promise.all([rpc.request<string>('a', { value: 1 }), rpc.request<string>('b', { value: 2 })]);
    expect(first).toBe('answer-1');
    expect(second).toBe('answer-2');
    expect(rpc.pendingCount).toBe(0);
  });

  it('times out a call the server never answers and frees the slot', async () => {
    const { rpc } = client(() => undefined, { requestTimeoutMs: 30 });
    await expect(rpc.request('never')).rejects.toMatchObject({ code: 'mcp.timeout', retryable: true });
    expect(rpc.pendingCount).toBe(0);
  });

  it('rejects pending work when the transport dies', async () => {
    let replyLater: ((message: unknown) => void) | undefined;
    const transport = new InProcessTransport({
      id: 'test',
      handler: (_message, reply) => {
        replyLater = reply;
      },
    });
    const rpc = new JsonRpcClient({ serverId: 'test', transport });
    const pending = rpc.request('slow');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await transport.close();
    rpc.failAll(new Error('worker died'));
    await expect(pending).rejects.toThrow('worker died');
    expect(replyLater).toBeTypeOf('function');
  });

  it('surfaces JSON-RPC errors with the server code attached', async () => {
    const { rpc } = client((_message, reply) => reply({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } }));
    await expect(rpc.request('missing')).rejects.toMatchObject({ code: 'mcp.protocol_error', details: { rpcCode: -32601 } });
  });

  it('routes notifications and answers server-initiated requests', async () => {
    const notifications: string[] = [];
    const replies: unknown[] = [];
    const asked: string[] = [];
    const transport = new InProcessTransport({
      id: 'test',
      handler: (message) => {
        const outgoing = message as { id?: number; method?: string; result?: unknown };
        if (outgoing.method === undefined && outgoing.id !== undefined) replies.push(outgoing.result);
      },
    });
    const rpc = new JsonRpcClient({
      serverId: 'test',
      transport,
      onNotification: (notification) => notifications.push(notification.method),
      onServerRequest: (request) => {
        asked.push(request.method);
        return { roots: [{ uri: 'file:///workspace', name: 'workspace' }] };
      },
    });

    transport.emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    transport.emit({ jsonrpc: '2.0', id: 99, method: 'roots/list' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications).toEqual(['notifications/tools/list_changed']);
    expect(asked).toEqual(['roots/list']);
    expect(replies).toEqual([{ roots: [{ uri: 'file:///workspace', name: 'workspace' }] }]);
    void rpc;
  });

  it('declines a server request when the client has no handler for it', async () => {
    const replies: Array<{ id?: unknown; error?: { code: number } }> = [];
    const transport = new InProcessTransport({
      id: 'test',
      handler: (message) => {
        replies.push(message as { id?: unknown; error?: { code: number } });
      },
    });
    new JsonRpcClient({ serverId: 'test', transport });
    transport.emit({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replies[0]?.error?.code).toBe(-32601);
  });

  it('ignores a malformed frame instead of crashing the client', async () => {
    const onTransportError = vi.fn();
    const transport = new InProcessTransport({ id: 'test', handler: () => undefined });
    const rpc = new JsonRpcClient({ serverId: 'test', transport, onTransportError, requestTimeoutMs: 30 });
    transport.emit({ nope: true });
    await expect(rpc.request('anything')).rejects.toMatchObject({ code: 'mcp.timeout' });
    expect(onTransportError).toHaveBeenCalledTimes(1);
  });
});
