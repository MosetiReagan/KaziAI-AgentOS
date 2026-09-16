import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StubTurn {
  content?: string;
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown>; id?: string }>;
  status?: number;
  error?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface StubProvider {
  baseUrl: string;
  port: number;
  /** Every chat-completion request the stub received, in order. */
  requests(): Promise<Array<Record<string, unknown>>>;
  stop(): Promise<void>;
  /** A provider entry suitable for `agentos.yaml`. */
  configEntry(id?: string): {
    kind: 'openai-compatible';
    baseUrl: string;
    model: string;
  };
}

const SERVER = fileURLToPath(new URL('../fixtures/openai-server.mjs', import.meta.url));

/**
 * Start the OpenAI-compatible stub over a real socket. Tests use it so provider
 * integration is exercised end to end (HTTP, headers, wire format, tool calls)
 * without depending on a live model API (spec §87).
 */
export async function startStubProvider(turns: StubTurn[]): Promise<StubProvider> {
  const dir = mkdtempSync(join(tmpdir(), 'kazi-stub-'));
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(turns), 'utf8');

  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OPENAI_SCRIPT: scriptPath, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('stub provider did not start in time')),
      10_000,
    );
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const parsed = JSON.parse(buffer.slice(0, newline)) as { port: number };
      clearTimeout(timer);
      resolve(parsed.port);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  return {
    baseUrl,
    port,
    async requests() {
      const response = await fetch(`http://127.0.0.1:${port}/requests`);
      return (await response.json()) as Array<Record<string, unknown>>;
    },
    async stop() {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      });
    },
    configEntry() {
      return { kind: 'openai-compatible' as const, baseUrl, model: 'stub-model' };
    },
  };
}
