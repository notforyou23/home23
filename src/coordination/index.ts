import { createCoordinationProcess } from "./app/composition.js";
import { loadCoordinationRuntimeConfig } from "./app/runtime-config.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export * from "./channel-coordinator/index.js";

type CoordinationShutdownSignal = "SIGINT" | "SIGTERM";

interface CoordinationSignalTarget {
  once(signal: CoordinationShutdownSignal, listener: () => void): unknown;
}

export interface CoordinationShutdownController {
  request(signal: CoordinationShutdownSignal): Promise<void>;
  pending(): Promise<void> | null;
}

/**
 * Drain once, then terminate explicitly. PM2 keeps an IPC handle open, so a
 * successfully drained process is not guaranteed to leave on its own merely
 * because its HTTP listener and database handles have closed.
 */
export function installCoordinationShutdownHandlers(input: {
  drain(): Promise<void>;
  signalTarget?: CoordinationSignalTarget;
  terminate?(exitCode: 0 | 1): void;
  reportFailure?(error: unknown, signal: CoordinationShutdownSignal): void;
}): CoordinationShutdownController {
  const signalTarget = input.signalTarget ?? process;
  const terminate = input.terminate ?? ((exitCode: 0 | 1) => process.exit(exitCode));
  const reportFailure = input.reportFailure ?? ((error: unknown, signal: CoordinationShutdownSignal) => {
    console.error(
      `[home23-coordination] ${signal} drain failed:`,
      error instanceof Error ? error.message : error,
    );
  });
  let shutdownPromise: Promise<void> | null = null;

  const request = (signal: CoordinationShutdownSignal): Promise<void> => {
    shutdownPromise ??= (async () => {
      try {
        await input.drain();
        terminate(0);
      } catch (error) {
        reportFailure(error, signal);
        terminate(1);
      }
    })();
    return shutdownPromise;
  };

  signalTarget.once("SIGINT", () => { void request("SIGINT"); });
  signalTarget.once("SIGTERM", () => { void request("SIGTERM"); });
  return Object.freeze({ request, pending: () => shutdownPromise });
}

export async function runCoordinationProcess(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<"disabled" | "listening"> {
  const config = loadCoordinationRuntimeConfig(environment);
  if (!config.enabled) return "disabled";

  const coordination = createCoordinationProcess(config);
  let drainPromise: Promise<void> | null = null;
  const drain = () => {
    drainPromise ??= coordination.drain();
    return drainPromise;
  };
  installCoordinationShutdownHandlers({ drain });
  await coordination.start();
  return "listening";
}

const invokedScript = process.env.pm_exec_path ?? process.argv[1];
if (invokedScript && import.meta.url === pathToFileURL(resolve(invokedScript)).href) {
  runCoordinationProcess().then(
    (state) => {
      if (state === "disabled") {
        console.log("[home23-coordination] disabled by configuration");
      }
    },
    (error: unknown) => {
      console.error("[home23-coordination] startup refused:", error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
