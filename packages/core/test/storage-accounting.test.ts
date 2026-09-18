import { describe, expect, it } from 'vitest';
import { persistedBytes, toolResult, type ToolResult } from '../src/index.js';

function result(metadata: unknown): ToolResult {
  return { success: true, output: {}, metadata: metadata as ToolResult['metadata'] };
}

describe('persistedBytes', () => {
  it('reads the persistedBytes convention off a tool result', () => {
    expect(persistedBytes(result({ persistedBytes: 2048 }))).toBe(2048);
  });

  it('honours negative deltas so a shrunken file credits the budget', () => {
    expect(persistedBytes(result({ persistedBytes: -512 }))).toBe(-512);
  });

  it('treats a missing result or missing metadata as zero', () => {
    expect(persistedBytes(undefined)).toBe(0);
    expect(persistedBytes(toolResult({ success: true, output: {} }))).toBe(0);
    expect(persistedBytes(result({}))).toBe(0);
  });

  it('refuses to trust malformed values', () => {
    expect(persistedBytes(result({ persistedBytes: '999999' }))).toBe(0);
    expect(persistedBytes(result({ persistedBytes: Number.NaN }))).toBe(0);
    expect(persistedBytes(result({ persistedBytes: Number.POSITIVE_INFINITY }))).toBe(0);
    expect(persistedBytes(result({ persistedBytes: null }))).toBe(0);
    expect(persistedBytes(result({ persistedBytes: { bytes: 10 } }))).toBe(0);
  });

  it('truncates fractional values rather than reporting a fraction of a byte', () => {
    expect(persistedBytes(result({ persistedBytes: 10.9 }))).toBe(10);
    expect(persistedBytes(result({ persistedBytes: -10.9 }))).toBe(-10);
  });
});
