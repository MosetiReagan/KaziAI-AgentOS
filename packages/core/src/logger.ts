import { redact, redactString } from './redact.js';
import { toJsonValue, type JsonValue } from './json.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  time: string;
  level: LogLevel;
  msg: string;
  [key: string]: JsonValue;
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
  name?: string;
}

function defaultSink(record: LogRecord): void {
  const line = `${JSON.stringify(record)}\n`;
  if (record.level === 'error' || record.level === 'warn') process.stderr.write(line);
  else process.stdout.write(line);
}

export class StructuredLogger implements Logger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly bindings: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? ((process.env.KZ_LOG_LEVEL as LogLevel | undefined) || 'info');
    this.sink = options.sink ?? defaultSink;
    this.bindings = { ...(options.name ? { logger: options.name } : {}), ...(options.bindings ?? {}) };
  }

  child(bindings: Record<string, unknown>): Logger {
    return new StructuredLogger({
      level: this.level,
      sink: this.sink,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const merged = redact({ ...this.bindings, ...(fields ?? {}) }) as Record<string, unknown>;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      msg: redactString(msg),
      ...(toJsonValue(merged) as Record<string, JsonValue>),
    };
    try {
      this.sink(record);
    } catch {
      // A logging sink must never take down the runtime.
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields);
  }
}

export class NullLogger implements Logger {
  child(): Logger {
    return this;
  }
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

export interface LogCapture {
  records: LogRecord[];
  logger: Logger;
}

/** In-memory logger used by tests to assert on emitted records. */
export function captureLogger(options: LoggerOptions = {}): LogCapture {
  const records: LogRecord[] = [];
  const logger = new StructuredLogger({
    ...options,
    sink: (record) => {
      records.push(record);
      options.sink?.(record);
    },
  });
  return { records, logger };
}

