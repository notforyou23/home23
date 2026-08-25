import assert from "node:assert/strict";
import test from "node:test";

import { createBootstrapService, type BootstrapResponse } from "../../../src/coordination/bootstrap/index.js";
import { loadCanonicalFixture } from "../../../src/coordination/contracts/contract-pack.js";
import {
  createCoordinationApplication,
  createCoordinationLifecycle,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";

const fixture = loadCanonicalFixture("bootstrap") as BootstrapResponse;
const authPrincipal = Object.freeze({
  principalId: "user_owner" as const,
  deviceId: fixture.client.deviceId,
  sessionId: fixture.client.sessionId,
  scopes: fixture.client.scopes,
});
const enabledShellFlags = Object.freeze({
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
});

function fixtureBootstrapService() {
  return createBootstrapService({
    repository: {
      readProjection: () => ({
        snapshot: fixture.snapshot,
        throughEventSequence: fixture.throughEventSequence,
      }),
    },
    participantDirectory: {
      listVisibleBots: async () => [],
      resolveAlias: async () => null,
      getBotByResidentBinding: async () => null,
    },
    now: () => new Date(fixture.serverTime),
    minimumClientBuild: fixture.minimumClientBuild,
    home: fixture.home,
    connection: fixture.connection,
    capabilities: fixture.capabilities,
    limits: fixture.limits,
    availabilityPolicy: {
      degradedAfterMs: 60_000,
      offlineAfterMs: 120_000,
    },
  });
}

function authHeaders(): Record<string, string> {
  return {
    authorization: "Bearer fixture-access-token",
    "x-request-id": fixture.requestId,
    "x-correlation-id": fixture.correlationId,
  };
}

test("capabilities are public while unauthenticated protected access fails closed", async (t) => {
  let authCalls = 0;
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: {
        validateAccessToken: async ({ accessToken, network, requiredScopes }) => {
          authCalls += 1;
          assert.equal(accessToken, "fixture-access-token");
          assert.equal(network, "loopback");
          assert.deepEqual(requiredScopes, ["product:read"]);
          return authPrincipal;
        },
      },
      bootstrap: fixtureBootstrapService(),
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  const capabilities = await fetch(`${address.origin}/api/v1/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json() as any).capabilities.bootstrap, true);
  assert.equal(authCalls, 0);

  const denied = await fetch(`${address.origin}/api/v1/bootstrap`);
  assert.equal(denied.status, 401);
  const deniedBody = await denied.json() as any;
  assert.match(deniedBody.error.requestId, /^req_/);
  assert.deepEqual({ ...deniedBody, error: { ...deniedBody.error, requestId: "<request>" } }, {
    error: {
      code: "access_invalid",
      message: "Authentication is required.",
      retryable: false,
      requestId: "<request>",
      details: {},
    },
  });
  assert.equal(authCalls, 0);
});

test("the canonical bootstrap fixture traverses auth, HTTP, and the real bootstrap service", async (t) => {
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      bootstrap: fixtureBootstrapService(),
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  const response = await fetch(`${address.origin}/api/v1/bootstrap`, {
    headers: authHeaders(),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), fixture);
});

test("bootstrap rejects an unsupported cursor instead of silently ignoring it", async (t) => {
  let bootstrapCalls = 0;
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      bootstrap: {
        getBootstrap: async () => {
          bootstrapCalls += 1;
          return fixture;
        },
      },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  const response = await fetch(`${address.origin}/api/v1/bootstrap?after=127`, {
    headers: authHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).error.code, "request_invalid");
  assert.equal(bootstrapCalls, 0);
});

test("bootstrap capability fields are clamped to what this shell advertises", async (t) => {
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      bootstrap: {
        getBootstrap: async () => ({
          ...fixture,
          capabilities: {
            channels: true,
            attachments: true,
            search: true,
            push: true,
            eventReplay: true,
            botLifecycle: true,
          },
          limits: {
            ...fixture.limits,
            jsonBodyBytes: 1,
            idempotencyKeyMinimum: 1,
            idempotencyKeyMaximum: 2,
          },
        }),
      },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  const response = await fetch(`${address.origin}/api/v1/bootstrap`, {
    headers: authHeaders(),
  });
  const body = await response.json() as BootstrapResponse;

  assert.equal(response.status, 200);
  assert.deepEqual(body.capabilities, fixture.capabilities);
  assert.deepEqual(body.limits, fixture.limits);
});

test("known but incomplete read and stream routes fail closed after authentication", async (t) => {
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  const channelId = fixture.snapshot.channels[0]!.id;

  for (const path of [
    "/api/v1/channels",
    `/api/v1/channels/${channelId}`,
    "/api/v1/conversations",
    `/api/v1/channels/${channelId}/messages`,
    "/api/v1/unread",
    "/api/v1/activity",
    "/api/v1/events",
  ]) {
    const response = await fetch(`${address.origin}${path}`, { headers: authHeaders() });
    assert.equal(response.status, 503, path);
    assert.equal((await response.json() as any).error.code, "capability_unavailable", path);
  }
});

test("M11-backed message submission fails closed until its port is injected", async (t) => {
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  const channelId = fixture.snapshot.channels[0]!.id;

  const response = await fetch(`${address.origin}/api/v1/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
      "idempotency-key": "fixture-message-key-0001",
    },
    body: JSON.stringify({ text: "hello" }),
  });

  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).error.code, "capability_unavailable");
  assert.equal(application.capabilities().capabilities.messageSubmission, false);
});

