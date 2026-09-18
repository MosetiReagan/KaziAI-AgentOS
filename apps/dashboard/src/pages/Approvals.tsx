import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../AppContext.js';
import { Button, Empty, ErrorNote, JsonBlock, Loading, Panel, Pill, Table } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { formatAge, formatDateTime, truncateId } from '../lib/format.js';
import { riskTone } from '../lib/state.js';

/**
 * Approval gates (spec §54). The decision is sent to the API, persisted, and
 * only then does the run continue — the console holds no approval state of its
 * own, so a refresh can never lose a decision.
 */
export function ApprovalsPage() {
  const { client } = useApp();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [reason, setReason] = useState('');
  const pending = useAsync(() => client.listApprovals({ status: 'pending', limit: 100 }), [client]);
  const decided = useAsync(
    () =>
      Promise.all([
        client.listApprovals({ status: 'granted', limit: 25 }),
        client.listApprovals({ status: 'denied', limit: 25 }),
        client.listApprovals({ status: 'modified', limit: 25 }),
      ]).then(([granted, denied, modified]) => [
        ...granted.items,
        ...denied.items,
        ...modified.items,
      ]),
    [client],
  );

  async function decide(id: string, decision: 'approve' | 'deny') {
    setBusy(id);
    setError(undefined);
    try {
      await client.decideApproval(id, decision, reason.trim() === '' ? {} : { reason: reason.trim() });
      setReason('');
      pending.reload();
      decided.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Approvals</h1>
          <p className="text-sm text-slate-500">
            A run that needs one of these is in <span className="text-amber-300">WAITING</span> and will
            not act until a human decides.
          </p>
        </div>
        <Button
          onClick={() => {
            pending.reload();
            decided.reload();
          }}
        >
          Refresh
        </Button>
      </header>

      <ErrorNote error={error} />

      <Panel title="Waiting for a decision" subtitle={`${pending.data?.items.length ?? 0} pending`}>
        {pending.loading && pending.data === undefined && <Loading />}
        <ErrorNote error={pending.error} />
        {(pending.data?.items.length ?? 0) === 0 && <Empty>Nothing is waiting on a human.</Empty>}
        <div className="space-y-3">
          {(pending.data?.items ?? []).map((approval) => (
            <article key={approval.id} className="rounded border border-[#1e2740] bg-[#0b101c] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-100">{approval.summary}</span>
                    <Pill tone={riskTone(approval.risk)}>{approval.risk}</Pill>
                    <span className="font-mono text-xs text-slate-500">{approval.toolId}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{approval.reason}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Run{' '}
                    <Link className="text-sky-300 hover:underline" to={`/runs/${approval.runId}`}>
                      {truncateId(approval.runId, 24)}
                    </Link>{' '}
                    · action {approval.actionId} · requested {formatAge(approval.requestedAt)} ago
                    {approval.expiresAt === undefined ? '' : ` · expires ${formatDateTime(approval.expiresAt)}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="primary" disabled={busy !== undefined} onClick={() => decide(approval.id, 'approve')}>
                    Approve
                  </Button>
                  <Button variant="danger" disabled={busy !== undefined} onClick={() => decide(approval.id, 'deny')}>
                    Deny
                  </Button>
                </div>
              </div>
              <div className="mt-3">
                <p className="mb-1 text-[11px] tracking-wide text-slate-500 uppercase">
                  Arguments (fingerprinted as {approval.actionHash.slice(0, 12)}…)
                </p>
                <JsonBlock value={approval.arguments} maxHeight={180} />
              </div>
            </article>
          ))}
        </div>
      </Panel>

      <Panel title="Decision history" subtitle="Recorded permanently">
        <Table
          rows={decided.data ?? []}
          rowKey={(approval) => approval.id}
          empty="No decisions have been recorded yet."
          columns={[
            { key: 'summary', header: 'Action', render: (row) => <span className="text-slate-300">{row.summary}</span> },
            { key: 'tool', header: 'Tool', render: (row) => <span className="font-mono text-xs text-slate-400">{row.toolId}</span> },
            { key: 'risk', header: 'Risk', render: (row) => <Pill tone={riskTone(row.risk)}>{row.risk}</Pill> },
            { key: 'status', header: 'Decision', render: (row) => <span className="text-slate-200">{row.status}</span> },
            { key: 'by', header: 'Decided by', render: (row) => <span className="text-slate-400">{row.decidedBy ?? '—'}</span> },
            {
              key: 'at',
              header: 'At',
              render: (row) => <span className="tabular text-slate-500">{formatDateTime(row.decidedAt ?? row.requestedAt)}</span>,
            },
          ]}
        />
      </Panel>
    </div>
  );
}
