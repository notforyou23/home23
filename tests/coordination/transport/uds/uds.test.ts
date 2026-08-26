import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RESIDENT_PROTOCOL_VERSION,
  ResidentProtocolError,
  createResidentCredential,
  type JsonValue,
  type ResidentCredential,
} from "../../../../src/coordination/resident-protocol/index.js";
import {
  ResidentUdsClient,
  ResidentUdsServer,
  probeUnixSocketPath,
} from "../../../../src/coordination/transport/uds/index.js";

const REQUEST_ID_1 = "req_0198d95f-6c00-7000-8000-0000000000b1";
const REQUEST_ID_2 = "req_0198d95f-6c00-7000-8000-0000000000b2";
const CORRELATION_ID = "cor_0198d95f-6c00-7000-8000-0000000000b3";

function fixtureCredential(instanceId = "resident-jerry-1"): ResidentCredential {
  return createResidentCredential({
    rootKey: Buffer.alloc(32, 0x42),
    residentSlug: "jerry",
    role: "resident",
    instanceId,
    keyVersion: 1,
  });
}

function socketFixture(t: test.TestContext): { directory: string; socketPath: string } {
  const root = mkdtempSync(join(tmpdir(), "home23-m05-"));
  const directory = join(root, "coordination");
  const socketPath = join(directory, "resident.sock");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { directory, socketPath };
}

function protocolCode(error: unknown): string | undefined {
  return error instanceof ResidentProtocolError ? error.code : undefined;
}

function echoHandler(request: { payload: JsonValue }) {
  return Promise.resolve({ echoed: request.payload } satisfies JsonValue);
}

test("startup creates an exact 0700 directory and 0600 socket after a path probe", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    handleRequest: echoHandler,
  });
  t.after(() => server.close());

  const receipt = await server.start();
  const probe = probeUnixSocketPath(fixture.socketPath);

  assert.equal(receipt.protocolVersion, 1);
  assert.equal(receipt.pathBytes, probe.pathBytes);
  assert.equal(receipt.directoryMode, 0o700);
  assert.equal(receipt.socketMode, 0o600);
  assert.equal(statSync(fixture.directory).mode & 0o777, 0o700);
  assert.equal(statSync(fixture.socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(fixture.socketPath).isSocket(), true);
});

test("startup rejects an overlong path and refuses to replace a non-socket", async (t) => {
  const fixture = socketFixture(t);
  const overlongPath = `/tmp/${"x".repeat(200)}.sock`;
  assert.throws(
    () => probeUnixSocketPath(overlongPath),
    (error: unknown) => protocolCode(error) === "request_invalid",
  );

  mkdirSync(fixture.directory, { mode: 0o700 });
  chmodSync(fixture.directory, 0o700);
  writeFileSync(fixture.socketPath, "do-not-replace");
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [fixtureCredential()],
    handleRequest: echoHandler,
  });
  await assert.rejects(server.start(), /refusing to replace a non-socket/);
  assert.equal(statSync(fixture.socketPath).isFile(), true);
});

test("mutual authentication rejects an unknown peer, wrong instance, and wrong server", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    handleRequest: echoHandler,
  });
  await server.start();
  t.after(() => server.close());

  for (const client of [
    new ResidentUdsClient({
      socketPath: fixture.socketPath,
      serverInstanceId: "coordination-kernel-1",
      credential: createResidentCredential({
        rootKey: Buffer.alloc(32, 0x99),
        residentSlug: "jerry",
        role: "resident",
        instanceId: "resident-jerry-1",
        keyVersion: 1,
      }),
    }),
    new ResidentUdsClient({
      socketPath: fixture.socketPath,
      serverInstanceId: "coordination-kernel-1",
      credential: fixtureCredential("resident-jerry-2"),
    }),
    new ResidentUdsClient({
      socketPath: fixture.socketPath,
      serverInstanceId: "coordination-kernel-other",
      credential: selectedCredential,
    }),
  ]) {
    t.after(() => client.close());
    await assert.rejects(
      client.request({
        method: "POST",
        path: "/internal/v1/status/check",
        payload: {},
        deadlineAtMs: Date.now() + 2_000,
      }),
      (error: unknown) => protocolCode(error) === "authentication_failed",
    );
  }
});

