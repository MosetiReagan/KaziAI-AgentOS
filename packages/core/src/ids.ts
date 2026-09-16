import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const TIME_MAX = 281_474_976_710_655;

let lastTime = -1;
let lastRandomChars: string[] = [];

function encodeTime(time: number): string {
  let remaining = time;
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    const mod = remaining % ENCODING_LEN;
    out = (ENCODING[mod] ?? '0') + out;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return out;
}

function randomChars(): string[] {
  const bytes = randomBytes(RANDOM_LEN);
  const chars: string[] = [];
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    const byte = bytes[i] ?? 0;
    chars.push(ENCODING[byte % ENCODING_LEN] ?? '0');
  }
  return chars;
}

/** Increment the randomness component so identifiers inside one millisecond stay sortable. */
function incrementRandom(chars: string[]): string[] {
  const next = [...chars];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const value = ENCODING.indexOf(next[i] ?? '0');
    if (value < ENCODING_LEN - 1) {
      next[i] = ENCODING[value + 1] ?? '0';
      return next;
    }
    next[i] = ENCODING[0] ?? '0';
  }
  return randomChars();
}

/** Generate a lexicographically sortable ULID. */
export function ulid(now: number = Date.now()): string {
  if (now > TIME_MAX) throw new Error('Cannot generate ULID beyond year 10889');
  if (now === lastTime) {
    lastRandomChars = incrementRandom(lastRandomChars);
  } else {
    lastTime = now;
    lastRandomChars = randomChars();
  }
  return encodeTime(now) + lastRandomChars.join('');
}

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type RunId = Brand<string, 'RunId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type StepId = Brand<string, 'StepId'>;
export type ActionId = Brand<string, 'ActionId'>;
export type ToolCallId = Brand<string, 'ToolCallId'>;
export type CheckpointId = Brand<string, 'CheckpointId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type EventId = Brand<string, 'EventId'>;
export type OrganizationId = Brand<string, 'OrganizationId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type TraceId = Brand<string, 'TraceId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type MemoryId = Brand<string, 'MemoryId'>;
export type JobId = Brand<string, 'JobId'>;

type Prefixed<T extends string> = (now?: number) => Brand<string, T>;

function prefixed<T extends string>(prefix: string): Prefixed<T> {
  return (now?: number) => `${prefix}_${ulid(now)}` as Brand<string, T>;
}

export const newRunId: Prefixed<'RunId'> = prefixed('run');
export const newAgentId: Prefixed<'AgentId'> = prefixed('agt');
export const newStepId: Prefixed<'StepId'> = prefixed('stp');
export const newActionId: Prefixed<'ActionId'> = prefixed('act');
export const newToolCallId: Prefixed<'ToolCallId'> = prefixed('tcl');
export const newCheckpointId: Prefixed<'CheckpointId'> = prefixed('cp');
export const newPlanId: Prefixed<'PlanId'> = prefixed('pln');
export const newApprovalId: Prefixed<'ApprovalId'> = prefixed('apr');
export const newEventId: Prefixed<'EventId'> = prefixed('evt');
export const newOrganizationId: Prefixed<'OrganizationId'> = prefixed('org');
export const newProjectId: Prefixed<'ProjectId'> = prefixed('prj');
export const newTraceId: Prefixed<'TraceId'> = prefixed('trc');
export const newArtifactId: Prefixed<'ArtifactId'> = prefixed('art');
export const newMemoryId: Prefixed<'MemoryId'> = prefixed('mem');
export const newJobId: Prefixed<'JobId'> = prefixed('job');

export function isUlid(value: string): boolean {
  if (value.length !== 26) return false;
  return [...value].every((char) => ENCODING.includes(char.toUpperCase()));
}
