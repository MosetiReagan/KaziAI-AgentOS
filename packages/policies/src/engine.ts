import {
  PolicyDeniedError,
  ValidationError,
  type AgentAction,
  type JsonObject,
  type PolicyContext,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyRule,
  type RiskLevel,
} from '@kazi-ai/agentos-core';
import { RiskClassifier, commandString, maxRisk, toolMatches } from './risk.js';

export interface PolicyEngineOptions {
  rules?: PolicyRule[];
  classifier?: RiskClassifier;
  /** Outcome used when no rule matches. Sensitive-by-default. */
  defaultOutcome?: PolicyDecision['outcome'];
  /** Risk level at or above which the default outcome becomes REQUIRE_APPROVAL. */
  approvalRisk?: RiskLevel;
  /** Risk level at or above which the default outcome becomes DENY. */
  denyRisk?: RiskLevel;
}

/**
 * Evaluates rules in priority order and returns the first decisive result.
 * Per spec §10 a plan is advisory: every action is authorized here regardless
 * of what the planner intended.
 */
export class DefaultPolicyEngine implements PolicyEngine {
  private rules: PolicyRule[];
  /** Exposed for introspection: the CLI and API show how risk is classified. */
  readonly classifier: RiskClassifier;
  private readonly defaultOutcome: PolicyDecision['outcome'];
  private readonly approvalRisk: RiskLevel;
  private readonly denyRisk: RiskLevel | undefined;
  private readonly decisions: PolicyDecision[] = [];

  constructor(options: PolicyEngineOptions = {}) {
    this.rules = (options.rules ?? []).map((rule) => ({ ...rule }));
    this.classifier = options.classifier ?? new RiskClassifier();
    this.defaultOutcome = options.defaultOutcome ?? 'ALLOW';
    this.approvalRisk = options.approvalRisk ?? 'HIGH';
    this.denyRisk = options.denyRisk;
  }

  register(rule: PolicyRule): void {
    if (this.rules.some((existing) => existing.id === rule.id)) {
      throw new ValidationError(`Policy rule already registered: ${rule.id}`, { ruleId: rule.id });
    }
    this.rules.push(rule);
  }

  unregister(ruleId: string): void {
    this.rules = this.rules.filter((rule) => rule.id !== ruleId);
  }

  list(): PolicyRule[] {
    return [...this.rules].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  }

  history(): PolicyDecision[] {
    return [...this.decisions];
  }

  async evaluate(action: AgentAction, context: PolicyContext): Promise<PolicyDecision> {
    const classification = this.classifier.classify(action);
    const sorted = this.list();
    for (const rule of sorted) {
      const decision = this.safeEvaluate(rule, action, context);
      if (!decision) continue;
      const finalised: PolicyDecision = {
        ...decision,
        risk: maxRisk(decision.risk, classification.risk),
      };
      this.decisions.push(finalised);
      return finalised;
    }
    const fallback = this.fallback(classification);
    this.decisions.push(fallback);
    return fallback;
  }

  /** `PolicyProvider` shape used by the composite/Sentinel adapters. */
  async authorize(action: AgentAction, context: PolicyContext): Promise<PolicyDecision> {
    return this.evaluate(action, context);
  }

  private safeEvaluate(rule: PolicyRule, action: AgentAction, context: PolicyContext): PolicyDecision | undefined {
    try {
      return rule.evaluate(action, context);
    } catch (error) {
      // A broken rule must not silently allow the action: fail closed.
      return {
        outcome: 'DENY',
        ruleId: `${rule.id}:error`,
        reason: `Policy rule failed to evaluate: ${(error as Error).message}`,
        risk: 'HIGH',
      };
    }
  }

