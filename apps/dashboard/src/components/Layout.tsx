import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export interface NavItem {
  to: string;
  label: string;
}

/** The console's sections (spec §52). */
export const NAV: NavItem[] = [
  { to: '/', label: 'Overview' },
  { to: '/runs', label: 'Runs' },
  { to: '/live', label: 'Live Runs' },
  { to: '/agents', label: 'Agents' },
  { to: '/tools', label: 'Tools' },
  { to: '/approvals', label: 'Approvals' },
  { to: '/checkpoints', label: 'Checkpoints' },
  { to: '/failures', label: 'Failures' },
  { to: '/traces', label: 'Traces' },
  { to: '/models', label: 'Models' },
  { to: '/providers', label: 'Providers' },
  { to: '/policies', label: 'Policies' },
  { to: '/memory', label: 'Memory' },
  { to: '/settings', label: 'Settings' },
];

export function Layout({
  children,
  pendingApprovals,
  status,
}: {
  children: ReactNode;
  pendingApprovals: number;
  status: { ok: boolean; label: string };
}) {
  return (
    <div className="flex h-full min-h-screen">
      <aside className="flex w-52 shrink-0 flex-col border-r border-[#1e2740] bg-[#0a0f1c]">
        <div className="border-b border-[#1e2740] px-4 py-3">
          <div className="text-sm font-semibold tracking-tight text-slate-100">KaziAI AgentOS</div>
          <div className="text-[11px] text-slate-500">The runtime for reliable AI agents</div>
        </div>
        <nav className="scroll-thin flex-1 overflow-y-auto py-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center justify-between px-4 py-1.5 text-sm transition ${
                  isActive
                    ? 'bg-[#141d31] text-slate-100'
                    : 'text-slate-400 hover:bg-[#101728] hover:text-slate-200'
                }`
              }
            >
              <span>{item.label}</span>
              {item.to === '/approvals' && pendingApprovals > 0 && (
                <span className="rounded bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-300">
                  {pendingApprovals}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-[#1e2740] px-4 py-2.5 text-[11px]">
          <span
            className={`h-1.5 w-1.5 rounded-full ${status.ok ? 'bg-emerald-400' : 'bg-rose-500'}`}
            aria-hidden
          />
          <span className="text-slate-500">{status.label}</span>
        </div>
      </aside>
      <main className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] p-6">{children}</div>
      </main>
    </div>
  );
}
