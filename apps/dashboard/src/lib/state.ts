import type { RunState } from '../api/types.js';

export const TERMINAL_STATES: RunState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

export const ACTIVE_STATES: RunState[] = [
  'QUEUED',
  'INITIALIZING',
  'PLANNING',
  'EXECUTING',
  'OBSERVING',
  'VERIFYING',
  'RECOVERING',
];

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The phase a run is in, in the runtime's own vocabulary. */
export function phaseOf(state: RunState): string {
  switch (state) {
    case 'CREATED':
      return 'created, not queued';
    case 'QUEUED':
      return 'waiting for a worker';
    case 'INITIALIZING':
      return 'initializing';
    case 'PLANNING':
      return 'planning';
    case 'EXECUTING':
      return 'executing';
    case 'OBSERVING':
      return 'observing';
    case 'VERIFYING':
      return 'verifying';
    case 'RECOVERING':
      return 'recovering';
    case 'WAITING':
      return 'waiting for a human';
    case 'PAUSED':
      return 'paused';
    default:
      return state.toLowerCase().replace('_', ' ');
  }
}

export type StatusTone = 'neutral' | 'info' | 'success' | 'warn' | 'danger';

export function statusTone(state: RunState): StatusTone {
  switch (state) {
    case 'COMPLETED':
      return 'success';
    case 'FAILED':
    case 'TIMED_OUT':
      return 'danger';
    case 'CANCELLED':
    case 'PAUSED':
    case 'WAITING':
      return 'warn';
    case 'QUEUED':
    case 'CREATED':
      return 'neutral';
    default:
      return 'info';
  }
}

export function riskTone(risk: string | undefined): StatusTone {
  switch (risk) {
    case 'CRITICAL':
      return 'danger';
    case 'HIGH':
      return 'warn';
    case 'MEDIUM':
      return 'info';
    case 'LOW':
      return 'neutral';
    default:
      return 'neutral';
  }
}
