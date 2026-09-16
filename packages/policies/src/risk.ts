import { hashObject, type AgentAction, type RiskLevel } from '@kazi-ai/agentos-core';

export interface RiskRule {
  id: string;
  description: string;
  risk: RiskLevel;
  /** Matches a tool id or a namespaced wildcard such as `filesystem.*`. */
  tool: string;
  /** Optional predicate over the normalized arguments. */
  when?: (action: AgentAction) => boolean;
}

const DESTRUCTIVE_COMMAND = /\b(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|kill\s+-9|chmod\s+777|curl\s+[^|]*\|\s*(ba)?sh)\b/i;
const PRODUCTION_HINT = /\b(prod|production|live)\b/i;
const DDL = /\b(drop\s+table|truncate|delete\s+from|alter\s+table)\b/i;

export const DEFAULT_RISK_RULES: RiskRule[] = [
  { id: 'fs.read', description: 'Reading a file is low risk', tool: 'filesystem.read', risk: 'LOW' },
  { id: 'fs.list', description: 'Listing files is low risk', tool: 'filesystem.list', risk: 'LOW' },
  { id: 'fs.search', description: 'Searching files is low risk', tool: 'filesystem.search', risk: 'LOW' },
  { id: 'fs.write', description: 'Writing a file changes the workspace', tool: 'filesystem.write', risk: 'MEDIUM' },
  { id: 'fs.edit', description: 'Editing a file changes the workspace', tool: 'filesystem.edit', risk: 'MEDIUM' },
  { id: 'fs.move', description: 'Moving a file changes the workspace', tool: 'filesystem.move', risk: 'MEDIUM' },
  {
    id: 'fs.delete',
    description: 'Deleting data is high risk',
    tool: 'filesystem.delete',
    risk: 'HIGH',
    when: (action) => !PRODUCTION_HINT.test(JSON.stringify(action.arguments)),
  },
  {
    id: 'fs.delete.production',
    description: 'Deleting production data is critical',
    tool: 'filesystem.delete',
    risk: 'CRITICAL',
    when: (action) => PRODUCTION_HINT.test(JSON.stringify(action.arguments)),
  },
  {
    id: 'terminal.exec.safe',
    description: 'Running an ordinary command is medium risk',
    tool: 'terminal.exec',
    risk: 'MEDIUM',
    when: (action) => !DESTRUCTIVE_COMMAND.test(commandString(action)),
  },
  {
    id: 'terminal.exec.destructive',
    description: 'Destructive shell commands are critical',
    tool: 'terminal.exec',
    risk: 'CRITICAL',
    when: (action) => DESTRUCTIVE_COMMAND.test(commandString(action)),
  },
  { id: 'http.request', description: 'Network requests are medium risk', tool: 'http.request', risk: 'MEDIUM' },
  { id: 'http.request.production', description: 'Requests to production hosts are high risk', tool: 'http.request', risk: 'HIGH', when: (action) => PRODUCTION_HINT.test(JSON.stringify(action.arguments)) },
  { id: 'git.read', description: 'Reading git state is low risk', tool: 'git', risk: 'LOW', when: (action) => isGitRead(action) },
  { id: 'git.write', description: 'Committing changes is medium risk', tool: 'git', risk: 'MEDIUM', when: (action) => isGitCommit(action) },
  { id: 'git.push', description: 'Pushing to a remote is critical', tool: 'git', risk: 'CRITICAL', when: (action) => isGitPush(action) },
  { id: 'db.read', description: 'Reading a database is medium risk', tool: 'database.query', risk: 'MEDIUM', when: (action) => isDatabaseRead(action) },
  { id: 'db.write', description: 'Writing to a database is high risk', tool: 'database.query', risk: 'HIGH', when: (action) => !isDatabaseRead(action) && !isDatabaseDdl(action) },
  { id: 'db.ddl', description: 'Schema changes are critical', tool: 'database.query', risk: 'CRITICAL', when: (action) => isDatabaseDdl(action) },
  { id: 'mcp.tool', description: 'Remote MCP tools are medium risk by default', tool: 'mcp.*', risk: 'MEDIUM' },
];

function isGitRead(action: AgentAction): boolean {
  const operation = operationOf(action);
  return operation === 'status' || operation === 'diff' || operation === 'log' || operation === 'show' || operation === 'rev_parse' || operation === 'branch';
}

function isGitCommit(action: AgentAction): boolean {
  const operation = operationOf(action);
  return operation === 'add' || operation === 'commit' || operation === 'checkout';
}