test("version negotiation fails closed when no supported protocol overlaps", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    handleRequest: echoHandler,
  });
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
    supportedProtocolVersions: [2],
  });
  t.after(() => client.close());

  await assert.rejects(
    client.request({
      method: "POST",
      path: "/internal/v1/status/check",
      payload: {},
      deadlineAtMs: Date.now() + 2_000,
    }),
    (error: unknown) => protocolCode(error) === "protocol_version_unsupported",
  );
});

test("a stale fence is rejected before the real handler executes", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  let calls = 0;
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    validateFence: (fence) => fence === "fence-current",
    handleRequest: async () => {
      calls += 1;
      return { accepted: true };
    },
  });
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
  });
  t.after(() => client.close());

  await assert.rejects(
    client.request({
      method: "POST",
      path: "/internal/v1/attempts/att_1/complete",
      payload: { terminal: true },
      fence: "fence-stale",
      deadlineAtMs: Date.now() + 2_000,
    }),
    (error: unknown) => protocolCode(error) === "fence_invalid",
  );
  assert.equal(calls, 0);
});

test("request deadline sends authenticated cancellation to the active handler", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  let observedAbort = false;
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    handleRequest: (_request, context) =>
      new Promise<JsonValue>((resolve) => {
        context.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve({ stopped: true });
          },
          { once: true },
        );
      }),
  });
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
  });
  t.after(() => client.close());

  await assert.rejects(
    client.request({
      method: "POST",
      path: "/internal/v1/attempts/att_1/heartbeat",
      payload: {},
      requestId: REQUEST_ID_1,
      correlationId: CORRELATION_ID,
      deadlineAtMs: Date.now() + 100,
    }),
    (error: unknown) => protocolCode(error) === "deadline_exceeded",
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(observedAbort, true);
});

test("authenticated caller cancellation remains distinct from deadline expiry", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    maxConcurrentRequests: 1,
    handleRequest: async (request) => {
      if ((request.payload as { block?: boolean }).block) {
        markStarted();
        return new Promise<JsonValue>(() => undefined);
      }
      return { accepted: true };
    },
  });
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
  });
  t.after(() => client.close());

  const controller = new AbortController();
  const blocked = client.request({
    method: "POST",
    path: "/internal/v1/attempts/att_1/heartbeat",
    payload: { block: true },
    requestId: REQUEST_ID_1,
    deadlineAtMs: Date.now() + 2_000,
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(
    blocked,
    (error: unknown) => protocolCode(error) === "request_cancelled",
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const response = await client.request({
    method: "POST",
    path: "/internal/v1/status/check",
    payload: {},
    requestId: REQUEST_ID_2,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.deepEqual(response.payload, { accepted: true });
});

test("bounded request rate rejects excess input without dispatch", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  let calls = 0;
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    requestRateLimit: { limit: 1, intervalMs: 10_000 },
    handleRequest: async () => {
      calls += 1;
      return { accepted: true };
    },
  });
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
  });
  t.after(() => client.close());

  await client.request({
    method: "POST",
    path: "/internal/v1/status/check",
    payload: {},
    requestId: REQUEST_ID_1,
    deadlineAtMs: Date.now() + 2_000,
  });
  await assert.rejects(
    client.request({
      method: "POST",
      path: "/internal/v1/status/check",
      payload: {},
      requestId: REQUEST_ID_2,
      deadlineAtMs: Date.now() + 2_000,
    }),
    (error: unknown) => protocolCode(error) === "request_rate_limited",
  );
  assert.equal(calls, 1);
});

test("the same active request ID cannot execute concurrently on two connections", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  let calls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    handleRequest: async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return { call: calls };
    },
  });
  await server.start();
  t.after(() => server.close());
  const firstClient = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
  });
  const secondClient = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
  });
  t.after(() => firstClient.close());
  t.after(() => secondClient.close());

  const first = firstClient.request({
    method: "POST",
    path: "/internal/v1/attempts/att_1/heartbeat",
    payload: { call: 1 },
    requestId: REQUEST_ID_1,
    correlationId: CORRELATION_ID,
    deadlineAtMs: Date.now() + 2_000,
  });
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    secondClient.request({
      method: "POST",
      path: "/internal/v1/attempts/att_1/heartbeat",
      payload: { call: 2 },
      requestId: REQUEST_ID_1,
      correlationId: CORRELATION_ID,
      deadlineAtMs: Date.now() + 2_000,
    }),
    (error: unknown) => protocolCode(error) === "request_invalid",
  );
  assert.equal(calls, 1);
  releaseFirst();
  await first;
});

