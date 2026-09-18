import { useApp } from '../AppContext.js';
import { StatusPill } from '../components/StatusPill.js';
import { Empty, ErrorNote, JsonBlock, Loading, Panel, Pill, Table } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { riskTone } from '../lib/state.js';

export function AgentsPage() {
  const { client } = useApp();
  const state = useAsync(() => client.listAgents(), [client]);
  if (state.loading && state.data === undefined) return <Loading />;
  if (state.error) return <ErrorNote error={state.error} />;
  const items = state.data?.items ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Agents</h1>
        <p className="text-sm text-slate-500">
          Definitions the runtime can resolve for this project. A definition registered in the store
          wins over a file, so an operator can pin a version without a redeploy.
        </p>
      </header>

      <Panel title="Definitions" subtitle={`${items.length} available`}>
        <Table
          rows={items}
          rowKey={(agent) => `${agent.id}@${agent.version}`}
          empty="No agent definition is visible to this project."
          columns={[
            {
              key: 'id',
              header: 'Agent',
              render: (agent) => (
                <span className="text-slate-200">
                  {agent.id}
                  <span className="ml-2 text-[11px] text-slate-500">v{agent.version}</span>
                </span>
              ),
            },
            {
              key: 'model',
              header: 'Model',
              render: (agent) => (
                <span className="text-slate-400">
                  {agent.model.provider}/{agent.model.model}
                </span>
              ),
            },
            {
              key: 'tools',
              header: 'Tools',
              render: (agent) => (
                <span className="flex flex-wrap gap-1">
                  {agent.tools.map((tool) => (
                    <Pill key={tool}>{tool}</Pill>
                  ))}
                </span>
              ),
            },
            { key: 'source', header: 'Source', render: (agent) => <Pill tone={agent.source === 'store' ? 'info' : 'neutral'}>{agent.source}</Pill> },
            { key: 'description', header: 'Description', render: (agent) => <span className="text-xs text-slate-500">{agent.description ?? '—'}</span> },
          ]}
        />
      </Panel>
    </div>
  );
}

export function ToolsPage() {
  const { client } = useApp();
  const state = useAsync(() => client.listTools(), [client]);
  if (state.loading && state.data === undefined) return <Loading />;
  if (state.error) return <ErrorNote error={state.error} />;
  const items = state.data?.items ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Tools</h1>
        <p className="text-sm text-slate-500">
          Every tool the runtime can execute, with the risk the policy engine classifies it as. A
          tool being registered does not mean a run may use it.
        </p>
      </header>
      <Panel title="Registered tools" subtitle={`${items.length} available`}>
        <Table
          rows={items}
          rowKey={(tool) => tool.id}
          empty="No tool is registered."
          columns={[
            { key: 'id', header: 'Tool', render: (tool) => <span className="font-mono text-xs text-slate-200">{tool.id}</span> },
            { key: 'kind', header: 'Kind', render: (tool) => <Pill>{tool.kind}</Pill> },
            { key: 'risk', header: 'Risk', render: (tool) => <Pill tone={riskTone(tool.risk)}>{tool.risk}</Pill> },
            { key: 'timeout', header: 'Timeout', render: (tool) => <span className="tabular text-slate-400">{tool.timeoutMs === undefined ? 'default' : `${tool.timeoutMs}ms`}</span> },
            { key: 'description', header: 'Description', render: (tool) => <span className="text-slate-400">{tool.description}</span> },
          ]}
        />
      </Panel>
    </div>
  );
}

export function ProvidersPage() {
  const { client } = useApp();
  const state = useAsync(() => client.listProviders(), [client]);
  if (state.loading && state.data === undefined) return <Loading />;
  if (state.error) return <ErrorNote error={state.error} />;
  const items = state.data?.items ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Providers</h1>
        <p className="text-sm text-slate-500">
          Model providers this runtime registered. The runtime never talks to a vendor SDK directly;
          everything goes through the provider contract.
        </p>
      </header>
      <Panel title="Model providers" subtitle={`${items.length} registered`}>
        <Table
          rows={items}
          rowKey={(provider) => provider.id}
          empty="No provider is registered. Set the provider credentials and restart, or check `kazi-agent doctor`."
          columns={[
            { key: 'id', header: 'Provider', render: (provider) => <span className="text-slate-200">{provider.id}</span> },
            { key: 'kind', header: 'Kind', render: (provider) => <Pill>{provider.kind}</Pill> },
            {
              key: 'stream',
              header: 'Streaming',
              render: (provider) => <span className="text-slate-400">{provider.supportsStreaming ? 'yes' : 'no'}</span>,
            },
          ]}
        />
      </Panel>
    </div>
  );
}

