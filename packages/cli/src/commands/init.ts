import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Output } from '../output.js';

export interface InitOptions {
  cwd: string;
  force?: boolean;
}

export interface InitResult {
  created: string[];
  skipped: string[];
}

const CONFIG = `# KaziAI AgentOS configuration.
# Precedence: CLI flags > environment > this file > ~/.config/kazi-agentos/config.yaml > defaults.
env: development
logLevel: info

storage:
  # \`memory\` is the embedded, durable JSONL store: no external services needed.
  driver: memory
  dataDir: .kazi

queue:
  # \`inline\` runs jobs in the calling process; use \`bullmq\` with REDIS_URL to scale workers.
  driver: inline

environment:
  # \`local\` runs tools directly on this host; \`docker\` isolates every run in a container.
  kind: local
  workspaceRoot: .kazi/workspaces
  # Network access is off by default; grant it per agent or per run.
  networkEnabled: false

api:
  host: 127.0.0.1
  port: 4319

# Model providers. Keys are referenced, never inlined (spec §66).
# providers:
#   openai:
#     kind: openai-compatible
#     model: gpt-5.6
#     apiKeyRef: env:OPENAI_API_KEY

# MCP servers are connected at startup and their tools become mcp.<server>.<tool>.
# mcp:
#   strict: true
#   servers:
#     - id: github
#       transport: { type: http, url: "https://mcp.example/mcp" }
#       auth: { header: authorization, scheme: Bearer, secretRef: "secret://github/token" }
#       risk: HIGH
`;

const AGENT = `id: developer
version: 1.0.0
name: Developer

model:
  provider: openai
  model: gpt-5.6

system_prompt: |
  You are a software engineering agent.
  Work inside the workspace, verify your work by running the tests, and report what you changed.

tools:
  - filesystem
  - terminal
  - git

memory:
  enabled: true

planning:
  enabled: true

verification:
  enabled: true
  commands:
    - "true"

recovery:
  enabled: true

permissions:
  filesystem:
    read: true
    write: true
    delete: false
  terminal:
    execute: true
    # Commands run as your user on your machine, not in a container. That has to
    # be said out loud: a tool that needs an isolated sandbox is refused on a
    # host-process environment unless the run explicitly opts in. Drop this line
    # once agents run under the Docker environment.
    allow_unisolated: true
  network:
    enabled: false
  git:
    read: true
    commit: true
    push: false

limits:
  max_steps: 100
  max_tool_calls: 200
  max_cost_usd: 5
  max_duration_seconds: 1800
`;

/** `kazi-agent init`: a configuration file and one working agent definition. */
export function initProject(options: InitOptions, output: Output): InitResult {
  const files: Array<{ path: string; contents: string }> = [
    { path: join(options.cwd, 'agentos.yaml'), contents: CONFIG },
    { path: join(options.cwd, 'agents', 'developer.yaml'), contents: AGENT },
  ];
  const result: InitResult = { created: [], skipped: [] };
  for (const file of files) {
    if (existsSync(file.path) && options.force !== true) {
      result.skipped.push(file.path);
      continue;
    }
    mkdirSync(join(file.path, '..'), { recursive: true });
    writeFileSync(file.path, file.contents, 'utf8');
    result.created.push(file.path);
  }

  if (!output.json) {
    for (const path of result.created) output.ok(`created ${path}`);
    for (const path of result.skipped)
      output.warn(`${path} already exists (use --force to overwrite)`);
    if (result.created.length > 0) {
      output.line();
      output.dim('Next: set OPENAI_API_KEY, then run `kazi-agent run developer --goal "..."`.');
    }
  }
  return result;
}
