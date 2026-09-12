import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { SqliteDirectMessageContext } from "../../../src/coordination/app/direct-message-context.js";
import { createCanonicalMessageRecorder } from "../../../src/coordination/app/direct-message.js";
import { createLiveVoiceTranscriptPort } from "../../../src/coordination/app/live-voice-transcripts.js";
import type { LiveVoiceAccess } from "../../../src/coordination/app/live-voice.js";
import { MessagingError, SqliteBotConversationBindingAdapter, SqliteMessagingRepository } from "../../../src/coordination/channels/index.js";
import { SqliteCommunicationEventRepository } from "../../../src/coordination/communications/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import { M11MessageProvenanceAuthority } from "../../../src/coordination/work/index.js";
import { AT, BOT_ID, CHANNEL_ID, M11TestDatabase, fixtureId } from "../work/test-fixture.js";

test("processless Bot voice transcripts retain canonical identity, replay safely, and reject changed authority", async t => {
  const database = M11TestDatabase.temporary();
  t.after(() => { database.close(); rmSync(dirname(database.path), { recursive: true, force: true }); });
  const conversationId = fixtureId("conversation", 850);
  const residentBinding = "bot-voice-test";
  database.raw.prepare("INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)")
    .run(conversationId, CHANNEL_ID, AT);
  database.raw.prepare(`UPDATE bots SET name = 'Helper', conversation_id = ?, resident_binding = ?,
    active_instance_id = NULL, active_key_version = NULL, resident_protocol_version = NULL,
    resident_capabilities_json = '[]', resident_registered_at = NULL,
    last_heartbeat_at = NULL, reported_availability = NULL WHERE id = ?`)
    .run(conversationId, residentBinding, BOT_ID);
  const botRecord = {
    id: BOT_ID, principalId: BOT_ID, name: "Helper", purpose: "A processless Bot",
    lifecycle: "active" as const, conversationId, residentBinding,
    continuingIdentity: true, durableMailbox: true, requiredCapabilities: ["messages"],
    activeInstanceId: null as string | null, activeKeyVersion: null,
    residentProtocolVersion: null, residentCapabilities: [] as string[], residentRegisteredAt: null,
    lastHeartbeatAt: null, reportedAvailability: null, availability: "available" as const,
    version: 1, createdAt: AT, updatedAt: AT,
  };
  const messages = createMessageService({
    repository: new SqliteMessagingRepository(database, {
      botConversationBinding: new SqliteBotConversationBindingAdapter(),
      messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
    }),
    participantDirectory: {
      listVisibleBots: async () => [botRecord],
      resolveAlias: async (_namespace, binding) => binding === residentBinding ? botRecord : null,
      getBotByResidentBinding: async binding => binding === residentBinding ? botRecord : null,
    },
    now: () => new Date(AT),
  });
  const communications = new SqliteCommunicationEventRepository(database as never);
  const targets = new SqliteDirectMessageContext(database, messages);
  const port = createLiveVoiceTranscriptPort({ messages, targets,
    resolveResident() { throw new Error("Processless Bots must not impersonate registered residents"); },
    recordMessage: createCanonicalMessageRecorder(communications), assertAuthority() {} });
  const access: LiveVoiceAccess = {
    context: { principalId: "user_owner", requestId: fixtureId("request", 850), correlationId: fixtureId("correlation", 850),
      identity: { kind: "owner", auth: { principalId: "user_owner",
        deviceId: "dev_0198d95f-6c00-7000-8000-000000000850",
        sessionId: "ses_0198d95f-6c00-7000-8000-000000000850", scopes: ["product:read", "message:send"],
      } } },
    channelId: CHANNEL_ID, accessToken: "validated-upstream", network: null,
  };
  const target = await targets.resolveTarget({ context: access.context, channelId: CHANNEL_ID });
  const input = { access, target, speaker: "Voice" as const,
    messageId: fixtureId("message", 850), idempotencyKey: "live-transcript-bot-850",
    text: "Which option did you mean?", replyToMessageId: null,
    turnSelection: { modelAlias: null, reasoningEffort: null } };
  const committed = await port.append(input);
  assert.deepEqual(committed.author, { principalId: BOT_ID, kind: "bot", displayName: "Helper" });
  assert.deepEqual(committed.provenance, { roundId: null, workId: null });
  assert.equal(committed.kind, "result");
  database.reopen();
  assert.deepEqual(await port.append(input), committed);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM messages")!.count, 2);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events WHERE type = 'communication.recorded'")!.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")!.count, 0);

  botRecord.activeInstanceId = "unexpected-resident";
  await assert.rejects(port.append({ ...input, messageId: fixtureId("message", 851), idempotencyKey: "live-transcript-bot-851" }),
    (error: unknown) => error instanceof MessagingError && error.code === "identity_context_mismatch");
  botRecord.activeInstanceId = null;
  database.raw.prepare("UPDATE bots SET lifecycle = 'archived' WHERE id = ?").run(BOT_ID);
  await assert.rejects(port.append(input),
    (error: unknown) => error instanceof MessagingError && error.code === "unknown_channel");
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM messages")!.count, 2);
});
