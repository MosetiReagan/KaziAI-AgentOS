import { useState } from 'react';
import { useApp } from '../AppContext.js';
import { Button, ErrorNote, Field, JsonBlock, Loading, Panel, Pill, inputClass } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { formatDateTime } from '../lib/format.js';

/**
 * Connection and identity. The token is kept in this browser only, sent as a
 * bearer header, and never placed in a URL or a log.
 */
export function SettingsPage() {
  const { client, baseUrl, setBaseUrl, token, setToken } = useApp();
  const [baseDraft, setBaseDraft] = useState(baseUrl);
  const [tokenDraft, setTokenDraft] = useState('');
  const [saved, setSaved] = useState(false);

  const health = useAsync(async () => {
    const [ready, version, whoami, identity] = await Promise.all([
      client.ready(),
      client.version(),
      client.whoami(),
      client.identity().catch(() => undefined),
    ]);
    return { ready, version, whoami, identity };
  }, [client]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Settings</h1>
        <p className="text-sm text-slate-500">
          This console talks to the control plane over HTTP. Nothing about a run is cached in the
          browser — a refresh always re-reads the truth.
        </p>
      </header>

      <Panel title="Connection">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <Field label="API base URL">
              <input
                className={`${inputClass} w-full`}
                value={baseDraft}
                onChange={(event) => setBaseDraft(event.target.value)}
                placeholder="leave empty to use this origin (the gateway)"
              />
            </Field>
          </div>
          <Button
            onClick={() => {
              setBaseUrl(baseDraft);
              setSaved(true);
            }}
          >
            Save
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Effective origin: <span className="font-mono">{client.origin === '' ? '(same origin)' : client.origin}</span>
        </p>
      </Panel>

      <Panel title="API key" subtitle="Stored in this browser's local storage">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[320px] flex-1">
            <Field label="Bearer token">
              <input
                className={`${inputClass} w-full`}
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder={token === null ? 'kz_live_…' : 'a token is set; enter a new one to replace it'}
                type="password"
                autoComplete="off"
              />
            </Field>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              setToken(tokenDraft.trim() === '' ? null : tokenDraft.trim());
              setTokenDraft('');
              setSaved(true);
            }}
          >
            {token === null ? 'Set token' : 'Replace token'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setToken(null);
              setTokenDraft('');
            }}
          >
            Clear
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {token === null
            ? 'No token is set. That is only safe when the API runs with authentication disabled.'
            : 'A token is set; it is sent as Authorization: Bearer on every request.'}
          {saved && <span className="ml-2 text-emerald-300">Saved.</span>}
        </p>
      </Panel>

      <Panel title="Deployment" subtitle="Read from the control plane">
        {health.loading && health.data === undefined && <Loading />}
        <ErrorNote error={health.error} />
        {health.data !== undefined && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Pill tone={health.data.ready.status === 'ready' ? 'success' : 'danger'}>
                {health.data.ready.status}
              </Pill>
              <Pill>{health.data.version.name} {health.data.version.version}</Pill>
              <Pill>{health.data.version.runtime}</Pill>
              <Pill tone="info">{health.data.whoami.principal.role}</Pill>
              <Pill>{health.data.whoami.organizationId}</Pill>
              <Pill>{health.data.whoami.projectId}</Pill>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] tracking-wide text-slate-500 uppercase">Readiness checks</p>
                <JsonBlock value={health.data.ready.checks} maxHeight={200} />
              </div>
              <div>
                <p className="mb-1 text-[11px] tracking-wide text-slate-500 uppercase">Identity</p>
                <JsonBlock
                  value={health.data.identity ?? { note: 'identity is restricted for this role' }}
                  maxHeight={200}
                />
              </div>
            </div>
            {health.data.identity?.organization?.createdAt !== undefined && (
              <p className="text-xs text-slate-500">
                Organization created {formatDateTime(health.data.identity.organization.createdAt)}
              </p>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
