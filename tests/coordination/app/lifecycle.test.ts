import assert from "node:assert/strict";
import test from "node:test";

import {
  CoordinationLifecycleDrainingError,
  createCoordinationLifecycle,
} from "../../../src/coordination/app/index.js";

test("drain waits for active work then drains and closes dependencies in deterministic order", async () => {
  const calls: string[] = [];
  const lifecycle = createCoordinationLifecycle([
    {
      name: "database",
      drain: async () => { calls.push("drain:database"); },
      close: async () => { calls.push("close:database"); },
    },
    {
      name: "resident-transport",
      drain: async () => { calls.push("drain:resident-transport"); },
      close: async () => { calls.push("close:resident-transport"); },
    },
  ]);
  const finishRequest = lifecycle.beginRequest();

  const firstDrain = lifecycle.drain();
  const repeatedDrain = lifecycle.drain();

  assert.equal(firstDrain, repeatedDrain);
  assert.equal(lifecycle.state(), "draining");
  assert.deepEqual(calls, []);
  assert.throws(
    () => lifecycle.beginRequest(),
    CoordinationLifecycleDrainingError,
  );

  finishRequest();
  await firstDrain;

  assert.equal(lifecycle.state(), "stopped");
  assert.deepEqual(calls, [
    "drain:database",
    "drain:resident-transport",
    "close:resident-transport",
    "close:database",
  ]);
});

test("request release is idempotent and an empty lifecycle drains once", async () => {
  const lifecycle = createCoordinationLifecycle();
  const release = lifecycle.beginRequest();

  release();
  release();
  await lifecycle.drain();
  await lifecycle.drain();

  assert.equal(lifecycle.activeRequests(), 0);
  assert.equal(lifecycle.state(), "stopped");
});
