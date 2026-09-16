import { ValidationError } from '@kazi-ai/agentos-core';

export interface DagNode<T> {
  id: string;
  dependsOn?: string[];
  value: T;
}

export interface Wave<T> {
  index: number;
  nodes: DagNode<T>[];
}

/**
 * Group nodes into waves. Nodes inside a wave have no remaining dependencies
 * and may run concurrently; waves run in order. Cycles are rejected rather than
 * silently starved.
 */
export function planWaves<T>(nodes: DagNode<T>[]): Wave<T>[] {
  const remaining = new Map<string, DagNode<T>>();
  for (const node of nodes) {
    if (remaining.has(node.id)) throw new ValidationError(`Duplicate action id in DAG: ${node.id}`);
    remaining.set(node.id, node);
  }
  const completed = new Set<string>();
  const waves: Wave<T>[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((node) =>
      (node.dependsOn ?? []).every((dependency) => completed.has(dependency) || !remaining.has(dependency)),
    );
    if (ready.length === 0) {
      throw new ValidationError(`Action dependency cycle detected among: ${[...remaining.keys()].join(', ')}`);
    }
    for (const node of ready) {
      remaining.delete(node.id);
      completed.add(node.id);
    }
    waves.push({ index: waves.length, nodes: ready });
  }
  return waves;
}

export function criticalPathLength<T>(nodes: DagNode<T>[]): number {
  return planWaves(nodes).length;
}

