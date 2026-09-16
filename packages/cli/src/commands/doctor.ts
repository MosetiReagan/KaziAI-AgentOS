import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import type { AgentOSConfig } from '@kazi-ai/agentos-core';
import { Output } from '../output.js';
import type { CliContext } from '../context.js';

const run = promisify(execFile);

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What the operator should do about it, when something is wrong. */
  remediation?: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  ok: boolean;
}

/** Every probe `kazi-agent doctor` runs (spec §76). */
export async function doctor(context: CliContext): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  const config = context.config;

  checks.push(nodeCheck());
  checks.push(await dockerCheck(config));
  checks.push(await tcpCheck('Postgres', config.storage.databaseUrl, 5432, 'postgres'));
  checks.push(await tcpCheck('Redis', config.queue.redisUrl, 6379, 'redis'));
  checks.push(await apiCheck(config));
  checks.push(workersCheck(config));
  checks.push(providersCheck(context));
  checks.push(mcpCheck(context));
  checks.push(filesystemCheck(context));
  checks.push(permissionsCheck(config));
  checks.push(configurationCheck(config));

  return { checks, ok: checks.every((check) => check.status !== 'fail') };
}

function nodeCheck(): CheckResult {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    return {
      name: 'Node',
      status: 'fail',
      detail: `Node ${process.versions.node} is too old`,
      remediation: 'Install Node 20 or newer (see .nvmrc).',
    };
  }
  return { name: 'Node', status: 'ok', detail: `Node ${process.versions.node}` };
}

async function dockerCheck(config: AgentOSConfig): Promise<CheckResult> {
  const version = await tryRun('docker', ['--version']);
  if (!version) {
    return config.environment.kind === 'docker'
      ? {
          name: 'Docker',
          status: 'fail',
          detail: 'docker is not on PATH but environment.kind is "docker"',
          remediation:
            'Install Docker, or set KZ_ENVIRONMENT=local to run tools directly on the host.',
        }
      : {
          name: 'Docker',
          status: 'warn',
          detail: 'docker is not on PATH (not required: environment.kind is "local")',
          remediation: 'Install Docker to run agents in isolated containers (spec §71).',
        };
  }
  const daemon = await tryRun('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (!daemon) {
    return {
      name: 'Docker',
      status: 'warn',
      detail: `${version.trim()} installed but the daemon is not reachable`,
      remediation: 'Start Docker Desktop (or dockerd) before running container-based agents.',
    };
  }
  return { name: 'Docker', status: 'ok', detail: `${version.trim()} (daemon ${daemon.trim()})` };
}

async function tcpCheck(
  label: string,
  url: string | undefined,
  defaultPort: number,
  scheme: string,
): Promise<CheckResult> {
  if (!url) {
    return {
      name: label,
      status: 'warn',
      detail: `not configured (the embedded store/queue is in use)`,
      remediation: `Set ${scheme === 'postgres' ? 'DATABASE_URL' : 'REDIS_URL'} and KZ_STORAGE_DRIVER=postgres / KZ_QUEUE_DRIVER=bullmq for multi-worker deployments.`,
    };
  }
  let host: string;
  let port: number;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = Number(parsed.port || defaultPort);
  } catch {
    return {
      name: label,
      status: 'fail',
      detail: `cannot parse ${url}`,
      remediation: `Use a full connection URL, e.g. ${scheme}://user:pass@host:${defaultPort}/db`,
    };
  }
  const reachable = await tcpProbe(host, port);
  return reachable
    ? { name: label, status: 'ok', detail: `${host}:${port} reachable` }
    : {
        name: label,
        status: 'fail',
        detail: `${host}:${port} is not reachable`,
        remediation: `Start ${label} (docker compose up -d ${scheme}) or fix the connection URL.`,
      };
}

