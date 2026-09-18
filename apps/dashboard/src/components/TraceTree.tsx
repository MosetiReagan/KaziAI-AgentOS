import { useState } from 'react';
import type { TraceNode } from '../api/types.js';
import { formatDuration } from '../lib/format.js';

const KIND_LABEL: Record<string, string> = {
  run: 'RUN',
  plan: 'PLAN',
  step: 'STEP',
  tool: 'TOOL',
  model: 'MODEL',
  verification: 'VERIFY',
  recovery: 'RECOVER',
  checkpoint: 'CHECKPOINT',
  approval: 'APPROVAL',
  memory: 'MEMORY',
  artifact: 'ARTIFACT',
};

const STATUS_TONE: Record<string, string> = {
  completed: 'text-emerald-300',
  succeeded: 'text-emerald-300',
  passed: 'text-emerald-300',
  failed: 'text-rose-300',
  denied: 'text-rose-300',
  error: 'text-rose-300',
  running: 'text-sky-300',
  pending: 'text-slate-400',
  paused: 'text-amber-300',
  waiting: 'text-amber-300',
};

/** The trace as an indented tree, the same shape the CLI's inspect prints. */
export function TraceTree({ nodes, depth = 0 }: { nodes: TraceNode[]; depth?: number }) {
  return (
    <ul className={depth === 0 ? 'space-y-0.5' : 'space-y-0.5 border-l border-[#1e2740] pl-3'}>
      {nodes.map((node) => (
        <TraceNodeRow key={node.id} node={node} depth={depth} />
      ))}
    </ul>
  );
}

function TraceNodeRow({ node, depth }: { node: TraceNode; depth: number }) {
  const hasChildren = (node.children?.length ?? 0) > 0;
  const [open, setOpen] = useState(depth < 2);
  const tone = STATUS_TONE[node.status] ?? 'text-slate-300';

  return (
    <li>
      <div className="flex items-start gap-2 py-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="mt-0.5 w-3 shrink-0 text-[10px] text-slate-500 hover:text-slate-300"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="mt-0.5 w-3 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-[#2b3448] px-1 text-[10px] tracking-wide text-slate-400 uppercase">
              {KIND_LABEL[node.kind] ?? node.kind}
            </span>
            <span className="text-sm text-slate-200">{node.label}</span>
            <span className={`text-[11px] ${tone}`}>{node.status}</span>
            {node.durationMs !== undefined && (
              <span className="tabular text-[11px] text-slate-500">{formatDuration(node.durationMs)}</span>
            )}
            {node.attempts !== undefined && node.attempts > 1 && (
              <span className="text-[11px] text-amber-300">{node.attempts} attempts</span>
            )}
          </div>
          {node.detail !== undefined && (
            <p className="text-[11px] break-words text-slate-500">
              {Object.entries(node.detail)
                .filter(([, value]) => value !== null && value !== undefined)
                .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
                .join(' · ')}
            </p>
          )}
        </div>
      </div>
      {hasChildren && open && <TraceTree nodes={node.children ?? []} depth={depth + 1} />}
    </li>
  );
}
