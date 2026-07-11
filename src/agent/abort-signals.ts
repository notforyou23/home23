export function combineRequestSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;

  const abortSignalAny = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (abortSignalAny) return abortSignalAny([callerSignal, timeoutSignal]);

  const controller = new AbortController();
  const sources = [callerSignal, timeoutSignal];
  const listeners = new Map<AbortSignal, () => void>();
  const cleanup = (): void => {
    for (const [source, listener] of listeners) {
      source.removeEventListener('abort', listener);
    }
    listeners.clear();
  };
  for (const source of sources) {
    const listener = (): void => controller.abort(source.reason);
    listeners.set(source, listener);
    if (source.aborted) {
      listener();
      break;
    }
    source.addEventListener('abort', listener, { once: true });
  }
  if (controller.signal.aborted) cleanup();
  else controller.signal.addEventListener('abort', cleanup, { once: true });
  return controller.signal;
}
