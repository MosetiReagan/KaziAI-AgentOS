import type { ReactNode } from 'react';
import { formatJson } from '../lib/format.js';
import type { StatusTone } from '../lib/state.js';

const TONE_TEXT: Record<StatusTone, string> = {
  neutral: 'text-slate-300 border-slate-600/60 bg-slate-500/10',
  info: 'text-sky-300 border-sky-700/60 bg-sky-500/10',
  success: 'text-emerald-300 border-emerald-700/60 bg-emerald-500/10',
  warn: 'text-amber-300 border-amber-700/60 bg-amber-500/10',
  danger: 'text-rose-300 border-rose-800/60 bg-rose-500/10',
};

export function Pill({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: StatusTone;
  title?: string;
}) {
  return (
    <span
      {...(title === undefined ? {} : { title })}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase ${TONE_TEXT[tone]}`}
    >
      {children}
    </span>
  );
}

export function Panel({
  title,
  actions,
  children,
  subtitle,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-[#1e2740] bg-[#0d1220] ${className}`}>
      {title !== undefined && (
        <header className="flex items-center justify-between gap-3 border-b border-[#1e2740] px-4 py-2.5">
          <div>
            <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
            {subtitle !== undefined && <p className="text-xs text-slate-500">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div className="rounded-lg border border-[#1e2740] bg-[#0d1220] px-4 py-3">
      <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={`tabular mt-1 text-xl font-semibold ${TONE_TEXT[tone].split(' ')[0]}`}>{value}</div>
      {hint !== undefined && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'default',
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  type?: 'button' | 'submit';
  title?: string;
}) {
  const styles: Record<string, string> = {
    default: 'border-[#2b3448] bg-[#151c2e] text-slate-200 hover:border-[#3a4763] hover:bg-[#1a2337]',
    primary: 'border-sky-700 bg-sky-600/20 text-sky-200 hover:bg-sky-600/30',
    danger: 'border-rose-800 bg-rose-600/20 text-rose-200 hover:bg-rose-600/30',
    ghost: 'border-transparent bg-transparent text-slate-400 hover:text-slate-200',
  };
  return (
    <button
      type={type}
      {...(title === undefined ? {} : { title })}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      <span className="font-medium tracking-wide uppercase">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  'rounded border border-[#2b3448] bg-[#0b101c] px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-sky-700';

export function Table<T>({
  rows,
  columns,
  empty = 'Nothing to show.',
  onRowClick,
  rowKey,
}: {
  rows: T[];
  columns: { key: string; header: string; render: (row: T) => ReactNode; className?: string }[];
  empty?: string;
  onRowClick?: (row: T) => void;
  rowKey: (row: T) => string;
}) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-[11px] tracking-wide text-slate-500 uppercase">
            {columns.map((column) => (
              <th key={column.key} className={`border-b border-[#1e2740] px-3 py-2 ${column.className ?? ''}`}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              {...(onRowClick === undefined ? {} : { onClick: () => onRowClick(row) })}
              className={`border-b border-[#141b2c] ${onRowClick ? 'cursor-pointer hover:bg-[#131b2d]' : ''}`}
            >
              {columns.map((column) => (
                <td key={column.key} className={`px-3 py-2 align-top ${column.className ?? ''}`}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JsonBlock({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre
      style={{ maxHeight }}
      className="scroll-thin overflow-auto rounded border border-[#1e2740] bg-[#0b101c] p-3 text-[11px] leading-relaxed text-slate-300"
    >
      {formatJson(value)}
    </pre>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="text-sm text-slate-500">{label}</p>;
}

export function ErrorNote({ error }: { error: Error | undefined }) {
  if (error === undefined) return null;
  return (
    <div className="rounded border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-200">
      {error.message}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="scroll-thin flex gap-1 overflow-x-auto border-b border-[#1e2740]">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap transition ${
            active === tab.id
              ? 'border-sky-500 text-sky-200'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge > 0 && (
            <span className="ml-1.5 rounded bg-slate-700/60 px-1 text-[10px] text-slate-300">
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