function isGitPush(action: AgentAction): boolean {
  return operationOf(action) === 'push';
}

function operationOf(action: AgentAction): string {
  const args = action.arguments;
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const value = (args as Record<string, unknown>)['operation'];
    if (typeof value === 'string') return value;
  }
  return '';
}

function isDatabaseRead(action: AgentAction): boolean {
  const args = action.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return true;
  const record = args as Record<string, unknown>;
  if (record['readonly'] === false) return false;
  const sql = typeof record['sql'] === 'string' ? record['sql'] : '';
  return /^\s*(select|with|show|explain|table|values)\b/i.test(sql);
}

function isDatabaseDdl(action: AgentAction): boolean {
  const args = action.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  const sql = (args as Record<string, unknown>)['sql'];
  return typeof sql === 'string' && DDL.test(sql);
}

/** Flatten an action's command and arguments into a single searchable string. */
export function commandString(action: Pick<AgentAction, 'arguments'>): string {
  const args = action.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  const command = typeof record['command'] === 'string' ? record['command'] : '';
  const argv = Array.isArray(record['args']) ? record['args'].filter((item): item is string => typeof item === 'string') : [];
  return [command, ...argv].join(' ');
}

export interface RiskClassifierOptions {
  /**
   * Risk a tool declares about itself. Rules stay argument-aware (a `git push`
   * is critical even though `git status` is not), and when a rule matches the
   * declaration is a floor: a tool may never be classified below what it
   * declared, so a custom tool can mark itself CRITICAL and always get an
   * approval gate. When *no* rule matches, the declaration is used as-is, so
   * `defineTool({ risk: 'LOW' })` is meaningful for a locally registered tool.
   */
  toolRisk?(toolId: string): RiskLevel | undefined;
}

export class RiskClassifier {
  private readonly rules: RiskRule[];
  private readonly defaultRisk: RiskLevel;
  private readonly toolRisk: ((toolId: string) => RiskLevel | undefined) | undefined;

  constructor(rules: RiskRule[] = DEFAULT_RISK_RULES, defaultRisk: RiskLevel = 'HIGH', options: RiskClassifierOptions = {}) {
    this.rules = rules;
    this.defaultRisk = defaultRisk;
    this.toolRisk = options.toolRisk;
  }

  classify(action: Pick<AgentAction, 'toolId' | 'arguments'>): { risk: RiskLevel; ruleId: string; description: string } {
    const declared = this.toolRisk?.(action.toolId);
    for (const rule of this.rules) {
      if (!toolMatches(rule.tool, action.toolId)) continue;
      if (rule.when && !rule.when(action as AgentAction)) continue;
      return this.applyFloor({ risk: rule.risk, ruleId: rule.id, description: rule.description }, declared, action.toolId);
    }
    // No rule matched: the tool's own declaration is the most specific
    // information available. It is trusted because it comes from code the
    // operator installed — remote declarations (MCP) are always matched by an
    // operator-configured rule such as `mcp.*` first, where the declaration is
    // only ever a floor.
    if (declared !== undefined) {
      return {
        risk: declared,
        ruleId: 'risk.declared',
        description: `${action.toolId} declares itself ${declared}`,
      };
    }
    return {
      risk: this.defaultRisk,
      ruleId: 'risk.default',
      description: `No risk rule matched ${action.toolId}; treated as ${this.defaultRisk}`,
    };
  }

  private applyFloor(
    classification: { risk: RiskLevel; ruleId: string; description: string },
    declared: RiskLevel | undefined,
    toolId: string,
  ): { risk: RiskLevel; ruleId: string; description: string } {
    if (declared === undefined || RISK_ORDER[declared] <= RISK_ORDER[classification.risk]) return classification;
    return {
      risk: declared,
      ruleId: `${classification.ruleId}+declared`,
      description: `${classification.description}; ${toolId} declares itself ${declared}`,
    };
  }

  register(rule: RiskRule): void {
    this.rules.unshift(rule);
  }

  list(): RiskRule[] {
    return [...this.rules];
  }
}

export function toolMatches(pattern: string, toolId: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolId) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return toolId === prefix || toolId.startsWith(`${prefix}.`);
  }
  return false;
}

/** Fingerprint of an action, used to tie an approval to exactly one payload. */
export function actionHash(action: Pick<AgentAction, 'toolId' | 'arguments'>): string {
  return hashObject({ toolId: action.toolId, arguments: action.arguments });
}

export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export function maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return RISK_ORDER[left] >= RISK_ORDER[right] ? left : right;
}
