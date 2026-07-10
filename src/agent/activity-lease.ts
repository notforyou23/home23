export type LeaseExpiryReason = 'inactivity_timeout' | 'hard_timeout';

export class ActivityLease {
  private inactivityTimer: unknown;
  private hardTimer: unknown;
  private closed = false;
  private started = false;
  private readonly lastSequence = new Map<string, number>();
  private _activityDeadlineMs: number | null = null;
  private _hardDeadlineMs: number | null = null;

  constructor(private readonly options: {
    inactivityMs: number;
    hardDurationMs: number;
    now: () => number;
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (id: unknown) => void;
    onExpire: (reason: LeaseExpiryReason) => void;
  }) {
    if (!Number.isSafeInteger(options.inactivityMs) || options.inactivityMs <= 0
        || !Number.isSafeInteger(options.hardDurationMs) || options.hardDurationMs <= 0) {
      throw new TypeError('invalid activity lease duration');
    }
  }

  get activityDeadlineMs(): number | null { return this._activityDeadlineMs; }
  get hardDeadlineMs(): number | null { return this._hardDeadlineMs; }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.armInactivity();
    this._hardDeadlineMs = this.options.now() + this.options.hardDurationMs;
    this.hardTimer = this.options.setTimeout(
      () => this.expire('hard_timeout'),
      this.options.hardDurationMs,
    );
  }

  observe(activity: { operationId: string; sequence: number }): boolean {
    if (this.closed || !this.started
        || typeof activity.operationId !== 'string' || activity.operationId.length === 0
        || !Number.isSafeInteger(activity.sequence)) return false;
    const previous = this.lastSequence.get(activity.operationId) ?? 0;
    if (activity.sequence <= previous) return false;
    this.lastSequence.set(activity.operationId, activity.sequence);
    this.armInactivity();
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.inactivityTimer !== undefined) this.options.clearTimeout(this.inactivityTimer);
    if (this.hardTimer !== undefined) this.options.clearTimeout(this.hardTimer);
    this.inactivityTimer = undefined;
    this.hardTimer = undefined;
  }

  private armInactivity(): void {
    if (this.inactivityTimer !== undefined) this.options.clearTimeout(this.inactivityTimer);
    this._activityDeadlineMs = this.options.now() + this.options.inactivityMs;
    this.inactivityTimer = this.options.setTimeout(
      () => this.expire('inactivity_timeout'),
      this.options.inactivityMs,
    );
  }

  private expire(reason: LeaseExpiryReason): void {
    if (this.closed) return;
    const resolvedReason = reason === 'inactivity_timeout'
      && this._hardDeadlineMs !== null
      && this.options.now() >= this._hardDeadlineMs
      ? 'hard_timeout'
      : reason;
    this.close();
    this.options.onExpire(resolvedReason);
  }
}