  private fallback(classification: { risk: RiskLevel; ruleId: string; description: string }): PolicyDecision {
    const base = {
      ruleId: classification.ruleId,
      reason: classification.description,
      risk: classification.risk,
    };
    if (this.denyRisk && riskOrder(classification.risk) >= riskOrder(this.denyRisk)) {
      return { ...base, outcome: 'DENY' };
    }
    if (riskOrder(classification.risk) >= riskOrder(this.approvalRisk)) {
      return { ...base, outcome: 'REQUIRE_APPROVAL', summary: `${classification.description} (${classification.risk})` };
    }
    return { ...base, outcome: this.defaultOutcome };
  }
}

function riskOrder(risk: RiskLevel): number {
  return { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }[risk];
}

export interface RuleBuilderOptions {
  id: string;
  description: string;
  priority?: number;
  risk?: RiskLevel;
  tools: string[];
  outcome: PolicyDecision['outcome'];
  reason?: string;
  when?: (action: AgentAction, context: PolicyContext) => boolean;
}

/** The declarative half of a rule: everything except the predicate. */
export interface PolicyRuleSpec {
  id: string;
  description: string;
  tools: string[];
  outcome: PolicyDecision['outcome'];
  priority?: number;
  risk?: RiskLevel;
  reason?: string;
}

/**
 * Declarative rule factory, used to build policy from configuration.
 *
 * The spec is attached to the rule so the API, the CLI and dashboards can show
 * an operator *why* a rule exists, and a policy can be exported back to YAML
 * (spec §62). The predicate itself is not serialisable.
 */
export function policyRule(options: RuleBuilderOptions): PolicyRule {
  const rule: PolicyRule = {
    id: options.id,
    description: options.description,
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.risk === undefined ? {} : { risk: options.risk }),
    evaluate: (action, context) => {
      if (!options.tools.some((pattern) => toolMatches(pattern, action.toolId))) return undefined;
      if (options.when && !options.when(action, context)) return undefined;
      return {
        outcome: options.outcome,
        ruleId: options.id,
        reason: options.reason ?? options.description,
        risk: options.risk ?? 'MEDIUM',
      };
    },
  };
  const spec: PolicyRuleSpec = {
    id: options.id,
    description: options.description,
    tools: [...options.tools],
    outcome: options.outcome,
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.risk === undefined ? {} : { risk: options.risk }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };
  Object.defineProperty(rule, 'spec', { value: Object.freeze(spec), enumerable: true });
  return rule;
}

/** The declarative spec a rule was built from, when it has one. */
export function policyRuleSpec(rule: PolicyRule): PolicyRuleSpec | undefined {
  return (rule as PolicyRule & { spec?: PolicyRuleSpec }).spec;
}

export const DEFAULT_RULES: PolicyRule[] = [
  policyRule({
    id: 'deny.filesystem.delete.production',
    description: 'Never delete production data without an explicit override',
    tools: ['filesystem.delete'],
    outcome: 'REQUIRE_APPROVAL',
    risk: 'CRITICAL',
    priority: 100,
    when: (action) => /prod|production|live/i.test(JSON.stringify(action.arguments)),
  }),
  policyRule({
    id: 'require-approval.git.push',
    description: 'Pushing to a remote repository always requires human approval',
    tools: ['git'],
    outcome: 'REQUIRE_APPROVAL',
    risk: 'CRITICAL',
    priority: 90,
    when: (action) => {
      const args = action.arguments;
      return args !== null && typeof args === 'object' && !Array.isArray(args) && (args as JsonObject)['operation'] === 'push';
    },
  }),
  policyRule({
    id: 'deny.terminal.force-push',
    description: 'Force-pushing rewrites shared history and is never allowed',
    tools: ['terminal.exec'],
    outcome: 'DENY',
    risk: 'CRITICAL',
    priority: 95,
    when: (action) => /\bgit\s+push\b[^\n]*--force|--force-with-lease/.test(commandString(action)),
  }),
];

export function assertAllowed(decision: PolicyDecision, toolId: string): void {
  if (decision.outcome === 'DENY') {
    throw new PolicyDeniedError(decision.reason, { toolId, ruleId: decision.ruleId, risk: decision.risk });
  }
}
