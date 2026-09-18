import type { AgentRun } from '../api/types.js';
import { budgetLines } from '../lib/budget.js';
import { formatPercent } from '../lib/format.js';

const BAR: Record<string, string> = {
  neutral: 'bg-sky-600/70',
  warn: 'bg-amber-500/80',
  danger: 'bg-rose-600/80',
};

/**
 * Budget usage as the runtime sees it. The dashboard does not enforce these;
 * it shows the same numbers the runtime checks before every step (spec §25).
 */
export function BudgetBars({ run }: { run: Pick<AgentRun, 'limits' | 'usage'> }) {
  const lines = budgetLines(run).filter((line) => line.limit !== undefined);
  if (lines.length === 0) {
    return <p className="text-sm text-slate-500">No limits were set for this run.</p>;
  }
  return (
    <div className="space-y-3">
      {lines.map((line) => (
        <div key={line.key}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-slate-400">{line.label}</span>
            <span className="tabular text-slate-300">
              {line.display} <span className="text-slate-500">· {line.remaining}</span>
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-[#151c2e]">
            <div
              className={`h-full ${BAR[line.tone] ?? BAR.neutral}`}
              style={{ width: `${Math.min(100, Math.round((line.ratio ?? 0) * 100))}%` }}
              role="progressbar"
              aria-valuenow={Math.round((line.ratio ?? 0) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={line.label}
            />
          </div>
          <div className="mt-0.5 text-[11px] text-slate-600">{formatPercent(line.ratio)} used</div>
        </div>
      ))}
    </div>
  );
}
