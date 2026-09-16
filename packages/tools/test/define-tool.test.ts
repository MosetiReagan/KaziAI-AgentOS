import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentError, ToolExecutionError } from '@kazi-ai/agentos-core';
import { createTestToolContext, defineTool } from '../src/index.js';

const weatherTool = defineTool({
  id: 'weather.get',
  description: 'Get the current weather',
  input: z.object({ city: z.string().min(1) }),
  risk: 'LOW',
  idempotency: 'idempotent',
  timeoutMs: 5_000,
  async execute(input: { city: string }) {
    return { city: input.city, tempC: 21 };
  },
});

describe('defineTool', () => {
  it('produces an AgentTool the registry accepts', () => {
    expect(weatherTool.id).toBe('weather.get');
    expect(weatherTool.kind).toBe('custom');
    expect(weatherTool.risk).toBe('LOW');
    expect(weatherTool.timeoutMs).toBe(5_000);
    expect(weatherTool.defaultIdempotency).toBe('idempotent');
    expect(weatherTool.inputSchema.toJsonSchema?.()).toMatchObject({ type: 'object' });
  });

  it('validates input and reports issues as a tool input error', async () => {
    const context = await createTestToolContext();
    expect(weatherTool.inputSchema.safeParse({}).success).toBe(false);
    await expect(weatherTool.execute({} as never, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
  });

  it('wraps a returned value into a ToolResult with timing', async () => {
    const context = await createTestToolContext();
    const result = await weatherTool.execute({ city: 'Nairobi' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ city: 'Nairobi', tempC: 21 });
    expect(result.idempotency).toBe('idempotent');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes a hand-built ToolResult through untouched', async () => {
    const tool = defineTool({
      id: 'custom.report',
      description: 'Report a failure itself',
      input: z.object({}),
      idempotency: 'retry-safe',
      execute: () => ({
        success: false,
        output: { reason: 'upstream down' },
        error: {
          code: 'custom.upstream',
          message: 'upstream down',
          category: 'tool',
          retryable: true,
          idempotency: 'retry-safe',
        },
      }),
    });
    const result = await tool.execute({}, await createTestToolContext());
    expect(result.success).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.idempotency).toBe('retry-safe');
  });

  it('classifies thrown errors instead of swallowing them', async () => {
    const boom = defineTool({
      id: 'custom.boom',
      description: 'Explodes',
      input: z.object({}),
      execute: () => {
        throw new Error('kaboom');
      },
    });
    await expect(boom.execute({}, await createTestToolContext())).rejects.toMatchObject({
      code: 'tool.custom_failed',
      name: 'ToolExecutionError',
    });

    const classified = defineTool({
      id: 'custom.classified',
      description: 'Throws a classified error',
      input: z.object({}),
      execute: () => {
        throw new ToolExecutionError('custom.classified', 'denied', {
          code: 'tool.permission_denied',
          retryable: false,
        });
      },
    });
    await expect(classified.execute({}, await createTestToolContext())).rejects.toMatchObject({
      code: 'tool.permission_denied',
    });
    expect(Object.getPrototypeOf(ToolExecutionError.prototype) === AgentError.prototype).toBe(true);
  });

  it('rejects an id that could not be used as a tool namespace', () => {
    expect(() =>
      defineTool({ id: 'Weather Tool', description: 'x', input: z.object({}), execute: vi.fn() }),
    ).toThrow(/Invalid tool id/);
  });

  it('declares the permissions it needs so the executor can intersect them', () => {
    const networkTool = defineTool({
      id: 'weather.forecast',
      description: 'Forecast',
      input: z.object({}),
      permissions: { network: { enabled: true, allowedHosts: ['api.example.com'] } },
      execute: () => ({}),
    });
    expect(networkTool.permissions?.network?.allowedHosts).toEqual(['api.example.com']);
  });
});
