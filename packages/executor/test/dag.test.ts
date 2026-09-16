import { describe, expect, it } from 'vitest';
import { ValidationError } from '@kazi-ai/agentos-core';
import { criticalPathLength, planWaves } from '../src/index.js';

describe('planWaves', () => {
  it('groups fully independent nodes into a single wave', () => {
    const waves = planWaves([
      { id: 'a', value: 'a' },
      { id: 'b', value: 'b' },
      { id: 'c', value: 'c' },
    ]);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders dependent nodes into successive waves', () => {
    const waves = planWaves([
      { id: 'a', value: 'a' },
      { id: 'b', value: 'b' },
      { id: 'c', value: 'c', dependsOn: ['a', 'b'] },
      { id: 'd', value: 'd', dependsOn: ['c'] },
    ]);
    expect(waves.map((wave) => wave.nodes.map((node) => node.id))).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(waves.map((wave) => wave.index)).toEqual([0, 1, 2]);
  });

  it('exposes the diamond as a critical path of three waves', () => {
    const nodes = [
      { id: 'a', value: 'a' },
      { id: 'b', value: 'b', dependsOn: ['a'] },
      { id: 'c', value: 'c', dependsOn: ['a'] },
      { id: 'd', value: 'd', dependsOn: ['b', 'c'] },
    ];
    expect(planWaves(nodes)).toHaveLength(3);
    expect(criticalPathLength(nodes)).toBe(3);
  });

  it('rejects cycles instead of starving them', () => {
    expect(() =>
      planWaves([
        { id: 'a', value: 'a', dependsOn: ['b'] },
        { id: 'b', value: 'b', dependsOn: ['a'] },
      ]),
    ).toThrow(ValidationError);
  });

  it('rejects duplicate action ids', () => {
    expect(() =>
      planWaves([
        { id: 'a', value: 'a' },
        { id: 'a', value: 'b' },
      ]),
    ).toThrow(/Duplicate action id/);
  });

  it('treats dependencies outside the node set as already satisfied', () => {
    const waves = planWaves([{ id: 'a', value: 'a', dependsOn: ['already-done'] }]);
    expect(waves).toHaveLength(1);
  });
});
