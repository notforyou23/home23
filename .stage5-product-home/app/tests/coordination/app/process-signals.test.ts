import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/process-signal-child.ts", import.meta.url));

async function signalFixture(failDrain: boolean) {
  const child = fork(fixture, [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      HOME23_COORDINATION_SIGNAL_FIXTURE_FAIL: String(failDrain),
    },
    silent: true,
  });
  const phases: string[] = [];
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    let shutdownTimer: NodeJS.Timeout | null = null;
    const startupTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("coordination signal fixture did not become ready"));
    }, 15_000);
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("phase" in message)) return;
      const phase = String((message as { phase: unknown }).phase);
      phases.push(phase);
      if (phase === "ready") {
        clearTimeout(startupTimer);
        shutdownTimer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("coordination signal fixture did not terminate after drain"));
        }, 4_000);
        child.kill("SIGTERM");
      }
    });
    child.once("error", (error) => {
      clearTimeout(startupTimer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(startupTimer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      resolve({ code, signal });
    });
  });
  return { ...result, phases };
}

test("SIGTERM drains and explicitly exits a PM2-style IPC child", async () => {
  const result = await signalFixture(false);
  assert.deepEqual(result, { code: 0, signal: null, phases: ["ready", "drained"] });
});

test("a failed signal drain exits nonzero after reporting the durable failure", async () => {
  const result = await signalFixture(true);
  assert.deepEqual(result, { code: 1, signal: null, phases: ["ready", "drained"] });
});
