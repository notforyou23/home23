import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationApplication, createCoordinationLifecycle, disabledCoordinationFeatureFlags } from "../../../src/coordination/app/index.js";
import { createChannelService } from "../../../src/coordination/channels/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import { createUnreadService } from "../../../src/coordination/unread/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";
import { createMessagingFixture, fixtureId } from "../messaging/test-fixture.js";

const headers = (idempotency?: string) => ({
  authorization: "Bearer product-api-fixture",
  "content-type": "application/json",
  "x-correlation-id": fixtureId("correlation", 700),
  ...(idempotency ? { "idempotency-key": idempotency } : {}),
});

test("loopback product API traverses canonical temp-db Bots, Channels, Messages, Inbox, and Unread", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({ repository: fixture.repository, participantDirectory: fixture.directory, cursorSigningKey: new Uint8Array(32).fill(7), now: () => fixture.clock.value });
  const messages = createMessageService({ repository: fixture.repository, participantDirectory: fixture.directory, now: () => fixture.clock.value });
  const unread = createUnreadService({ repository: fixture.repository, participantDirectory: fixture.directory, now: () => fixture.clock.value });
  const flags = { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true, "coordination.public_api.enabled": true, "coordination.channels.enabled": true, "coordination.resident.jerry.enabled": true };
  const application = createCoordinationApplication({ flags, services: {
    auth: { validateAccessToken: async () => ({ principalId: "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000700", sessionId: "ses_0198d95f-6c00-7000-8000-000000000700", scopes: ["product:read", "message:send"] }) },
    bots: fixture.directory, channels, messages, unread,
    work: { create: (() => ({})) as any, cancelQueued: (() => ({})) as any, get: (() => null) as any },
    leases: {} as any,
    messageSubmission: { submitMessage: async ({ context, channelId, idempotencyKey, body }) => messages.sendMessage({ context, channelId, idempotencyKey, messageId: body.messageId, authorPrincipalId: "user_owner", kind: "text", text: body.text, mentions: body.mentions, attachmentIds: body.attachmentIds, clientMessageId: body.clientMessageId, replyToMessageId: body.replyToMessageId, tombstonesMessageId: null, provenance: { roundId: null, workId: null } }) },
  } });
  const server = createCoordinationHttpServer({ application, lifecycle: createCoordinationLifecycle(), port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  const bots = await fetch(`${address.origin}/api/v1/bots`, { headers: headers() });
  assert.equal(bots.status, 200);
  assert.deepEqual((await bots.json() as any).bots.map((bot: any) => bot.name), ["Forrest", "Jerry", "Records"]);

  const created = await fetch(`${address.origin}/api/v1/channels`, { method: "POST", headers: headers("product-api-channel-0001"), body: JSON.stringify({ kind: "direct", memberBotIds: [fixture.bots.jerry.id], title: "Jerry", purpose: "Durable direct conversation.", pinned: true, responderPolicy: { mode: "mention_or_coordinator", coordinatorBotId: fixture.bots.jerry.id, responseOrder: "sequential", maxBotTurns: 1 } }) });
  assert.equal(created.status, 201);
  const channel = (await created.json() as any).channel;

  const sent = await fetch(`${address.origin}/api/v1/channels/${channel.id}/messages`, { method: "POST", headers: headers("product-api-message-0001"), body: JSON.stringify({ messageId: fixtureId("message", 701), clientMessageId: "client-701", text: "hello Jerry", attachmentIds: [], mentions: [], replyToMessageId: null }) });
  assert.equal(sent.status, 202);

  const transcript = await fetch(`${address.origin}/api/v1/channels/${channel.id}/messages`, { headers: headers() });
  assert.equal(transcript.status, 200);
  assert.equal((await transcript.json() as any).messages[0].text, "hello Jerry");
  const inbox = await fetch(`${address.origin}/api/v1/inbox`, { headers: headers() });
  assert.equal(inbox.status, 200);
  assert.equal((await inbox.json() as any).conversations[0].channelId, channel.id);
  const unreadResponse = await fetch(`${address.origin}/api/v1/unread?channelId=${channel.id}`, { headers: headers() });
  assert.equal(unreadResponse.status, 200);
  assert.equal((await unreadResponse.json() as any).unreadCount, 0);
});

test("Channels, lifecycle, Activity, and coordinator stay fail-closed without exact flags and ports", async (t) => {
  const application = createCoordinationApplication({ flags: { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true, "coordination.public_api.enabled": true }, services: { auth: { validateAccessToken: async () => ({ principalId: "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000700", sessionId: "ses_0198d95f-6c00-7000-8000-000000000700", scopes: ["product:read", "message:send"] }) } } });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  for (const request of [
    fetch(`${address.origin}/api/v1/activity`, { headers: headers() }),
    fetch(`${address.origin}/api/v1/channels`, { method: "POST", headers: headers("product-api-channel-off"), body: "{}" }),
    fetch(`${address.origin}/api/v1/bots`, { method: "POST", headers: headers("product-api-lifecycle-off"), body: "{}" }),
    fetch(`${address.origin}/api/v1/channels/chn_0198d95f-6c00-7000-8000-000000000001/coordinate`, { method: "POST", headers: headers(), body: JSON.stringify({ messageId: fixtureId("message", 1) }) }),
  ]) assert.equal((await request).status, 503);
});

test("Activity, lifecycle, and coordinator routes invoke only injected trusted ports behind exact flags", async (t) => {
  const calls: string[] = [];
  const flags = { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true, "coordination.public_api.enabled": true, "coordination.channels.enabled": true, "coordination.bot_lifecycle.enabled": true };
  const application = createCoordinationApplication({ flags, services: {
    auth: { validateAccessToken: async () => ({ principalId: "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000700", sessionId: "ses_0198d95f-6c00-7000-8000-000000000700", scopes: ["product:read", "message:send"] }) },
    activity: { list: async () => { calls.push("activity"); return { entries: [], nextBoundary: null, throughEventSequence: 9 }; } },
    botLifecycleApi: {
      create: async () => { calls.push("bot.create"); return { outcome: "succeeded" } as any; },
      control: async ({ operation }) => { calls.push(`bot.${operation}`); return { outcome: "succeeded" } as any; },
    },
    channelCoordinator: { startFromMessage: async () => { calls.push("channel.coordinate"); return { accepted: true }; } },
  } });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  assert.equal((await fetch(`${address.origin}/api/v1/activity`, { headers: headers() })).status, 200);
  assert.equal((await fetch(`${address.origin}/api/v1/bots`, { method: "POST", headers: headers("product-api-create-bot"), body: JSON.stringify({ residentBinding: "specialist", displayName: "Specialist", purpose: "Continuing specialist", requiredCapabilities: ["messages"] }) })).status, 201);
  assert.equal((await fetch(`${address.origin}/api/v1/bots/bot_0198d95f-6c00-7000-8000-000000000001/start`, { method: "POST", headers: headers("product-api-start-bot") })).status, 200);
  assert.equal((await fetch(`${address.origin}/api/v1/bots/bot_0198d95f-6c00-7000-8000-000000000001/stop`, { method: "POST", headers: headers("product-api-stop-bot") })).status, 200);
  assert.equal((await fetch(`${address.origin}/api/v1/bots/bot_0198d95f-6c00-7000-8000-000000000001/restart`, { method: "POST", headers: headers("product-api-restart-bot") })).status, 200);
  assert.equal((await fetch(`${address.origin}/api/v1/bots/bot_0198d95f-6c00-7000-8000-000000000001/archive`, { method: "POST", headers: headers("product-api-archive-bot") })).status, 200);
  assert.equal((await fetch(`${address.origin}/api/v1/bots/bot_0198d95f-6c00-7000-8000-000000000001/restore`, { method: "POST", headers: headers("product-api-restore-bot") })).status, 200);
  assert.equal((await fetch(`${address.origin}/api/v1/channels/chn_0198d95f-6c00-7000-8000-000000000001/coordinate`, { method: "POST", headers: headers(), body: JSON.stringify({ messageId: fixtureId("message", 1) }) })).status, 202);
  assert.deepEqual(calls, ["activity", "bot.create", "bot.start", "bot.stop", "bot.restart", "bot.archive", "bot.restore", "channel.coordinate"]);
});