test("a handler that ignores abort cannot retain its concurrency slot past deadline", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    maxConcurrentRequests: 1,
    handleRequest: async (request) => {
      if ((request.payload as { block?: boolean }).block) {
        return new Promise<JsonValue>(() => undefined);
      }
      return { accepted: true };
    },
  });
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
  });
  t.after(() => client.close());

  await assert.rejects(
    client.request({
      method: "POST",
      path: "/internal/v1/attempts/att_1/heartbeat",
      payload: { block: true },
      requestId: REQUEST_ID_1,
      deadlineAtMs: Date.now() + 100,
    }),
    (error: unknown) => protocolCode(error) === "deadline_exceeded",
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const response = await client.request({
    method: "POST",
    path: "/internal/v1/status/check",
    payload: {},
    requestId: REQUEST_ID_2,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.deepEqual(response.payload, { accepted: true });
});

test("an oversized raw frame is closed before dispatch and the server stays available", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  let calls = 0;
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    maxFrameBytes: 2_048,
    handleRequest: async () => {
      calls += 1;
      return { accepted: true };
    },
  });
  await server.start();
  t.after(() => server.close());

  const rawSocket = createConnection(fixture.socketPath);
  await new Promise<void>((resolve, reject) => {
    rawSocket.once("connect", resolve);
    rawSocket.once("error", reject);
  });
  const oversizedPrefix = Buffer.alloc(4);
  oversizedPrefix.writeUInt32BE(2_049);
  rawSocket.write(oversizedPrefix);
  await new Promise<void>((resolve) => rawSocket.once("close", () => resolve()));
  assert.equal(calls, 0);

  const client = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
    maxFrameBytes: 2_048,
  });
  t.after(() => client.close());
  const response = await client.request({
    method: "POST",
    path: "/internal/v1/status/check",
    payload: {},
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.deepEqual(response.payload, { accepted: true });
  assert.equal(calls, 1);
});

test("an oversized outbound error closes only that connection without an unhandled dispatch", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  const server = new ResidentUdsServer({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credentials: [selectedCredential],
    maxFrameBytes: 2_048,
    handleRequest: async (request) => {
      if (request.path.endsWith("/oversized-error")) {
        throw new ResidentProtocolError("request_invalid", "safe failure", {
          details: { note: "x".repeat(4_096) },
        });
      }
      return { accepted: true };
    },
  });
  await server.start();
  t.after(() => server.close());
  const firstClient = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
    maxFrameBytes: 2_048,
  });
  t.after(() => firstClient.close());

  await assert.rejects(
    firstClient.request({
      method: "POST",
      path: "/internal/v1/status/oversized-error",
      payload: {},
      deadlineAtMs: Date.now() + 500,
    }),
    (error: unknown) => protocolCode(error) === "connection_lost",
  );

  const secondClient = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
    maxFrameBytes: 2_048,
  });
  t.after(() => secondClient.close());
  const response = await secondClient.request({
    method: "POST",
    path: "/internal/v1/status/check",
    payload: {},
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.deepEqual(response.payload, { accepted: true });
});

test("restart and reconnect preserve caller correlation without implicit request replay", async (t) => {
  const fixture = socketFixture(t);
  const selectedCredential = fixtureCredential();
  const makeServer = () =>
    new ResidentUdsServer({
      socketPath: fixture.socketPath,
      serverInstanceId: "coordination-kernel-1",
      credentials: [selectedCredential],
      handleRequest: echoHandler,
    });
  let server = makeServer();
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath: fixture.socketPath,
    serverInstanceId: "coordination-kernel-1",
    credential: selectedCredential,
  });
  t.after(() => client.close());

  const first = await client.request({
    method: "POST",
    path: "/internal/v1/status/check",
    payload: { generation: 1 },
    requestId: REQUEST_ID_1,
    correlationId: CORRELATION_ID,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(first.protocolVersion, RESIDENT_PROTOCOL_VERSION);
  assert.equal(first.correlationId, CORRELATION_ID);

  await server.close();
  server = makeServer();
  await server.start();
  const second = await client.request({
    method: "POST",
    path: "/internal/v1/status/check",
    payload: { generation: 2 },
    requestId: REQUEST_ID_2,
    correlationId: CORRELATION_ID,
    deadlineAtMs: Date.now() + 2_000,
  });
  assert.equal(second.protocolVersion, RESIDENT_PROTOCOL_VERSION);
  assert.equal(second.correlationId, CORRELATION_ID);
  assert.deepEqual(second.payload, { echoed: { generation: 2 } });
});
