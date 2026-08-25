export type CoordinationLifecycleState = "accepting" | "draining" | "stopped";

export interface CoordinationLifecycleParticipant {
  name: string;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export class CoordinationLifecycleDrainingError extends Error {
  readonly name = "CoordinationLifecycleDrainingError";

  constructor() {
    super("coordination lifecycle is draining");
  }
}

export interface CoordinationLifecycle {
  state(): CoordinationLifecycleState;
  activeRequests(): number;
  beginRequest(): () => void;
  drain(): Promise<void>;
}

export function createCoordinationLifecycle(
  participants: readonly CoordinationLifecycleParticipant[] = [],
): CoordinationLifecycle {
  let lifecycleState: CoordinationLifecycleState = "accepting";
  let activeRequests = 0;
  let resolveIdle: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;

  function beginRequest(): () => void {
    if (lifecycleState !== "accepting") {
      throw new CoordinationLifecycleDrainingError();
    }
    activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeRequests -= 1;
      if (activeRequests === 0 && resolveIdle) {
        const resolve = resolveIdle;
        resolveIdle = null;
        resolve();
      }
    };
  }

  function waitForIdle(): Promise<void> {
    if (activeRequests === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
  }

  async function performDrain(): Promise<void> {
    await waitForIdle();
    let firstFailure: unknown;
    for (const participant of participants) {
      try {
        await participant.drain();
      } catch (error) {
        firstFailure ??= error;
      }
    }
    for (const participant of [...participants].reverse()) {
      try {
        await participant.close();
      } catch (error) {
        firstFailure ??= error;
      }
    }
    lifecycleState = "stopped";
    if (firstFailure) throw firstFailure;
  }

  function drain(): Promise<void> {
    if (!drainPromise) {
      lifecycleState = "draining";
      drainPromise = performDrain();
    }
    return drainPromise;
  }

  return Object.freeze({
    state: () => lifecycleState,
    activeRequests: () => activeRequests,
    beginRequest,
    drain,
  });
}
