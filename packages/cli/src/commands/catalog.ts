import { newActionId, type JsonObject } from '@kazi-ai/agentos-core';
import { Output } from '../output.js';
import type { CliContext } from '../context.js';
import { DEFAULT_ORGANIZATION, DEFAULT_PROJECT, loadAgentDefinitions } from '../context.js';

export interface AgentListEntry {
  id: string;
  version: string;
  model: string;
  tools: number;
  planning: boolean;
  verification: boolean;
  source: string;
}

/** `kazi-agent agents`: which agents this project can run. */
export async function listAgents(context: CliContext): Promise<AgentListEntry[]> {
  const entries: AgentListEntry[] = [];
  for (const definition of loadAgentDefinitions(context.cwd)) {
    entries.push({
      id: definition.id,
      version: definition.version,
      model: `${definition.model.provider}/${definition.model.model}`,
      tools: context.os.tools.resolve(definition.tools).length,
      planning: definition.planning.enabled,
      verification: definition.verification.enabled,
      source: 'file',
    });
  }
  for (const record of await context.os.store.agentDefinitions.list(
    context.os.organizationId ?? 'org_local',
    context.os.projectId ?? 'prj_default',
  )) {
    if (entries.some((entry) => entry.id === record.name || entry.id === record.id)) continue;
    entries.push({
      id: record.name,
      version: record.version,
      model: '-',
      tools: 0,
      planning: false,
      verification: false,
      source: 'registry',
    });
  }
  return entries;
}

export function renderAgents(output: Output, entries: AgentListEntry[]): void {
  output.table(
    entries.map((entry) => ({
      AGENT: entry.id,
      VERSION: entry.version,
      MODEL: entry.model,
      TOOLS: String(entry.tools),
      PLANNING: entry.planning ? 'yes' : 'no',
      VERIFY: entry.verification ? 'yes' : 'no',
      SOURCE: entry.source,
    })),
    ['AGENT', 'VERSION', 'MODEL', 'TOOLS', 'PLANNING', 'VERIFY', 'SOURCE'],
  );
}

export interface ToolListEntry {
  id: string;
  kind: string;
  risk: string;
  description: string;
}

/** `kazi-agent tools`: the normalized catalog, local and MCP alike. */
export function listTools(context: CliContext): ToolListEntry[] {
  return context.os.tools.describe().map((tool) => ({
    id: tool.id,
    kind: tool.kind,
    risk: tool.risk,
    description: tool.description,
  }));
}

export function renderTools(output: Output, tools: ToolListEntry[]): void {
  output.table(
    tools.map((tool) => ({
      TOOL: tool.id,
      KIND: tool.kind,
      RISK: tool.risk,
      DESCRIPTION: tool.description.slice(0, 60),
    })),
    ['TOOL', 'KIND', 'RISK', 'DESCRIPTION'],
  );
}

export interface PolicyListEntry {
  id: string;
  kind: 'policy' | 'risk';
  risk: string;
  priority: string;
  description: string;
}

/** `kazi-agent policies`: every rule the engine consults, in evaluation order. */
export function listPolicies(context: CliContext): PolicyListEntry[] {
  const entries: PolicyListEntry[] = [];
  for (const rule of context.os.runtime.policies.list()) {
    entries.push({
      id: rule.id,
      kind: 'policy',
      risk: rule.risk ?? '-',
      priority: String(rule.priority ?? 0),
      description: rule.description,
    });
  }
  for (const rule of context.os.runtime.policies.classifier.list()) {
    entries.push({
      id: rule.id,
      kind: 'risk',
      risk: rule.risk,
      priority: '-',
      description: `${rule.description} (${rule.tool})`,
    });
  }
  return entries;
}

export function renderPolicies(output: Output, rules: PolicyListEntry[]): void {
  output.table(
    rules.map((rule) => ({
      RULE: rule.id,
      KIND: rule.kind,
      RISK: rule.risk,
      PRIORITY: rule.priority,
      DESCRIPTION: rule.description.slice(0, 52),
    })),
    ['RULE', 'KIND', 'RISK', 'PRIORITY', 'DESCRIPTION'],
  );
}

export interface EvaluatedAction {
  toolId: string;
  outcome: string;
  risk: string;
  reason: string;
  ruleId?: string;
}

/** Evaluate an action against policy without running it — the §22 inspection path. */
export async function evaluateAction(
  context: CliContext,
  action: { toolId: string; arguments: JsonObject },
): Promise<EvaluatedAction> {
  const decision = await context.os.runtime.policies.evaluate(
    {
      id: newActionId(),
      runId: 'run_inspect',
      toolId: action.toolId,
      arguments: action.arguments,
      idempotencyKey: 'inspect',
      idempotency: 'unknown',
      status: 'pending',
      createdAt: Date.now(),
      attempt: 0,
    },
    {
      runId: 'run_inspect',
      agentId: 'inspect',
      organizationId: context.os.organizationId ?? DEFAULT_ORGANIZATION,
      projectId: context.os.projectId ?? DEFAULT_PROJECT,
      environment: context.config.env,
      workspaceDir: context.cwd,
      trust: 'operator',
      requestOrigin: 'system',
    },
  );
  return {
    toolId: action.toolId,
    outcome: decision.outcome,
    risk: decision.risk,
    reason: decision.reason,
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
  };
}

export function renderEvaluatedAction(output: Output, evaluated: EvaluatedAction): void {
  output.keyValue('Tool:', evaluated.toolId);
  output.keyValue('Decision:', evaluated.outcome);
  output.keyValue('Risk:', evaluated.risk);
  output.keyValue('Reason:', evaluated.reason);
  if (evaluated.ruleId) output.keyValue('Rule:', evaluated.ruleId);
}

export interface RunListEntry {
  id: string;
  status: string;
  agent: string;
  goal: string;
  steps: string;
  toolCalls: string;
  created: string;
}

/** `kazi-agent runs`: the tenant's runs, newest first. */
export async function listRuns(
  context: CliContext,
  filter: { status?: string; agent?: string; limit?: number } = {},
): Promise<RunListEntry[]> {
  const runs = await context.os.runtime.listRuns({
    organizationId: context.os.organizationId,
    projectId: context.os.projectId,
    ...(filter.status ? { status: [filter.status] } : {}),
    ...(filter.agent ? { agentId: filter.agent } : {}),
    limit: filter.limit ?? 50,
    orderBy: 'createdAt',
    direction: 'desc',
  });
  return runs
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((run) => ({
      id: run.id,
      status: run.status,
      agent: run.agentId,
      goal: run.goal.slice(0, 40),
      steps: String(run.usage.steps),
      toolCalls: String(run.usage.toolCalls),
      created: new Date(run.createdAt).toISOString().replace('T', ' ').slice(0, 19),
    }));
}

export function renderRuns(output: Output, runs: RunListEntry[]): void {
  output.table(
    runs.map((run) => ({
      RUN: run.id,
      STATUS: run.status,
      AGENT: run.agent,
      STEPS: run.steps,
      TOOLS: run.toolCalls,
      CREATED: run.created,
      GOAL: run.goal,
    })),
    ['RUN', 'STATUS', 'AGENT', 'STEPS', 'TOOLS', 'CREATED', 'GOAL'],
  );
}
