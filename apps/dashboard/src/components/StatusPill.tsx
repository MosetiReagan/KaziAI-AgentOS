import type { RunState } from '../api/types.js';
import { statusTone } from '../lib/state.js';
import { Pill } from './ui.js';

export function StatusPill({ status }: { status: RunState }) {
  return <Pill tone={statusTone(status)}>{status}</Pill>;
}
