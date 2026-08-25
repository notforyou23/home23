import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCoordinationListenerHost,
  createCoordinationHttpServer,
} from "../../../src/coordination/http/index.js";
import {
  createCoordinationApplication,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";

const application = createCoordinationApplication({
  flags: disabledCoordinationFeatureFlags(),
  services: {
    auth: {
      validateAccessToken: async () => {
        throw new Error("unused");
      },
    },
  },
});

test("listener policy accepts explicit loopback literals", () => {
  assert.equal(assertCoordinationListenerHost("127.0.0.1"), "127.0.0.1");
  assert.equal(assertCoordinationListenerHost("::1"), "::1");
});

test("listener policy refuses wildcard and non-loopback binds by default", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.20", "100.64.0.10", "localhost"]) {
    assert.throws(
      () => assertCoordinationListenerHost(host),
      /listener host is not explicitly allowed/,
    );
    assert.throws(
      () => createCoordinationHttpServer({ application, host }),
      /listener host is not explicitly allowed/,
    );
  }
});

test("the shell has no arbitrary non-loopback allowlist escape hatch", () => {
  assert.equal(assertCoordinationListenerHost.length, 1);
  assert.throws(
    () => assertCoordinationListenerHost("100.64.0.10"),
    /listener host is not explicitly allowed/,
  );
});

test("drain requested during startup cannot leave a late listener running", async () => {
  const server = createCoordinationHttpServer({ application, port: 0 });

  const starting = server.start();
  const draining = server.drain();

  assert.equal(server.state(), "draining");
  const address = await starting;
  await draining;
  assert.equal(server.state(), "stopped");
  await assert.rejects(fetch(`${address.origin}/api/v1/capabilities`));
  await assert.rejects(server.start(), /cannot start from stopped/);
});
