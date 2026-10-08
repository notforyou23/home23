import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { once, getEventListeners } from "node:events";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createCoordinationApplication, createCoordinationLifecycle, disabledCoordinationFeatureFlags } from "../../../src/coordination/app/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";
import type { EventEnvelope, SqliteEventRepository } from "../../../src/coordination/events/index.js";

const uuid = "0198d95f-6c00-7000-8000-0000000000c1";
function event(sequence: number, bytes = 16): EventEnvelope {
  return {
    id: `evt_${uuid}`, sequence, schemaVersion: 1, type: "activity.updated", durability: "durable",
    aggregate: { kind: "fixture", id: "fixture", version: sequence }, channelId: null, actorPrincipalId: null,
    requestId: `req_${uuid}`, correlationId: `cor_${uuid}`, createdAt: "2026-10-07T00:00:00.000Z",
    payload: { content: "x".repeat(bytes) },
  };
}
function application(events: { resumeAfter: SqliteEventRepository["resumeAfter"] }) {
  return createCoordinationApplication({
    flags: { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true },
    services: {
      events: events as SqliteEventRepository,
      auth: { validateAccessToken: async () => ({ principalId: "user_owner", deviceId: `dev_${uuid}`, sessionId: `ses_${uuid}`, scopes: ["product:read"] }) },
    },
  });
}

test("drain releases a backpressured event replay before closing services", async (t) => {
  let closed = false;
  let reads = 0;
  const lifecycle = createCoordinationLifecycle([{ name: "database", drain: async () => {}, close: async () => { closed = true; } }]);
  const events = { resumeAfter(after: number) {
    assert.equal(closed, false, "replay read after database close");
    reads++;
    return { kind: "events" as const, hasMore: true, events: [event(after + 1, 8 * 1024 * 1024)] };
  } };
  const server = createCoordinationHttpServer({ application: application(events), lifecycle, port: 0 });
  const address = await server.start();
  const client = request(`${address.origin}/api/v1/events`, { headers: { authorization: "Bearer fixture" } });
  client.on("error", () => {});
  t.after(async () => { client.destroy(); await server.drain(); });
  const received = once(client, "response");
  client.end();
  const [response] = await received;
  response.pause();
  await delay(50);
  assert.equal(response.statusCode, 200);
  assert.equal(lifecycle.activeRequests(), 1);
  const draining = server.drain();
  assert.equal(await Promise.race([draining.then(() => true), delay(1_000).then(() => false)]), true, "paused client kept Core draining");
  assert.equal(closed, true);
  assert.equal(lifecycle.activeRequests(), 0);
  assert.equal(server.state(), "stopped");
  await delay(20);
  assert.equal(reads, 1, "cancelled replay fetched another page");
});

test("drain closes a connection that has not finished its request headers", async (t) => {
  const server = createCoordinationHttpServer({ application: application({ resumeAfter: () => { throw new Error("unused"); } }), port: 0 });
  const address = await server.start();
  const client = connect(address.port, address.host);
  client.on("error", () => {});
  t.after(async () => { client.destroy(); await server.drain(); });
  await once(client, "connect");
  client.write("GET /api/v1/events HTTP/1.1\r\nHost: localhost\r\n");
  await delay(30);
  const draining = server.drain();
  assert.equal(await Promise.race([draining.then(() => true), delay(1_000).then(() => false)]), true, "partial headers kept listener open");
  assert.equal(server.lifecycle.activeRequests(), 0);
  assert.equal(server.state(), "stopped");
});


test("client disconnect releases stream listeners and event replay resumes after its cursor", async (t) => {
  const lifecycle = createCoordinationLifecycle();
  const cursors: number[] = [];
  const events = { resumeAfter(after: number) {
    cursors.push(after);
    return { kind: "events" as const, hasMore: false, events: [1, 2].filter(n => n > after).map(n => event(n)) };
  } };
  const server = createCoordinationHttpServer({ application: application(events), lifecycle, port: 0 });
  const address = await server.start();
  t.after(() => server.drain());
  for (const cursor of [0, 1]) {
    const client = request(`${address.origin}/api/v1/events`, { headers: { authorization: "Bearer fixture", "last-event-id": String(cursor) } });
    client.on("error", () => {});
    t.after(() => client.destroy());
    const received = once(client, "response");
    client.end();
    const [response] = await received;
    let text = "";
    const complete = new Promise<void>((resolve) => response.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("id: 2\nevent:")) resolve();
    }));
    assert.equal(await Promise.race([complete.then(() => true), delay(1_000).then(() => false)]), true);
    assert.deepEqual([...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1])), cursor ? [2] : [1, 2]);
    assert.equal(getEventListeners(lifecycle.drainingSignal, "abort").length, 1);
    client.destroy();
    for (let n = 0; n < 100 && lifecycle.activeRequests(); n++) await delay(5);
    assert.equal(lifecycle.activeRequests(), 0);
    assert.equal(getEventListeners(lifecycle.drainingSignal, "abort").length, 0);
  }
  assert.ok(cursors.includes(0) && cursors.includes(1));
});
