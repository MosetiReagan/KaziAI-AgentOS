import type { JsonObject } from '@kazi-ai/agentos-core';

export interface OutputOptions {
  json?: boolean;
  color?: boolean;
}

const ANSI = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  green: '\u001B[32m',
  red: '\u001B[31m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
} as const;

/** Writes the human-readable and `--json` forms of every command's result. */
export class Output {
  constructor(
    private readonly write: (text: string) => void = (text) => process.stdout.write(text),
    private readonly options: OutputOptions = {},
  ) {}

  get json(): boolean {
    return this.options.json === true;
  }

  private paint(color: keyof typeof ANSI, text: string): string {
    if (this.options.color === false) return text;
    return `${ANSI[color]}${text}${ANSI.reset}`;
  }

  line(text = ''): void {
    this.write(`${text}\n`);
  }

  title(text: string): void {
    this.line(this.paint('bold', text));
  }

  dim(text: string): void {
    this.line(this.paint('dim', text));
  }

  ok(text: string): void {
    this.line(`${this.paint('green', '✓')} ${text}`);
  }

  fail(text: string): void {
    this.line(`${this.paint('red', '✗')} ${text}`);
  }

  warn(text: string): void {
    this.line(`${this.paint('yellow', '!')} ${text}`);
  }

  info(text: string): void {
    this.line(`${this.paint('cyan', '·')} ${text}`);
  }

  keyValue(label: string, value: string): void {
    this.line(`${label.padEnd(14)} ${value}`);
  }

  table(rows: Array<Record<string, string>>, columns: string[]): void {
    if (rows.length === 0) {
      this.dim('(nothing to show)');
      return;
    }
    const widths = columns.map((column) =>
      Math.max(column.length, ...rows.map((row) => (row[column] ?? '').length)),
    );
    this.line(columns.map((column, index) => column.padEnd(widths[index] as number)).join('  '));
    for (const row of rows) {
      this.line(
        columns
          .map((column, index) => (row[column] ?? '').padEnd(widths[index] as number))
          .join('  '),
      );
    }
  }

  data(payload: JsonObject | JsonObject[] | string | number | boolean | null): void {
    this.line(JSON.stringify(payload, null, 2));
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds}s`;
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return 'unknown';
  return `$${usd.toFixed(3)}`;
}
