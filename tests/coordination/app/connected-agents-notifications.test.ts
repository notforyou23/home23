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
  let noteDelivery: (() => void) | undefined;
  const delivery = new Promise<void>((resolve) => { noteDelivery = resolve; });
  const pusher = new ApnsPusher({
    send: async (_token: string, payload: PushPayload) => {
      deliveredPayload = payload;
      noteDelivery?.();
      return { status: 200 };
    },
  } as any, registry, "Home23", {
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
  await createCanonicalMessageRecorder(undefined, notifications)({
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
});
