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
  activeWork(): number;
  beginRequest(): () => void;
  beginWork(): () => void;
  drain(): Promise<void>;
}

export function createCoordinationLifecycle(
  participants: readonly CoordinationLifecycleParticipant[] = [],
): CoordinationLifecycle {
  let lifecycleState: CoordinationLifecycleState = "accepting";
  let activeRequests = 0;
  let activeWork = 0;
  let resolveIdle: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;

  function beginActivity(kind: "request" | "work"): () => void {
    if (lifecycleState !== "accepting") {
      throw new CoordinationLifecycleDrainingError();
    }
    if (kind === "request") activeRequests += 1;
    else activeWork += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === "request") activeRequests -= 1;
      else activeWork -= 1;
      if (activeRequests === 0 && activeWork === 0 && resolveIdle) {
        const resolve = resolveIdle;
        resolveIdle = null;
        resolve();
      }
    };
  }

  function beginRequest(): () => void {
    return beginActivity("request");
  }

  function beginWork(): () => void {
    return beginActivity("work");
  }

  function waitForIdle(): Promise<void> {
    if (activeRequests === 0 && activeWork === 0) return Promise.resolve();
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
    activeWork: () => activeWork,
    beginRequest,
    beginWork,
    drain,
  });
}
