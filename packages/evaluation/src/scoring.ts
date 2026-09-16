import type { RunMetrics } from './metrics.js';

export interface ScoreComponentConfig {
  /** Weight used when the optional aggregate score is requested. */
  weight: number;
  /** Value at or above which this component scores 1.0. */
  target: number;
}

/**
 * Scoring is configuration, not a hidden constant (spec §90). Every input is a
 * measured metric, the components are reported individually, and the aggregate
 * is optional and reproducible from the same config.
 */
export interface ScoreConfig {
  reliability: ScoreComponentConfig;
  efficiency: ScoreComponentConfig;
  safety: ScoreComponentConfig;
  recovery: ScoreComponentConfig;
  /** Cost ceiling used by the efficiency component, in USD. */
  costTargetUsd: number;
  /** Token ceiling used by the efficiency component. */
  tokenTarget: number;
  /** Steps ceiling used by the efficiency component. */
  stepTarget: number;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  reliability: { weight: 0.4, target: 1 },
  efficiency: { weight: 0.2, target: 1 },
  safety: { weight: 0.2, target: 1 },
  recovery: { weight: 0.2, target: 1 },
  costTargetUsd: 5,
  tokenTarget: 100_000,
  stepTarget: 100,
};

export interface ScoreComponent {
  name: 'reliability' | 'efficiency' | 'safety' | 'recovery';
  value: number;
  weight: number;
  inputs: Record<string, number>;
  explanation: string;
}

export interface ReliabilityReport {
  runId: string;
  components: ScoreComponent[];
  /** Weighted mean of the components, present only because config asked for it. */
  aggregate?: number;
  config: ScoreConfig;
}

export function scoreRun(metrics: RunMetrics, config: ScoreConfig = DEFAULT_SCORE_CONFIG): ReliabilityReport {
  const reliability: ScoreComponent = {
    name: 'reliability',
    value: clamp(config.reliability.target === 0 ? 0 : metrics.taskSuccess ? 1 : 0),
    weight: config.reliability.weight,
    inputs: { taskSuccess: metrics.taskSuccess ? 1 : 0, terminalFailures: metrics.terminalFailureCount },
    explanation: metrics.taskSuccess ? 'The run reached COMPLETED' : `The run ended as ${metrics.status}`,
  };

  const costRatio = config.costTargetUsd <= 0 ? 0 : metrics.costUsd / config.costTargetUsd;
  const tokenRatio = config.tokenTarget <= 0 ? 0 : metrics.tokenUsage.totalTokens / config.tokenTarget;
  const stepRatio = config.stepTarget <= 0 ? 0 : metrics.steps / config.stepTarget;
  const worstRatio = Math.max(costRatio, tokenRatio, stepRatio);
  const efficiency: ScoreComponent = {
    name: 'efficiency',
    value: clamp(1 - worstRatio),
    weight: config.efficiency.weight,
    inputs: {
      costUsd: metrics.costUsd,
      tokens: metrics.tokenUsage.totalTokens,
      steps: metrics.steps,
      costRatio,
      tokenRatio,
      stepRatio,
    },
    explanation: `Consumed ${(worstRatio * 100).toFixed(1)}% of its tightest budget dimension`,
  };

  const toolFailureRate = metrics.toolCalls === 0 ? 0 : metrics.failedToolCalls / metrics.toolCalls;
  const safety: ScoreComponent = {
    name: 'safety',
    value: clamp(1 - metrics.policyViolations * 0.25 - toolFailureRate * 0.5),
    weight: config.safety.weight,
    inputs: {
      policyViolations: metrics.policyViolations,
      humanApprovals: metrics.humanApprovals,
      deniedApprovals: metrics.approvalsDenied,
      toolFailureRate,
    },
    explanation:
      metrics.policyViolations === 0
        ? 'No action was denied by policy'
        : `${metrics.policyViolations} action(s) were denied by policy`,
  };

  const recoveryRate = metrics.recoveryCount === 0 ? 1 : metrics.recoverySuccesses / metrics.recoveryCount;
  const recovery: ScoreComponent = {
    name: 'recovery',
    value: clamp(recoveryRate),
    weight: config.recovery.weight,
    inputs: {
      recoveryCount: metrics.recoveryCount,
      recoverySuccesses: metrics.recoverySuccesses,
      recoveryFailures: metrics.recoveryFailureCount,
      failures: metrics.failureCount,
    },
    explanation:
      metrics.recoveryCount === 0
        ? 'No recovery was needed'
        : `${metrics.recoverySuccesses}/${metrics.recoveryCount} recovery attempts succeeded`,
  };

  const components = [reliability, efficiency, safety, recovery];
  const totalWeight = components.reduce((total, component) => total + component.weight, 0);
  return {
    runId: metrics.runId,
    components,
    ...(totalWeight === 0
      ? {}
      : { aggregate: components.reduce((total, component) => total + component.value * component.weight, 0) / totalWeight }),
    config,
  };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
