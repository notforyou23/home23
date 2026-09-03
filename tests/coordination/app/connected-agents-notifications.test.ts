import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCanonicalMessageRecorder,
  createCoordinationApplication,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";
import type { MessageProjection } from "../../../src/coordination/messages/index.js";
import { ApnsPusher } from "../../../src/push/apns-pusher.js";
import { ConnectedAgentsDeliveryStore } from "../../../src/push/connected-agents-delivery-store.js";
import { ConnectedAgentsNotificationService } from "../../../src/push/connected-agents.js";
import { DeviceRegistry } from "../../../src/push/device-registry.js";
import type { PushPayload } from "../../../src/push/types.js";

const suffix = "0198d95f-6c00-7000-8000-000000000911";

test("canonical push registers the authenticated device and wakes on the durable assistant Message only", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-connected-agents-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = new DeviceRegistry(join(root, "devices.json"), {
    now: () => new Date("2026-09-02T12:00:00.000Z"),
  });
  let deliveredPayload: PushPayload | undefined;
  let deliveryCount = 0;
  let noteDelivery: (() => void) | undefined;
  const delivery = new Promise<void>((resolve) => { noteDelivery = resolve; });
  const pusher = new ApnsPusher({
    send: async (_token: string, payload: PushPayload) => {
      deliveryCount += 1;
      deliveredPayload = payload;
      noteDelivery?.();
      return { status: 200 };
    },
  } as any, registry, "Home23", {
    connectedAgentsDeliveryStore: new ConnectedAgentsDeliveryStore(
      join(root, "connected-agents-deliveries"),
    ),
    connectedAgentsRegistrationIsCurrent: (registration) =>
      registration.coordination_device_id === `dev_${suffix}` &&
      registration.coordination_session_id === `ses_${suffix}`,
  });
  const notifications = new ConnectedAgentsNotificationService(
    registry,
    pusher,
    "com.regina6.home23.canary",
  );
  const application = createCoordinationApplication({
    flags: {
      ...disabledCoordinationFeatureFlags(),
      "coordination.process.enabled": true,
      "coordination.public_api.enabled": true,
    },
    services: {
      auth: {
        validateAccessToken: async () => ({
          principalId: "user_owner" as const,
          deviceId: `dev_${suffix}`,
          sessionId: `ses_${suffix}`,
          scopes: ["product:read" as const],
        }),
      },
      deviceNotifications: notifications,
    },
  });
  assert.equal(application.capabilities().capabilities.push, true);
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  const endpoint = `${address.origin}/api/v1/devices/current/push`;

  assert.equal((await fetch(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{}",
  })).status, 401);
  assert.equal((await fetch(endpoint, {
    method: "PUT",
    headers: {
      authorization: "Bearer canonical-product-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      deviceToken: "a".repeat(64),
      environment: "sandbox",
      platform: "ios",
      appBuild: "911",
      agent: "jerry",
    }),
  })).status, 400, "client cannot supply routing identity");
  const registered = await fetch(endpoint, {
    method: "PUT",
    headers: {
      authorization: "Bearer canonical-product-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      deviceToken: "a".repeat(64),
      environment: "sandbox",
      platform: "ios",
      appBuild: "911",
    }),
  });
  assert.equal(registered.status, 200);
  assert.deepEqual(await registered.json(), {
    registered: true,
    deviceId: `dev_${suffix}`,
    sessionId: `ses_${suffix}`,
    environment: "sandbox",
    updatedAt: "2026-09-02T12:00:00.000Z",
  });

  const message: MessageProjection = {
    id: `msg_${suffix}`,
    channelId: `chn_${suffix}`,
    conversationId: `cnv_${suffix}`,
    sequence: 2,
    author: {
      principalId: `bot_${suffix}`,
      kind: "bot",
      displayName: "Forrest",
    },
    kind: "result",
    text: "private answer content that must not enter APNs",
    mentions: [],
    clientMessageId: null,
    replyToMessageId: `msg_0198d95f-6c00-7000-8000-000000000910`,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: `wrk_${suffix}` },
    createdAt: "2026-09-02T12:00:01.000Z",
    attachments: [],
    visibility: "visible",
  };
  let communicationAppendCount = 0;
  const recordMessage = createCanonicalMessageRecorder({
    append: async () => ({
      outcome: communicationAppendCount++ === 0 ? "inserted" : "duplicate",
      event: {},
    }),
  } as any, notifications);
  await recordMessage({
    message,
    kind: "assistant_message_committed",
    requestId: `req_${suffix}`,
    correlationId: `cor_${suffix}`,
  });
  await delivery;
  assert.deepEqual(deliveredPayload, {
    aps: {
      alert: { title: "Forrest", body: "Reply ready" },
      "mutable-content": 1,
      sound: "default",
    },
    kind: "connected_agents_message",
    conversationId: `cnv_${suffix}`,
    channelId: `chn_${suffix}`,
    messageId: `msg_${suffix}`,
    workId: `wrk_${suffix}`,
    displayName: "Forrest",
  });
  assert.equal(JSON.stringify(deliveredPayload).includes("private answer"), false);
  assert.equal(JSON.stringify(deliveredPayload).includes("receipt"), false);

  await recordMessage({
    message,
    kind: "assistant_message_committed",
    requestId: `req_${suffix}`,
    correlationId: `cor_${suffix}`,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deliveryCount, 1, "replayed message evidence must not duplicate notifications");
});

