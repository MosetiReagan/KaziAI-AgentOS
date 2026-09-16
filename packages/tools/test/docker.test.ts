import { describe, expect, it } from 'vitest';
import { DockerExecutionEnvironment, type DockerRunner, type DockerRunResult } from '../src/index.js';

function recordingRunner(handler?: (args: string[]) => Partial<DockerRunResult>): { runner: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: DockerRunner = {
    run: async (args) => {
      calls.push(args);
      const override = handler?.(args) ?? {};
      const defaultStdout = args[0] === 'run' ? 'container123\n' : args[0] === 'inspect' ? 'true' : '';
      return {
        code: override.code ?? 0,
        stdout: override.stdout ?? defaultStdout,
        stderr: override.stderr ?? '',
        timedOut: override.timedOut ?? false,
        durationMs: 5,
      };
    },
  };
  return { runner, calls };
}

describe('docker environment', () => {
  it('creates a locked-down container: no network, dropped capabilities, resource caps', async () => {
    const { runner, calls } = recordingRunner();
    const environment = new DockerExecutionEnvironment({
      workspaceDir: '/tmp/ws',
      image: 'node:20-bookworm-slim',
      runner,
    });
    await environment.create();
    const args = calls[0] ?? [];
    expect(args.slice(0, 3)).toEqual(['run', '-d', '--rm']);
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('--memory');
    expect(args).toContain('--security-opt');
    expect(args).toContain('/tmp/ws:/workspace');
    expect(await environment.isReady()).toBe(true);
  });

  it('enables the bridge network only when explicitly configured', async () => {
    const { runner, calls } = recordingRunner();
    const environment = new DockerExecutionEnvironment({ workspaceDir: '/tmp/ws', image: 'img', networkEnabled: true, runner });
    await environment.create();
    const args = calls[0] ?? [];
    expect(args[args.indexOf('--network') + 1]).toBe('bridge');
  });

  it('executes commands through docker exec in the container workdir', async () => {
    const { runner, calls } = recordingRunner((args) => (args[0] === 'exec' ? { stdout: 'output' } : {}));
    const environment = new DockerExecutionEnvironment({ workspaceDir: '/tmp/ws', image: 'img', runner });
    await environment.create();
    const result = await environment.execute({ command: 'npm', args: ['test'] });
    expect(result.stdout).toBe('output');
    const execArgs = calls[1] ?? [];
    expect(execArgs.slice(0, 2)).toEqual(['exec', '-i']);
    expect(execArgs.join(' ')).toContain('npm');
    expect(environment.containerWorkspaceDir()).toBe('/workspace');
  });

  it('quotes arguments so a crafted argument cannot inject another command', async () => {
    const { runner, calls } = recordingRunner();
    const environment = new DockerExecutionEnvironment({ workspaceDir: '/tmp/ws', image: 'img', runner });
    await environment.create();
    await environment.execute({ command: 'echo', args: ['x; rm -rf /'] });
    const execArgs = calls[1] ?? [];
    expect(execArgs[execArgs.length - 1]).toBe("echo 'x; rm -rf /'");
  });

  it('reports a failed container start with a retryable error', async () => {
    const { runner } = recordingRunner(() => ({ code: 125, stderr: 'image not found' }));
    const environment = new DockerExecutionEnvironment({ workspaceDir: '/tmp/ws', image: 'missing', runner });
    await expect(environment.create()).rejects.toMatchObject({ code: 'environment.docker_start_failed', retryable: true });
  });

  it('destroys the container on cleanup', async () => {
    const { runner, calls } = recordingRunner();
    const environment = new DockerExecutionEnvironment({ workspaceDir: '/tmp/ws', image: 'img', runner });
    await environment.create();
    await environment.destroy();
    expect(calls[1]).toEqual(['rm', '-f', 'container123']);
    expect(await environment.isReady()).toBe(false);
  });
});
