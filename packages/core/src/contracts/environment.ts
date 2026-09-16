import type { JsonObject } from '../json.js';
import type { EnvironmentSnapshot } from './checkpoint.js';
import type { ShellCommand, ShellExecutionOptions, ShellResult } from './tool.js';

/**
 * An execution environment isolates agent tool execution. Docker is the initial
 * implementation; the interface deliberately avoids Docker-specific concepts.
 */
export interface ExecutionEnvironment {
  readonly kind: string;
  create(): Promise<void>;
  execute(command: ShellCommand, options?: ShellExecutionOptions): Promise<ShellResult>;
  snapshot(): Promise<EnvironmentSnapshot>;
  restore(snapshot: EnvironmentSnapshot): Promise<void>;
  destroy(): Promise<void>;
  /** Host path that maps to the environment's working directory. */
  workspaceDir(): string;
  /** Container-side working directory when different from the host path. */
  containerWorkspaceDir?(): string;
  isReady(): Promise<boolean>;
  metadata(): JsonObject;
}

export interface EnvironmentProvider {
  readonly kind: string;
  create(run: { runId: string; organizationId: string; workspaceDir: string }): Promise<ExecutionEnvironment>;
  available(): Promise<boolean>;
  /** Human-readable remediation when the environment is unavailable. */
  remediation?(): string;
}