test("canonical push durably retries and duplicate recovery repairs a missing delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-connected-agents-delivery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = new DeviceRegistry(join(root, "devices.json"));
  registry.register({
    device_token: "b".repeat(64),
    bundle_id: "com.regina6.home23.canary",
    env: "sandbox",
    chat_ids: [],
    connected_agents_notifications: true,
    coordination_device_id: `dev_${suffix}`,
    coordination_session_id: `ses_${suffix}`,
  });
  const storePath = join(root, "connected-agents-deliveries");
  const store = new ConnectedAgentsDeliveryStore(storePath);
  let attempts = 0;
  let delivered: (() => void) | undefined;
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  const pusher = new ApnsPusher({
    send: async () => {
      attempts += 1;
      if (attempts === 1) return { status: 503 };
      if (attempts === 2) throw new Error("temporary network failure");
      delivered?.();
      return { status: 200 };
    },
  } as any, registry, "Home23", {
    connectedAgentsDeliveryStore: store,
    connectedAgentsRetryDelaysMs: [0, 0],
  });
  const notifications = new ConnectedAgentsNotificationService(
    registry,
    pusher,
    "com.regina6.home23.canary",
  );
  const message: MessageProjection = {
    id: `msg_${suffix}`,
    channelId: `chn_${suffix}`,
    conversationId: `cnv_${suffix}`,
    sequence: 2,
    author: {
      principalId: `bot_${suffix}`,
      kind: "bot",
      displayName: "Jerry",
    },
    kind: "result",
    text: "durable answer",
    mentions: [],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: `wrk_${suffix}` },
    createdAt: "2026-09-02T12:00:01.000Z",
    attachments: [],
    visibility: "visible",
  };
  const recoverDuplicate = createCanonicalMessageRecorder({
    append: async () => ({ outcome: "duplicate", event: {} }),
  } as any, notifications);
  await recoverDuplicate({
    message,
    kind: "assistant_message_committed",
    requestId: `req_${suffix}`,
    correlationId: `cor_${suffix}`,
  });
  await delivery;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.deepEqual(store.snapshot().map(receipt => ({
    state: receipt.state,
    attempts: receipt.attempts,
  })), [{ state: "delivered", attempts: 3 }]);

  const reopened = new ConnectedAgentsDeliveryStore(storePath);
  const restartedPusher = new ApnsPusher({
    send: async () => {
      attempts += 1;
      return { status: 200 };
    },
  } as any, registry, "Home23", {
    connectedAgentsDeliveryStore: reopened,
    connectedAgentsRetryDelaysMs: [0, 0],
  });
  await restartedPusher.notifyConnectedAgentsMessage({
    conversationId: message.conversationId,
    channelId: message.channelId,
    messageId: message.id,
    workId: message.provenance.workId!,
    displayName: message.author.displayName,
  });
  assert.equal(attempts, 3, "durable success must suppress restart replay");

  const invalidMessageId = "msg_0198d95f-6c00-7000-8000-000000000912";
  const invalidPusher = new ApnsPusher({
    send: async () => ({ status: 410 }),
  } as any, registry, "Home23", {
    connectedAgentsDeliveryStore: reopened,
    connectedAgentsRetryDelaysMs: [0, 0],
  });
  await invalidPusher.notifyConnectedAgentsMessage({
    conversationId: message.conversationId,
    channelId: message.channelId,
    messageId: invalidMessageId,
    displayName: message.author.displayName,
  });
  assert.equal(reopened.snapshot().find(
    receipt => receipt.message_id === invalidMessageId,
  )?.state, "invalid");
  assert.equal(registry.lookupConnectedAgentsDevices().length, 0);
});