test("message mutation requires the HTTP idempotency seam before invoking M11", async (t) => {
  let submissions = 0;
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      messageSubmission: {
        submitMessage: async () => {
          submissions += 1;
          return { accepted: true };
        },
      },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  const channelId = fixture.snapshot.channels[0]!.id;

  const response = await fetch(`${address.origin}/api/v1/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "hello" }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).error.code, "idempotency_key_required");
  assert.equal(submissions, 0);
});

test("an injected M11 placeholder cannot activate message submission", async (t) => {
  let submissions = 0;
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      messageSubmission: {
        submitMessage: async () => {
          submissions += 1;
          return { accepted: true };
        },
      },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  const channelId = fixture.snapshot.channels[0]!.id;

  const response = await fetch(`${address.origin}/api/v1/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
      "idempotency-key": "fixture-message-key-0001",
    },
    body: JSON.stringify({
      messageId: "msg_0198d95f-6c00-7000-8000-0000000000c1",
      clientMessageId: "client-message-0001",
      text: "hello",
      attachmentIds: [],
      mentions: [],
      replyToMessageId: null,
    }),
  });

  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).error.code, "capability_unavailable");
  assert.equal(submissions, 0);
});

test("oversized JSON is reported as payload too large", async (t) => {
  let markReadCalls = 0;
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    limits: {
      jsonBodyBytes: 32,
      idempotencyKeyMinimum: 16,
      idempotencyKeyMaximum: 128,
    },
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      unread: {
        markRead: async () => {
          markReadCalls += 1;
          throw new Error("should not run");
        },
      },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  const channelId = fixture.snapshot.channels[0]!.id;

  const response = await fetch(`${address.origin}/api/v1/channels/${channelId}/read`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
      "idempotency-key": "fixture-read-key-000001",
    },
    body: JSON.stringify({ throughSequence: 2, padding: "x".repeat(64) }),
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json() as any).error.code, "payload_too_large");
  assert.equal(markReadCalls, 0);
});

