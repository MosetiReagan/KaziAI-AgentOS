import type { TimelineEntry, TimelineTone } from '../lib/timeline.js';

const DOT: Record<TimelineTone, string> = {
  neutral: 'bg-slate-500',
  info: 'bg-sky-500',
  success: 'bg-emerald-500',
  warn: 'bg-amber-500',
  danger: 'bg-rose-500',
};

const TEXT: Record<TimelineTone, string> = {
  neutral: 'text-slate-300',
  info: 'text-sky-200',
  success: 'text-emerald-200',
  warn: 'text-amber-200',
  danger: 'text-rose-200',
};

/**
 * The execution timeline. It renders events, not thoughts: AgentOS records
 * operational metadata (what was requested, allowed, observed, verified) and
 * never hidden reasoning, so this view cannot leak it (spec §40, §53).
 */
export function Timeline({ entries, empty = 'No events yet.' }: { entries: TimelineEntry[]; empty?: string }) {
  if (entries.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ol className="space-y-0">
      {entries.map((entry) => (
        <li key={entry.id} className="flex gap-3 border-b border-[#141b2c] py-2 last:border-b-0">
          <span className="tabular w-10 shrink-0 pt-1 text-right text-[11px] text-slate-600">
            {entry.sequence}
          </span>
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[entry.tone]}`} aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-sm font-medium ${TEXT[entry.tone]}`}>{entry.title}</span>
              {entry.risk !== undefined && (
                <span className="rounded border border-[#2b3448] px-1 text-[10px] text-slate-400 uppercase">
                  {entry.risk}
                </span>
              )}
              <span className="text-[11px] text-slate-600">{entry.type}</span>
            </div>
            {entry.detail !== undefined && (
              <p className="text-xs break-words text-slate-500">{entry.detail}</p>
            )}
          </div>
          <span className="tabular shrink-0 pt-1 text-[11px] text-slate-600">
            {new Date(entry.at).toLocaleTimeString(undefined, { hour12: false })}
          </span>
        </li>
      ))}
    </ol>
  );
}
