import type { AgentAction, JsonObject, PolicyContext, PolicyDecision, PolicyProvider } from '@kazi-ai/agentos-core';
import { PolicyDeniedError } from '@kazi-ai/agentos-core';

export interface RemotePolicyProviderOptions {
  id: string;
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Adapter for an external authorization service (KaziAI Sentinel). It is
 * deliberately optional: the local policy engine must stand on its own, and a
 * failing remote provider fails closed rather than allowing the action.
 */
export class RemotePolicyProvider implements PolicyProvider {
  readonly id: string;

  constructor(private readonly options: RemotePolicyProviderOptions) {
    this.id = options.id;
  }

  async authorize(action: AgentAction, context: PolicyContext): Promise<PolicyDecision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ action, context }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          outcome: 'DENY',
          ruleId: `${this.id}:http_${response.status}`,
          reason: `Remote policy provider returned ${response.status}; failing closed`,
          risk: 'HIGH',
        };
      }
      const payload = (await response.json()) as Partial<PolicyDecision> & JsonObject;
      const outcome = payload.outcome;
      if (outcome !== 'ALLOW' && outcome !== 'DENY' && outcome !== 'REQUIRE_APPROVAL') {
        throw new PolicyDeniedError('Remote policy provider returned an invalid outcome');
      }
      return {
        outcome,
        ruleId: typeof payload.ruleId === 'string' ? payload.ruleId : `${this.id}:remote`,
        reason: typeof payload.reason === 'string' ? payload.reason : 'remote decision',
        risk: (payload.risk as PolicyDecision['risk']) ?? 'MEDIUM',
      };
    } catch (error) {
      return {
        outcome: 'DENY',
        ruleId: `${this.id}:unavailable`,
        reason: `Remote policy provider unavailable: ${(error as Error).message}`,
        risk: 'HIGH',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface CompositePolicyOptions {
  local: PolicyProvider;
  remote?: PolicyProvider;
}

/** Combine local rules with an optional remote authorizer using most-restrictive-wins. */
export class CompositePolicyProvider implements PolicyProvider {
  constructor(private readonly options: CompositePolicyOptions) {}

  async authorize(action: AgentAction, context: PolicyContext): Promise<PolicyDecision> {
    const local = await this.options.local.authorize(action, context);
    if (!this.options.remote) return local;
    const remote = await this.options.remote.authorize(action, context);
    return mostRestrictive(local, remote);
  }
}

const OUTCOME_ORDER: Record<PolicyDecision['outcome'], number> = { ALLOW: 0, REQUIRE_APPROVAL: 1, DENY: 2 };

export function mostRestrictive(left: PolicyDecision, right: PolicyDecision): PolicyDecision {
  if (OUTCOME_ORDER[left.outcome] >= OUTCOME_ORDER[right.outcome]) {
    return { ...left, ruleId: `${left.ruleId}+${right.ruleId}` };
  }
  return { ...right, ruleId: `${left.ruleId}+${right.ruleId}` };
}