async function apiCheck(config: AgentOSConfig): Promise<CheckResult> {
  const url = `http://${config.api.host}:${config.api.port}/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) {
      return {
        name: 'API',
        status: 'warn',
        detail: `${url} answered ${response.status}`,
        remediation: 'Check the API logs; /health should return 200 with {"status":"ok"}.',
      };
    }
    return { name: 'API', status: 'ok', detail: `${url} is healthy` };
  } catch {
    return {
      name: 'API',
      status: 'warn',
      detail: `no API listening on ${config.api.host}:${config.api.port}`,
      remediation:
        'Start it with `pnpm --filter @kazi-ai/agentos-api dev` (or docker compose up -d api).',
    };
  }
}

function workersCheck(config: AgentOSConfig): CheckResult {
  if (config.queue.driver === 'inline') {
    return {
      name: 'Workers',
      status: 'ok',
      detail: 'queue.driver=inline: runs execute in the calling process',
      remediation: 'For long-running agents, set KZ_QUEUE_DRIVER=bullmq and run the worker app.',
    };
  }
  if (!config.queue.redisUrl) {
    return {
      name: 'Workers',
      status: 'fail',
      detail: 'queue.driver=bullmq requires REDIS_URL',
      remediation: 'Set REDIS_URL, or use KZ_QUEUE_DRIVER=inline for a single-process setup.',
    };
  }
  return { name: 'Workers', status: 'ok', detail: `bullmq via ${config.queue.redisUrl}` };
}

function providersCheck(context: CliContext): CheckResult {
  const providers = context.os.providers.ids();
  if (providers.length === 0) {
    return {
      name: 'Providers',
      status: 'fail',
      detail: 'no model providers are configured',
      remediation:
        'Set OPENAI_API_KEY (or ANTHROPIC_API_KEY / GEMINI_API_KEY / OLLAMA_BASE_URL), or declare providers in agentos.yaml.',
    };
  }
  return { name: 'Providers', status: 'ok', detail: providers.join(', ') };
}

function mcpCheck(context: CliContext): CheckResult {
  const configured = context.config.mcp.servers.length;
  const report = context.os.mcpReport();
  if (configured === 0) {
    return {
      name: 'MCP',
      status: 'warn',
      detail: 'no MCP servers configured',
      remediation: 'Configure MCP servers in agentos.yaml under `mcp.servers` (spec §19).',
    };
  }
  const unhealthy = report.statuses.filter((server) => !server.connected);
  if (unhealthy.length === 0) {
    return {
      name: 'MCP',
      status: 'ok',
      detail: `${report.statuses.length} server(s) connected, ${report.registeredTools.length} tool(s) exposed`,
    };
  }
  return {
    name: 'MCP',
    status: 'fail',
    detail: unhealthy
      .map((server) => `${server.id}: ${server.error?.message ?? 'unreachable'}`)
      .join('; '),
    remediation:
      'Check the MCP server command/URL and credentials in agentos.yaml, or set KZ_MCP_STRICT=false to start without them.',
  };
}

function filesystemCheck(context: CliContext): CheckResult {
  const root = context.config.environment.workspaceRoot;
  const dataDir = context.config.storage.dataDir ?? '.kazi';
  const workspaceRoot = `${context.cwd}/${root}`;
  const dataRoot = `${context.cwd}/${dataDir}`;
  const missing = [workspaceRoot, dataRoot].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    return {
      name: 'Filesystem',
      status: 'warn',
      detail: `not created yet: ${missing.join(', ')}`,
      remediation:
        'Run any agent once (or `kazi-agent init`) and the runtime creates its workspace root.',
    };
  }
  return { name: 'Filesystem', status: 'ok', detail: `${workspaceRoot} (writable)` };
}

function permissionsCheck(config: AgentOSConfig): CheckResult {
  const exposed = [config.environment.networkEnabled, config.environment.allowHostExecution];
  if (config.environment.networkEnabled && config.environment.allowHostExecution) {
    return {
      name: 'Permissions',
      status: 'warn',
      detail: 'host execution and network access are both enabled by default',
      remediation:
        'In production set KZ_NETWORK_ENABLED=false and KZ_ALLOW_HOST_EXECUTION=false, and grant per-agent permissions instead.',
    };
  }
  return {
    name: 'Permissions',
    status: 'ok',
    detail: `host execution=${String(exposed[1])}, network=${String(exposed[0])}`,
  };
}

function configurationCheck(config: AgentOSConfig): CheckResult {
  if (config.env === 'production' && !config.api.apiKey) {
    return {
      name: 'Configuration',
      status: 'fail',
      detail: 'env=production but the API has no apiKey',
      remediation: 'Set KZ_API_KEY, or use API keys per organization (spec §64).',
    };
  }
  const literalSecrets = Object.values(config.providers).filter((entry) =>
    (entry.apiKeyRef ?? '').includes('sk-'),
  );
  if (literalSecrets.length > 0) {
    return {
      name: 'Configuration',
      status: 'warn',
      detail: 'a provider appears to hold a literal API key',
      remediation:
        'Use an indirection such as env:OPENAI_API_KEY or secret://openai/token (spec §66).',
    };
  }
  return {
    name: 'Configuration',
    status: 'ok',
    detail: `env=${config.env}, logLevel=${config.logLevel}`,
  };
}

export function renderDoctor(output: Output, report: DoctorReport): void {
  output.title('KaziAI AgentOS doctor');
  output.line();
  for (const check of report.checks) {
    const label = check.name.padEnd(13);
    if (check.status === 'ok') output.ok(`${label} ${check.detail}`);
    else if (check.status === 'warn') output.warn(`${label} ${check.detail}`);
    else output.fail(`${label} ${check.detail}`);
    if (check.remediation && check.status !== 'ok') {
      output.dim(`              → ${check.remediation}`);
    }
  }
  output.line();
  const failed = report.checks.filter((check) => check.status === 'fail').length;
  const warned = report.checks.filter((check) => check.status === 'warn').length;
  if (failed > 0) output.fail(`${failed} check(s) failed, ${warned} warning(s)`);
  else if (warned > 0) output.warn(`${warned} warning(s); the runtime is usable`);
  else output.ok('everything checks out');
}

async function tryRun(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run(command, args, { timeout: 5_000 });
    return stdout;
  } catch {
    return undefined;
  }
}

function tcpProbe(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolveProbe(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}
