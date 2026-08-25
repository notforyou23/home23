import { createCoordinationProcess } from "./app/composition.js";
import { loadCoordinationRuntimeConfig } from "./app/runtime-config.js";

export * from "./channel-coordinator/index.js";

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
  process.once("SIGINT", () => { void drain(); });
  process.once("SIGTERM", () => { void drain(); });
  await coordination.start();
  return "listening";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCoordinationProcess().then(
    (state) => {
      if (state === "disabled") {
        console.log("[home23-coordination] disabled by configuration");
      }
    },
    (error: unknown) => {
      console.error("[home23-coordination] startup refused:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
