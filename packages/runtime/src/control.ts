export interface RunControl {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  readonly paused: boolean;
  readonly cancelReason?: string;
  cancel(reason: string): void;
  pause(): void;
}

/**
 * In-process control handle for a run that is currently executing. A worker
 * that dies simply loses the handle: the durable run row and the latest
 * checkpoint remain the source of truth.
 */
export class InProcessRunControl implements RunControl {
  private readonly controller = new AbortController();
  private cancelledFlag = false;
  private pausedFlag = false;
  private reason: string | undefined;

  constructor(readonly runId: string) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  get cancelReason(): string | undefined {
    return this.reason;
  }

  cancel(reason: string): void {
    this.cancelledFlag = true;
    this.reason = reason;
    this.controller.abort(new Error(reason));
  }

  pause(): void {
    this.pausedFlag = true;
  }
}
