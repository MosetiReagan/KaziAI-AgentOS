import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRun, AgentRunInput, AgentRunResult } from '@kazi-ai/agentos-core';
import { BenchAdapter } from './adapter.js';
import { parseBenchCase, type BenchCase, type BenchCaseInput, type BenchRunExport, type ExpectationResult } from './types.js';

/** The part of the runtime a Bench case needs; keeps the adapter decoupled. */
export interface BenchRuntime {
  createRun(input: AgentRunInput): Promise<AgentRun>;
  start(runId: string): Promise<void>;
  getRun(runId: string): Promise<AgentRun>;
  /** The runtime's own standardized result, when it exposes one. */
  result?(runId: string): Promise<AgentRunResult>;
}

export interface BenchRunnerOptions {
  runtime: BenchRuntime;
  adapter: BenchAdapter;
  /**
   * Build the run input for a case. The agent definition (or the benchmark's
   * own configuration) decides the tools and permissions the agent gets; the
   * runner never invents them.
   */
  buildRunInput(benchCase: BenchCase): AgentRunInput | Promise<AgentRunInput>;
  /** Polling interval while waiting for a run to finish, in ms. */
  pollIntervalMs?: number;
  /** Give up waiting after this long and record the case as unfinished. */
  timeoutMs?: number;
  now?: () => number;
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/**
 * Runs Bench cases against a real AgentOS runtime: prepare the workspace, run
 * the agent, then grade the *workspace*, not the agent's own claim of success.
 */
export class BenchRunner {
  private readonly now: () => number;

  constructor(private readonly options: BenchRunnerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async runCase(input: BenchCaseInput | BenchCase): Promise<BenchRunExport> {
    const benchCase = parseBenchCase(input);
    const runInput = await this.options.buildRunInput(benchCase);
    const run = await this.options.runtime.createRun({
      ...runInput,
      goal: runInput.goal || benchCase.goal,
      agentId: runInput.agentId || benchCase.agentId,
      metadata: { ...(runInput.metadata ?? {}), benchCase: benchCase.id, benchCaseName: benchCase.name },
    });

    this.setupWorkspace(run.workspaceDir, benchCase);
    await this.options.runtime.start(run.id);
    const finished = await this.waitForRun(run.id);
    const runtimeResult = await this.options.runtime.result?.(run.id);
    const exported = await this.options.adapter.exportRun(run.id, {
      caseId: benchCase.id,
      ...(runtimeResult === undefined ? {} : { result: runtimeResult }),
    });

    const expectations = this.grade(benchCase, finished, exported.result.verification);
    return {
      ...exported,
      expectations,
      caseSuccess: exported.result.success && expectations.every((expectation) => expectation.passed),
    };
  }

  async runCases(cases: Array<BenchCaseInput | BenchCase>): Promise<BenchRunExport[]> {
    const exports: BenchRunExport[] = [];
    for (const benchCase of cases) exports.push(await this.runCase(benchCase));
    return exports;
  }

  /** The command KaziAI Bench runs when it launches an AgentOS agent. */
  launchCommand(input: BenchCaseInput | BenchCase, options: { bin?: string } = {}): string {
    const benchCase = parseBenchCase(input);
    const bin = options.bin ?? 'kazi-agent';
    return `${bin} run ${benchCase.agentId} --goal ${quote(benchCase.goal)} --case ${benchCase.id}`;
  }

  private setupWorkspace(workspaceDir: string, benchCase: BenchCase): void {
    for (const file of benchCase.setup.files) {
      const target = join(workspaceDir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
  }

  private async waitForRun(runId: string): Promise<AgentRun> {
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const interval = this.options.pollIntervalMs ?? 10;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const run = await this.options.runtime.getRun(runId);
      if (TERMINAL.has(run.status)) return run;
      if (this.now() >= deadline) return run;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  /**
   * Expectations are checked against the workspace the agent actually left
   * behind. An agent that says it fixed the tests but did not is a failure.
   */
  private grade(
    benchCase: BenchCase,
    run: AgentRun,
    verification: { passed: boolean; summary: string } | undefined,
  ): ExpectationResult[] {
    const results: ExpectationResult[] = [];

    for (const expectation of benchCase.expectations.files) {
      const target = join(run.workspaceDir, expectation.path);
      const exists = existsSync(target);
      if (expectation.exists === true || expectation.exists === false) {
        const expected = expectation.exists;
        results.push({
          name: `file ${expectation.path} ${expected ? 'exists' : 'does not exist'}`,
          passed: exists === expected,
          detail: exists ? 'the file is present' : 'the file is missing',
        });
      }
      if (expectation.absent === true) {
        results.push({
          name: `file ${expectation.path} is absent`,
          passed: !exists,
          detail: exists ? 'the file still exists' : 'the file is gone',
        });
      }
      if (expectation.contains !== undefined) {
        const content = exists ? readFileSync(target, 'utf8') : '';
        results.push({
          name: `file ${expectation.path} contains ${JSON.stringify(expectation.contains)}`,
          passed: content.includes(expectation.contains),
          detail: exists ? 'content checked' : 'the file is missing',
        });
      }
    }

    if (benchCase.expectations.verification !== 'optional') {
      const passed = verification?.passed === true;
      results.push({
        name: `verification ${benchCase.expectations.verification}`,
        passed: benchCase.expectations.verification === 'required' ? passed : !passed,
        detail: passed ? 'verification passed' : 'no passing verification was recorded',
      });
    }

    results.push({
      name: 'run completed',
      passed: run.status === 'COMPLETED',
      detail: `run ended as ${run.status}`,
    });
    return results;
  }
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
