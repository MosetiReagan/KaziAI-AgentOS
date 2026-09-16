import { describe, expect, it } from 'vitest';
import { createTerminalExecTool, createTestToolContext } from '../src/index.js';

const execPermissions = { terminal: { execute: true } };

describe('terminal tool', () => {
  it('executes a command inside the workspace without a shell', async () => {
    const context = await createTestToolContext({ permissions: execPermissions });
    const result = await createTerminalExecTool().execute({ command: 'node', args: ['-e', 'console.log("hi")'] }, context);
    expect(result.success).toBe(true);
    expect((result.output as { stdout: string }).stdout.trim()).toBe('hi');
    expect((result.output as { exit_code: number }).exit_code).toBe(0);
  });

  it('does not perform shell interpolation on arguments', async () => {
    const context = await createTestToolContext({ permissions: execPermissions });
    const result = await createTerminalExecTool().execute(
      { command: 'node', args: ['-e', 'console.log(process.argv[1])', '; echo pwned'] },
      context,
    );
    expect((result.output as { stdout: string }).stdout.trim()).toBe('; echo pwned');
  });

  it('reports a non-zero exit code as a failed result rather than throwing', async () => {
    const context = await createTestToolContext({ permissions: execPermissions });
    const result = await createTerminalExecTool().execute({ command: 'node', args: ['-e', 'process.exit(3)'] }, context);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('tool.command_failed');
  });

  it('kills commands that exceed the timeout', async () => {
    const context = await createTestToolContext({ permissions: execPermissions });
    const result = await createTerminalExecTool({ defaultTimeoutMs: 100, maxTimeoutMs: 200 }).execute(
      { command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'] },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('tool.timeout');
    expect((result.output as { timed_out: boolean }).timed_out).toBe(true);
  }, 20_000);

  it('truncates large output instead of exhausting memory', async () => {
    const context = await createTestToolContext({ permissions: execPermissions });
    const result = await createTerminalExecTool({ maxStdoutBytes: 1_024 }).execute(
      { command: 'node', args: ['-e', 'process.stdout.write("x".repeat(100000))'] },
      context,
    );
    expect((result.output as { stdout_truncated: boolean }).stdout_truncated).toBe(true);
    expect((result.output as { stdout: string }).stdout.length).toBeLessThanOrEqual(1_024);
  });

  it('denies execution when the permission is absent', async () => {
    const context = await createTestToolContext({ permissions: {} });
    await expect(createTerminalExecTool().execute({ command: 'node', args: ['-v'] }, context)).rejects.toMatchObject({
      code: 'tool.permission_denied',
    });
  });

  it('never exposes the host environment to the command', async () => {
    const context = await createTestToolContext({ permissions: execPermissions });
    const result = await createTerminalExecTool().execute(
      { command: 'node', args: ['-e', 'console.log(JSON.stringify({ home: process.env.HOME, kazi: process.env.KAZI_SANDBOX, secret: process.env.KZ_SECRET_PROBE ?? "absent" }))'] },
      context,
    );
    const parsed = JSON.parse((result.output as { stdout: string }).stdout) as {
      home: string;
      kazi: string;
      secret: string;
    };
    expect(parsed.kazi).toBe('1');
    expect(parsed.home).toContain('kazi-ws-');
    expect(parsed.secret).toBe('absent');
  });
});

