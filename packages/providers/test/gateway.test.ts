import { describe, expect, it } from 'vitest';
import { ProviderError } from '@kazi-ai/agentos-core';
import { FakeModelProvider } from '../src/fake.js';
import { ModelGateway, ModelProviderRegistry, type FailoverEvent } from '../src/registry.js';

describe('fake provider', () => {
  it('replays scripted turns deterministically', async () => {
    const provider = new FakeModelProvider({
      turns: [
        { toolCalls: [{ name: 'filesystem.read', arguments: { path: 'a.ts' } }] },
        { text: 'Finished.' },
      ],
    });
    const first = await provider.generate({ model: 'm', messages: [] });
    const second = await provider.generate({ model: 'm', messages: [] });
    expect(first.toolCalls[0]?.name).toBe('filesystem.read');
    expect(second.content).toEqual([{ type: 'text', text: 'Finished.' }]);
    expect(provider.calls).toBe(2);
  });

  it('fails a bounded number of times before succeeding', async () => {
    const provider = new FakeModelProvider({
      turns: [{ text: 'ok', fail: { code: 'provider.overloaded', retryable: true, times: 2 } }],
    });
    await expect(provider.generate({ model: 'm', messages: [] })).rejects.toMatchObject({ retryable: true });
    await expect(provider.generate({ model: 'm', messages: [] })).rejects.toMatchObject({ retryable: true });
    await expect(provider.generate({ model: 'm', messages: [] })).resolves.toMatchObject({ provider: 'fake' });
  });
});

describe('model gateway failover', () => {
  it('fails over only for retryable provider errors', async () => {
    const registry = new ModelProviderRegistry();
    registry.register(new FakeModelProvider({ id: 'primary', turns: [{ fail: { retryable: true } }] }));
    registry.register(new FakeModelProvider({ id: 'fallback', turns: [{ text: 'from fallback' }] }));
    const events: FailoverEvent[] = [];
    const gateway = new ModelGateway({
      registry,
      chain: [
        { provider: 'primary', model: 'm1' },
        { provider: 'fallback', model: 'm2' },
      ],
      onEvent: (event) => events.push(event),
    });
    const result = await gateway.generate({ model: 'm1', messages: [] });
    expect(result.failedOver).toBe(true);
    expect(result.provider).toBe('fallback');
    expect(result.response.content).toEqual([{ type: 'text', text: 'from fallback' }]);
    expect(events.map((event) => event.type)).toEqual(['attempt', 'failover', 'success']);
  });

  it('does not fail over on non-retryable errors', async () => {
    const registry = new ModelProviderRegistry();
    registry.register(
      new FakeModelProvider({ id: 'primary', turns: [{ fail: { code: 'provider.bad_request', retryable: false } }] }),
    );
    registry.register(new FakeModelProvider({ id: 'fallback', turns: [{ text: 'should not be used' }] }));
    const gateway = new ModelGateway({
      registry,
      chain: [
        { provider: 'primary', model: 'm1' },
        { provider: 'fallback', model: 'm2' },
      ],
    });
    await expect(gateway.generate({ model: 'm1', messages: [] })).rejects.toMatchObject({ retryable: false });
  });

  it('opens the circuit after repeated failures and skips the target', async () => {
    const registry = new ModelProviderRegistry();
    registry.register(new FakeModelProvider({ id: 'primary', turns: [{ fail: { retryable: true, times: 10 } }] }));
    registry.register(new FakeModelProvider({ id: 'fallback', turns: [{ text: 'ok' }] }));
    const gateway = new ModelGateway({
      registry,
      chain: [
        { provider: 'primary', model: 'm1' },
        { provider: 'fallback', model: 'm2' },
      ],
      failureThreshold: 2,
      openMs: 60_000,
    });
    await gateway.generate({ model: 'm1', messages: [] });
    await gateway.generate({ model: 'm1', messages: [] });
    const third = await gateway.generate({ model: 'm1', messages: [] });
    expect(third.provider).toBe('fallback');
    expect(gateway.circuitStates()[0]?.state).toBe('OPEN');
  });

  it('reports missing providers instead of failing silently', async () => {
    const registry = new ModelProviderRegistry();
    const gateway = new ModelGateway({ registry, chain: [{ provider: 'ghost', model: 'm' }] });
    await expect(gateway.generate({ model: 'm', messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });
});

