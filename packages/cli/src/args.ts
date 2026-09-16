import { ValidationError } from '@kazi-ai/agentos-core';

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Everything after `--`, passed through untouched. */
  rest: string[];
}

const BOOLEAN_FLAGS = new Set([
  'help',
  'version',
  'json',
  'follow',
  'verbose',
  'yes',
  'force',
  'no-color',
  'watch',
]);

/**
 * Minimal, predictable argument parser: `--flag value`, `--flag=value`,
 * `--bool`, `-h`, and positionals. Anything after `--` is preserved verbatim so
 * a goal can contain dashes without escaping.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let sawSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (sawSeparator) {
      rest.push(token);
      continue;
    }
    if (token === '--') {
      sawSeparator = true;
      continue;
    }
    if (token === '-h') {
      flags['help'] = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      if (equals >= 0) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        flags[body] = true;
        continue;
      }
      flags[body] = next;
      index += 1;
      continue;
    }
    positionals.push(token);
  }

  const [command, ...args] = positionals;
  return { ...(command ? { command } : {}), positionals: args, flags, rest };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`--${name} must be a number`, { value });
  }
  return parsed;
}

export function requireArg(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new ValidationError(`Missing required argument: ${name}`);
  }
  return value;
}