test("read cursor input is validated and the mutation receipt becomes its event boundary", async (t) => {
  let markReadCalls = 0;
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      unread: {
        markRead: async () => {
          markReadCalls += 1;
          return {
            outcome: "committed" as const,
            unread: {
              principalId: "user_owner",
              channelId: fixture.snapshot.channels[0]!.id,
              conversationId: fixture.snapshot.channels[0]!.conversationId,
              readThroughSequence: 2,
              unreadCount: 0,
              latestSequence: 2,
              version: 4,
              updatedAt: fixture.serverTime,
            },
            receipt: {
              eventId: "evt_0198d95f-6c00-7000-8000-0000000000b1",
              eventSequence: 128,
              aggregateVersion: 4,
            },
          };
        },
      },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  const channelId = fixture.snapshot.channels[0]!.id;
  const headers = {
    ...authHeaders(),
    "content-type": "application/json",
    "idempotency-key": "fixture-read-key-000001",
  };

  const invalid = await fetch(`${address.origin}/api/v1/channels/${channelId}/read`, {
    method: "POST",
    headers,
    body: JSON.stringify({ throughSequence: "2" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(markReadCalls, 0);

  const valid = await fetch(`${address.origin}/api/v1/channels/${channelId}/read`, {
    method: "POST",
    headers,
    body: JSON.stringify({ throughSequence: 2 }),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), {
    requestId: fixture.requestId,
    correlationId: fixture.correlationId,
    principalId: "user_owner",
    channelId,
    conversationId: fixture.snapshot.channels[0]!.conversationId,
    readThroughSequence: 2,
    unreadCount: 0,
    latestSequence: 2,
    version: 4,
    updatedAt: fixture.serverTime,
    throughEventSequence: 128,
  });
  assert.equal(markReadCalls, 1);
});

test("search requires a nonempty query before invoking its domain service", async (t) => {
  let searchCalls = 0;
  const application = createCoordinationApplication({
    flags: {
      ...enabledShellFlags,
      "coordination.search.canonical": true,
    },
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      search: {
        search: async () => {
          searchCalls += 1;
          throw new Error("should not run");
        },
      },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  for (const suffix of ["", "?q="]) {
    const response = await fetch(`${address.origin}/api/v1/search${suffix}`, {
      headers: authHeaders(),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(searchCalls, 0);
});

test("an injected M11 placeholder cannot activate Work mutation", async (t) => {
  let cancelCalls = 0;
  const work = {
    getWork: async () => ({}),
    cancelWork() {
      cancelCalls += 1;
      return Promise.resolve({ status: "cancelling" });
    },
    retryWork: async () => ({}),
  };
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      work,
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  const response = await fetch(
    `${address.origin}/api/v1/work/wrk_0198d95f-6c00-7000-8000-000000000082/cancel`,
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "idempotency-key": "fixture-work-cancel-0001",
      },
    },
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).error.code, "capability_unavailable");
  assert.equal(cancelCalls, 0);
});

test("HTTP drain is single-flight and waits for an in-flight protected route", async () => {
  let releaseBootstrap!: () => void;
  let enteredBootstrap!: () => void;
  const entered = new Promise<void>((resolve) => { enteredBootstrap = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: {
      auth: { validateAccessToken: async () => authPrincipal },
      bootstrap: {
        getBootstrap: async () => {
          enteredBootstrap();
          await blocked;
          return fixture;
        },
      },
    },
  });
  const lifecycle = createCoordinationLifecycle();
  const server = createCoordinationHttpServer({
    application,
    lifecycle,
    port: 0,
  });
  const address = await server.start();
  const responsePromise = fetch(`${address.origin}/api/v1/bootstrap`, {
    headers: authHeaders(),
  });
  await entered;

  const firstDrain = server.drain();
  const repeatedDrain = server.drain();
  assert.equal(firstDrain, repeatedDrain);
  assert.equal(server.state(), "draining");
  assert.equal(lifecycle.activeRequests(), 1);

  releaseBootstrap();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  await response.json();
  await firstDrain;

  assert.equal(server.state(), "stopped");
  assert.equal(lifecycle.state(), "stopped");
  assert.equal(lifecycle.activeRequests(), 0);
});
