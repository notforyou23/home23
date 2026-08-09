/**
 * ShutdownGuard — hard limits around graceful shutdown.
 *
 * Born from the 2026-08-07/08 forrest-harness orphan incident: a wedged
 * shutdown never exited, swallowed every later SIGINT/SIGTERM behind a
 * boolean, and held the bridge port for 13 hours while PM2 crash-looped a
 * replacement against it. Two rules fall out:
 *
 *  1. A repeated signal is an operator saying "now" — force-exit, never no-op.
 *  2. Graceful shutdown gets a fixed budget; past it, force-exit. The budget
 *     must stay below the PM2 kill_timeout for harness apps (30s) so the
 *     process self-terminates before PM2 has to SIGKILL.
 *
 * Neither guard can help if the event loop itself is hard-blocked — that case
 * is covered by the PM2 kill_timeout backstop.
 */

export interface ShutdownGuardOptions {
  /** Milliseconds the graceful path may take before the guard force-exits(1). */
  watchdogMs: number;
  log: (message: string) => void;
  exit: (code: number) => void;
}

export class ShutdownGuard {
  private begun = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ShutdownGuardOptions) {}

  /**
   * Returns true exactly once — the caller should run graceful shutdown.
   * Any later call force-exits (130) instead of silently returning.
   */
  begin(signal: string): boolean {
    if (this.begun) {
      this.options.log(`[shutdown] ${signal} received while shutdown already in progress — forcing exit`);
      this.options.exit(130);
      return false;
    }
    this.begun = true;
    this.timer = setTimeout(() => {
      this.options.log(`[shutdown] watchdog fired after ${this.options.watchdogMs}ms — graceful shutdown hung, forcing exit`);
      this.options.exit(1);
    }, this.options.watchdogMs);
    this.timer.unref?.();
    return true;
  }

  /** Cancel the watchdog (graceful shutdown completed on its own). */
  disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
