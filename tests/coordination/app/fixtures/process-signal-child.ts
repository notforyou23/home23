import { installCoordinationShutdownHandlers } from "../../../../src/coordination/index.js";

// The interval models PM2's persistent IPC handle: without explicit
// termination, a successful drain alone cannot end this child.
setInterval(() => undefined, 60_000).unref();
process.channel?.ref();

installCoordinationShutdownHandlers({
  drain: async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.send?.({ phase: "drained" });
    if (process.env.HOME23_COORDINATION_SIGNAL_FIXTURE_FAIL === "true") {
      throw new Error("fixture drain failure");
    }
  },
  reportFailure: () => undefined,
});

process.send?.({ phase: "ready" });
