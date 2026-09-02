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
    authorityEpochs: {
      current: () => ({ capability: "messages", epoch: 3, mode: "canonical", writer: "home23-coordination", effectiveAtEventSequence: 1, rollbackEpoch: 1 }),
      listCurrent: async () => ({ epochs: [], throughEventSequence: 1 }),
    },
    channelCoordinator: { startFromMessage: async () => ({ accepted: true }) },
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

test("Channels, lifecycle, and Activity stay fail-closed without exact flags and ports", async (t) => {
  const application = createCoordinationApplication({ flags: { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true, "coordination.public_api.enabled": true }, services: { auth: { validateAccessToken: async () => ({ principalId: "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000700", sessionId: "ses_0198d95f-6c00-7000-8000-000000000700", scopes: ["product:read", "message:send"] }) } } });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  for (const request of [
    fetch(`${address.origin}/api/v1/activity`, { headers: headers() }),
    fetch(`${address.origin}/api/v1/channels`, { method: "POST", headers: headers("product-api-channel-off"), body: "{}" }),
    fetch(`${address.origin}/api/v1/bots`, { method: "POST", headers: headers("product-api-lifecycle-off"), body: "{}" }),
  ]) assert.equal((await request).status, 503);
  assert.equal((await fetch(
    `${address.origin}/api/v1/channels/chn_0198d95f-6c00-7000-8000-000000000001/coordinate`,
    { method: "POST", headers: headers(), body: JSON.stringify({ messageId: fixtureId("message", 1) }) },
  )).status, 404);
});

test("Activity and lightweight Bot lifecycle routes expose create, archive, and restore only", async (t) => {
  const calls: string[] = [];
  const botId = "bot_0198d95f-6c00-7000-8000-000000000001";
  const mailboxId = "cnv_0198d95f-6c00-7000-8000-000000000001";
  const activityPage = {
    entries: [{
      key: "work:obs_0198d95f-6c00-7000-8000-000000000703:progress",
      eventSequence: 73, category: "progress", state: "working", label: "Working",
      updatedAt: "2026-08-26T12:00:01.000Z",
      channelId: "chn_0198d95f-6c00-7000-8000-000000000001",
      actor: { principalId: botId, displayName: "Specialist" },
      workId: "wrk_0198d95f-6c00-7000-8000-000000000704",
      observationId: "obs_0198d95f-6c00-7000-8000-000000000703",
      messageId: null, artifactId: null,
      source: {
        kind: "work_observation", id: "obs_0198d95f-6c00-7000-8000-000000000703",
        eventType: "activity.updated", authoritySystem: "resident_turn",
        authorityId: "resident-turn-1", sourceVersion: "1", freshness: "current",
      },
      terminalReason: null, terminalExplanation: null, collapsedCount: 1, compacted: false,
      interval: {
        firstEventSequence: 73, lastEventSequence: 73,
        startedAt: "2026-08-26T12:00:01.000Z", endedAt: "2026-08-26T12:00:01.000Z",
      },
    }],
    nextBoundary: {
      eventSequence: 73,
      key: "work:obs_0198d95f-6c00-7000-8000-000000000703:progress",
    },
    throughEventSequence: 80,
  } as const;
  const receipt = (requestId: string, operation: "create" | "archive" | "restore") => ({
    requestId, requestDigest: "a".repeat(64),
    correlationId: "cor_0198d95f-6c00-7000-8000-000000000700", operation,
    residentBinding: "specialist", botId, mailboxId, authorityEpoch: 7,
    policyDecision: {
      policyVersion: 1, actionDigest: "action-digest", policyContextDigest: "context-digest",
      decision: "allow", reasonCode: "allow.standing_authority",
    },
    outcome: "succeeded",
    completedPhases: operation === "create"
      ? ["authorized", "mailbox_bound"]
      : ["authorized", operation === "archive" ? "mailbox_archived" : "mailbox_restored"],
    failure: null,
    createdAt: "2026-08-26T12:00:00.000Z",
  } as const);
  const flags = { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true, "coordination.public_api.enabled": true, "coordination.channels.enabled": true, "coordination.bot_lifecycle.enabled": true };
  const application = createCoordinationApplication({ flags, services: {
    auth: { validateAccessToken: async () => ({ principalId: "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000700", sessionId: "ses_0198d95f-6c00-7000-8000-000000000700", scopes: ["product:read", "message:send"] }) },
    activity: { list: async () => { calls.push("activity"); return activityPage as any; } },
    authorityEpochs: {
      current: (capability) => capability === "activity" ? {
        capability: "activity",
        epoch: 3,
        mode: "canonical",
        writer: "home23-coordination",
        effectiveAtEventSequence: 80,
        rollbackEpoch: 1,
      } : null,
      listCurrent: async () => ({ epochs: [], throughEventSequence: 80 }),
    },
    botLifecycleApi: {
      create: async (input) => {
        calls.push("bot.create");
        if (input.idempotencyKey === "product-api-create-bot") {
          assert.deepEqual({ displayName: input.displayName, purpose: input.purpose }, {
            displayName: "Specialist", purpose: "Continuing specialist",
          });
        } else {
          assert.deepEqual({
            idempotencyKey: input.idempotencyKey,
            displayName: input.displayName,
            purpose: input.purpose,
          }, {
            idempotencyKey: "product-api-create-legacy-bot",
            displayName: "Legacy Specialist",
            purpose: "Older client compatibility",
          });
        }
        return receipt(input.idempotencyKey, "create") as any;
      },
      control: async ({ operation, idempotencyKey, botId: requestedBotId }) => {
        calls.push(`bot.${operation}`);
        assert.equal(requestedBotId, botId);
        return receipt(idempotencyKey, operation) as any;
      },
    },
  } });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  const activity = await fetch(`${address.origin}/api/v1/activity`, { headers: headers() });
  assert.equal(activity.status, 200);
  assert.deepEqual(await activity.json(), activityPage);
  const created = await fetch(`${address.origin}/api/v1/bots`, { method: "POST", headers: headers("product-api-create-bot"), body: JSON.stringify({ name: "Specialist", purpose: "Continuing specialist", residentBinding: "jerry", requiredCapabilities: ["process-control"] }) });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { receipt: receipt("product-api-create-bot", "create") });
  const legacyCreated = await fetch(`${address.origin}/api/v1/bots`, { method: "POST", headers: headers("product-api-create-legacy-bot"), body: JSON.stringify({ displayName: "Legacy Specialist", purpose: "Older client compatibility", residentBinding: "forrest", requiredCapabilities: ["process-control"] }) });
  assert.equal(legacyCreated.status, 201);
  assert.equal((await fetch(`${address.origin}/api/v1/bots/bot_0198d95f-6c00-7000-8000-000000000001/archive`, { method: "POST", headers: headers("product-api-archive-bot") })).status, 200);
  assert.equal((await fetch(`${address.origin}/api/v1/bots/bot_0198d95f-6c00-7000-8000-000000000001/restore`, { method: "POST", headers: headers("product-api-restore-bot") })).status, 200);
  for (const operation of ["start", "stop", "restart"]) {
    const response = await fetch(`${address.origin}/api/v1/bots/${botId}/${operation}`, {
      method: "POST",
      headers: headers(`product-api-${operation}-bot`),
    });
    assert.equal(response.status, 404);
  }
  assert.deepEqual(calls, ["activity", "bot.create", "bot.create", "bot.archive", "bot.restore"]);
});
