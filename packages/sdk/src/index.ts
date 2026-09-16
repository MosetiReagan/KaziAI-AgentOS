/**
 * `@kazi-ai/agentos` — the KaziAI AgentOS SDK.
 *
 * Declare an agent, run it durably, and inspect everything it did:
 *
 * ```ts
 * import { createAgentOS } from '@kazi-ai/agentos';
 *
 * const os = await createAgentOS({ dataDir: './.kazi', organizationId: 'org', projectId: 'prj' });
 * const agent = os.agent({
 *   id: 'developer',
 *   model: { provider: 'openai', model: 'gpt-5.6' },
 *   tools: ['filesystem', 'terminal', 'git'],
 * });
 *
 * const result = await agent.run({ goal: 'Fix the failing tests in this repository.' });
 * ```
 */
export * from './agent.js';
export * from './agentos.js';
export * from './providers-from-env.js';

// The building blocks an agent author needs, re-exported so a definition and a
// custom tool can be written without depending on internal packages (spec §73).
export {
  defineTool,
  jsonValueOf,
  type DefineToolOptions,
  type ZodSchemaLike,
} from '@kazi-ai/agentos-tools';
export {
  AgentError,
  ToolExecutionError,
  ToolInputError,
  ToolTimeoutError,
  ProviderError,
  ValidationError,
  ConfigurationError,
  newActionId,
  newPlanId,
  newRunId,
  newStepId,
  newTraceId,
  toolResult,
  type AgentAction,
  type AgentRun,
  type AgentRunInput,
  type AgentRunResult,
  type AgentState,
  type AgentTool,
  type Checkpoint,
  type CheckpointRef,
  type FailureClassification,
  type JsonObject,
  type JsonValue,
  type Plan,
  type PlanStep,
  type Planner,
  type PlanningContext,
  type PolicyDecision,
  type PolicyRule,
  type RecoveryDecision,
  type RunLimits,
  type RunState,
  type RunUsage,
  type TokenUsage,
  type ToolCallRequest,
  type ToolContext,
  type ModelProvider,
  type ToolPermissions,
  type ToolResult,
  type Trace,
} from '@kazi-ai/agentos-core';
export type {
  ProgressVerifier,
  VerificationResult,
  ReplayReport,
  ForkRunOptions,
} from '@kazi-ai/agentos-runtime';
export {
  parseAgentDefinition,
  parseAgentDefinitionYaml,
  type AgentDefinition,
} from '@kazi-ai/agentos-agent';
export { ModelProviderRegistry } from '@kazi-ai/agentos-providers';
export {
  DEFAULT_RULES,
  DEFAULT_RISK_RULES,
  DefaultPolicyEngine,
  RiskClassifier,
  policyRule,
  type RiskRule,
} from '@kazi-ai/agentos-policies';
export { DefaultToolRegistry } from '@kazi-ai/agentos-tools';
export { AgentOSRuntime, type AgentOSRuntimeOptions } from '@kazi-ai/agentos-runtime';
