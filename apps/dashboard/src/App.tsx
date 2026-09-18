import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './AppContext.js';
import { Layout } from './components/Layout.js';
import { AgentsPage, ModelsPage, PoliciesPage, ProvidersPage, ToolsPage } from './pages/Catalog.js';
import { ApprovalsPage } from './pages/Approvals.js';
import { CheckpointsPage, FailuresPage, TracesPage } from './pages/Durability.js';
import { LiveRunsPage } from './pages/LiveRuns.js';
import { MemoryPage } from './pages/Memory.js';
import { OverviewPage } from './pages/Overview.js';
import { RunDetailPage } from './pages/RunDetail.js';
import { RunsPage } from './pages/Runs.js';
import { SettingsPage } from './pages/Settings.js';

/** The shell: navigation, a connection indicator and the pending-approval count. */
function Shell() {
  const { client } = useApp();
  const [status, setStatus] = useState<{ ok: boolean; label: string }>({
    ok: false,
    label: 'connecting…',
  });
  const [pendingApprovals, setPendingApprovals] = useState(0);

  useEffect(() => {
    let disposed = false;
    const poll = async (): Promise<void> => {
      try {
        const ready = await client.ready();
        if (disposed) return;
        setStatus({
          ok: ready.status === 'ready',
          label: ready.status === 'ready' ? 'control plane ready' : `degraded: ${ready.status}`,
        });
      } catch (error) {
        if (disposed) return;
        setStatus({
          ok: false,
          label: error instanceof Error ? `unreachable: ${error.message}` : 'unreachable',
        });
      }
      try {
        const approvals = await client.listApprovals({ status: 'pending', limit: 100 });
        if (!disposed) setPendingApprovals(approvals.items.length);
      } catch {
        // The approval count is a convenience; readiness already reports health.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 15_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client]);

  return (
    <Layout pendingApprovals={pendingApprovals} status={status}>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="/live" element={<LiveRunsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/checkpoints" element={<CheckpointsPage />} />
        <Route path="/failures" element={<FailuresPage />} />
        <Route path="/traces" element={<TracesPage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/policies" element={<PoliciesPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
