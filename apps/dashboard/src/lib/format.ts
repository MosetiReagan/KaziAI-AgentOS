/** Formatting is pure and total: a dashboard must never render "NaN" or "-". */

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0.000';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens)) return '—';
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'B'}`;
}

export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}

export function formatPercent(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

export function formatTime(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return '—';
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

export function formatDateTime(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return '—';
  return new Date(at).toLocaleString(undefined, { hour12: false });
}

/** Short, stable, human-readable age: 12s, 4m, 3h, 2d. */
export function formatAge(at: number | undefined, now = Date.now()): string {
  if (at === undefined || !Number.isFinite(at)) return '—';
  const delta = now - at;
  if (delta < 0) return 'now';
  if (delta < 1_000) return 'now';
  const seconds = Math.floor(delta / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function truncateId(id: string, length = 12): string {
  if (id.length <= length) return id;
  return `${id.slice(0, length)}…`;
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