export function ModelsPage() {
  const { client } = useApp();
  const agents = useAsync(() => client.listAgents(), [client]);
  const providers = useAsync(() => client.listProviders(), [client]);
  const info = useAsync(() => client.getInfo(), [client]);
  if (agents.loading && agents.data === undefined) return <Loading />;
  if (agents.error) return <ErrorNote error={agents.error} />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Models</h1>
        <p className="text-sm text-slate-500">
          Which model each agent will use, and what the run snapshot will record. Failover is only
          attempted for retryable provider errors, and every switch appears in the trace.
        </p>
      </header>
      <Panel title="Agent → model">
        <Table
          rows={agents.data?.items ?? []}
          rowKey={(agent) => `${agent.id}@${agent.version}`}
          empty="No agents are defined."
          columns={[
            { key: 'agent', header: 'Agent', render: (agent) => <span className="text-slate-200">{agent.id}</span> },
            { key: 'provider', header: 'Provider', render: (agent) => <span className="text-slate-300">{agent.model.provider}</span> },
            { key: 'model', header: 'Model', render: (agent) => <span className="text-slate-300">{agent.model.model}</span> },
          ]}
        />
      </Panel>
      <Panel title="Provider status" subtitle={`${providers.data?.items.length ?? 0} registered`}>
        <Table
          rows={providers.data?.items ?? []}
          rowKey={(provider) => provider.id}
          empty="No provider is registered."
          columns={[
            { key: 'id', header: 'Provider', render: (provider) => <span className="text-slate-200">{provider.id}</span> },
            { key: 'kind', header: 'Kind', render: (provider) => <Pill>{provider.kind}</Pill> },
          ]}
        />
      </Panel>
      <Panel title="Runtime info">
        <JsonBlock value={info.data?.info ?? {}} maxHeight={220} />
      </Panel>
    </div>
  );
}

export function PoliciesPage() {
  const { client } = useApp();
  const state = useAsync(() => client.listPolicies(), [client]);
  if (state.loading && state.data === undefined) return <Loading />;
  if (state.error) return <ErrorNote error={state.error} />;
  const rules = state.data?.items ?? [];
  const riskRules = state.data?.riskRules ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Policies</h1>
        <p className="text-sm text-slate-500">
          The rules in force. A plan is advisory: every action still goes through the policy engine,
          the budget and the execution sandbox.
        </p>
      </header>

      <Panel title="Rules" subtitle={`${rules.length} in force`}>
        {rules.length === 0 && <Empty>No policy rule is registered.</Empty>}
        <Table
          rows={rules}
          rowKey={(rule) => rule.id}
          empty="No policy rule is registered."
          columns={[
            { key: 'id', header: 'Rule', render: (rule) => <span className="font-mono text-xs text-slate-200">{rule.id}</span> },
            { key: 'effect', header: 'Effect', render: (rule) => <Pill tone={effectTone(rule.effect)}>{rule.effect ?? '—'}</Pill> },
            { key: 'tools', header: 'Tools', render: (rule) => <span className="text-xs text-slate-400">{rule.tools?.join(', ') ?? 'any'}</span> },
            { key: 'risk', header: 'Risk', render: (rule) => <span className="text-xs text-slate-400">{rule.risk ?? '—'}</span> },
            { key: 'description', header: 'Description', render: (rule) => <span className="text-slate-400">{rule.description ?? '—'}</span> },
          ]}
        />
      </Panel>

      <Panel title="Risk classification" subtitle="How an action is graded before a rule sees it">
        <Table
          rows={riskRules}
          rowKey={(rule) => rule.id}
          empty="No risk rule is registered."
          columns={[
            { key: 'id', header: 'Rule', render: (rule) => <span className="font-mono text-xs text-slate-300">{rule.id}</span> },
            { key: 'risk', header: 'Risk', render: (rule) => <Pill tone={riskTone(rule.risk)}>{rule.risk}</Pill> },
            { key: 'tool', header: 'Tool', render: (rule) => <span className="font-mono text-xs text-slate-400">{rule.tool ?? 'any'}</span> },
            { key: 'conditional', header: 'Conditional', render: (rule) => (rule.conditional ? 'yes' : 'no') },
            { key: 'description', header: 'Description', render: (rule) => <span className="text-slate-400">{rule.description ?? '—'}</span> },
          ]}
        />
      </Panel>
    </div>
  );
}

function effectTone(effect: string | undefined): 'neutral' | 'success' | 'danger' | 'warn' {
  if (effect === 'ALLOW') return 'success';
  if (effect === 'DENY') return 'danger';
  if (effect === 'REQUIRE_APPROVAL') return 'warn';
  return 'neutral';
}

export { StatusPill };
