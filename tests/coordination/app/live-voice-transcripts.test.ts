import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { ResidentCoordinationAdapter, createM11ResidentCoordinationPort, type ResidentAgentPort } from "../../../src/coordination-adapter/index.js";
import { SqliteDirectMessageContext } from "../../../src/coordination/app/direct-message-context.js";
import { createForegroundDetachmentConsumer } from "../../../src/coordination/app/foreground-detachments.js";
import { createCanonicalMessageRecorder, createDirectMessageSubmissionService } from "../../../src/coordination/app/direct-message.js";
import { createLiveVoiceTranscriptPort, type LiveVoiceTranscriptPort } from "../../../src/coordination/app/live-voice-transcripts.js";
import type { LiveVoiceAccess } from "../../../src/coordination/app/live-voice.js";
import { MessagingError, SqliteBotConversationBindingAdapter, SqliteMessagingRepository, type MessagingActorContext } from "../../../src/coordination/channels/index.js";
import { SqliteCommunicationEventRepository } from "../../../src/coordination/communications/index.js";
import { createLeaseService } from "../../../src/coordination/leases/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import { createWorkService, M11MessageProvenanceAuthority, WorkError } from "../../../src/coordination/work/index.js";
import { readInheritedWorkInstructionMessageIds } from "../../../src/coordination/work/service.js";
import { AT, BOT_ID, CHANNEL_ID, M11TestDatabase, OWNER_ID, createFixtureIdGenerator, fixtureId } from "../work/test-fixture.js";

type AppendInput = Parameters<LiveVoiceTranscriptPort["append"]>[0];
const CONVERSATION_ID = fixtureId("conversation", 750);

function fixture(t: test.TestContext) {
  const database = M11TestDatabase.temporary();
  t.after(() => { database.close(); rmSync(dirname(database.path), { recursive: true, force: true }); });
  database.raw.prepare("INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)")
    .run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare("UPDATE bots SET conversation_id = ? WHERE id = ?").run(CONVERSATION_ID, BOT_ID);
  const botRecord = {
    id: BOT_ID, principalId: BOT_ID, name: "Jerry", purpose: "Persistent resident",
    lifecycle: "active" as const, conversationId: CONVERSATION_ID, residentBinding: "jerry",
    continuingIdentity: true, durableMailbox: true, requiredCapabilities: ["messages"],
    activeInstanceId: "resident-1", activeKeyVersion: 1, residentProtocolVersion: 1,
    residentCapabilities: ["messages"], residentRegisteredAt: AT,
    lastHeartbeatAt: AT, reportedAvailability: "available" as const, availability: "available" as const,
    version: 1, createdAt: AT, updatedAt: AT,
  };
  const directory = {
    listVisibleBots: async () => [botRecord],
    resolveAlias: async (_namespace: string, binding: string) => binding === "jerry" ? botRecord : null,
    getBotByResidentBinding: async (binding: string) => binding === "jerry" ? botRecord : null,
  };
  const access: LiveVoiceAccess = {
    context: {
      principalId: OWNER_ID, requestId: fixtureId("request", 750), correlationId: fixtureId("correlation", 750),
      identity: { kind: "owner", auth: {
        principalId: "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000750",
        sessionId: "ses_0198d95f-6c00-7000-8000-000000000750", scopes: ["product:read", "message:send"],
      } },
    },
    channelId: CHANNEL_ID, accessToken: "validated-upstream", network: null,
  };
  const target = { channelId: CHANNEL_ID, conversationId: CONVERSATION_ID,
    targetPrincipalId: BOT_ID, residentBinding: "jerry" };
  let authority = true;
  const resident = {
    context(input: { principalId: string; requestId: string; correlationId: string }): MessagingActorContext {
      return { ...input, identity: { kind: "resident", resident: {
        requestId: input.requestId, correlationId: input.correlationId,
        credential: { residentSlug: "jerry", role: "resident", instanceId: "resident-1", keyVersion: 1 },
      } } };
    },
  };
  function services() {
    const messages = createMessageService({ repository: new SqliteMessagingRepository(database, {
      botConversationBinding: new SqliteBotConversationBindingAdapter(),
      messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
    }),
      participantDirectory: directory, now: () => new Date(AT) });
    const communications = new SqliteCommunicationEventRepository(database as never);
    const targets = new SqliteDirectMessageContext(database, messages);
    const options = { messages, targets, resolveResident: (binding: string) => binding === "jerry" ? resident : undefined,
      recordMessage: createCanonicalMessageRecorder(communications),
      assertAuthority() { if (!authority) throw new MessagingError("authority_unavailable"); } };
    return { messages, communications, targets, options, port: createLiveVoiceTranscriptPort(options) };
  }
  function input(suffix: number, speaker: AppendInput["speaker"], text: string,
    extra: Partial<AppendInput> = {}): AppendInput {
    return { access, target, speaker, text, messageId: fixtureId("message", suffix),
      idempotencyKey: `live-transcript-message-${suffix}`, replyToMessageId: null,
      turnSelection: { modelAlias: null, reasoningEffort: null }, ...extra };
  }
  const counts = () => ({
    messages: database.readOne<{ count: number }>("SELECT count(*) AS count FROM messages")!.count,
    messageEvents: database.readOne<{ count: number }>("SELECT count(*) AS count FROM events WHERE type = 'message.appended'")!.count,
    communicationEvents: database.readOne<{ count: number }>("SELECT count(*) AS count FROM events WHERE type = 'communication.recorded'")!.count,
    works: database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")!.count,
  });
  return { database, access, target, botRecord, services, input, counts,
    setAuthority(value: boolean) { authority = value; } };
}

test("live speech persists in ordered canonical history across reopen, with bot ownership and no Work", async t => {
  const f = fixture(t);
  let services = f.services();
  const utterances = [
    f.input(751, "You", "Which option was it?"),
    f.input(752, "Voice", "You preferred the second option.", { replyToMessageId: fixtureId("message", 751) }),
    f.input(753, "You", "Yes, that one."),
  ];
  const committed = [];
  for (const input of utterances) committed.push(await services.port.append(input));
  assert.deepEqual(committed.map(message => message.sequence), [2, 3, 4]);
  assert.deepEqual(committed.map(message => message.author.kind), ["owner", "bot", "owner"]);
  assert.deepEqual(committed.map(message => message.kind), ["text", "result", "text"]);
  assert.equal(committed[1]!.author.principalId, BOT_ID);
  assert.equal(committed[1]!.author.displayName, "Jerry");
  for (const message of committed) {
    assert.equal(message.clientMessageId, message.id);
    assert.deepEqual(message.provenance, { roundId: null, workId: null });
  }
  assert.deepEqual(f.counts(), { messages: 4, messageEvents: 4, communicationEvents: 3, works: 0 });
  f.database.reopen();
  services = f.services();
  for (const [index, input] of utterances.entries()) {
    const replay = await services.port.append({ ...input, access: { ...input.access, context: {
      ...input.access.context, requestId: fixtureId("request", 900 + index), correlationId: fixtureId("correlation", 900 + index),
    } } });
    assert.deepEqual(replay, committed[index]);
  }
  const page = await services.messages.listMessages({ context: f.access.context, channelId: CHANNEL_ID, limit: 20 });
  assert.deepEqual(page.messages.filter(message => message.sequence > 1), committed);
  const history = services.communications.history({ afterSequence: 0, limit: 50, requestId: f.access.context.requestId });
  assert.equal(history.kind, "events");
  if (history.kind === "events") {
    assert.deepEqual(history.events.map(event => event.messageId), committed.map(message => message.id));
    assert.deepEqual(history.events.map(event => event.payload.text), utterances.map(input => input.text));
  }
  const prepared = await services.targets.prepare({ context: f.access.context, channelId: CHANNEL_ID,
    originMessage: committed[2]!, attachmentIds: [] });
  assert.ok(prepared.historyBackfill.some(entry => entry.text === utterances[0]!.text));
  assert.ok(prepared.historyBackfill.some(entry => entry.text === utterances[1]!.text));
  assert.deepEqual(f.counts(), { messages: 4, messageEvents: 4, communicationEvents: 3, works: 0 });
});

test("ordinary owner Message admission reuses the transcript row and enforces exact body and turn selection", async t => {
  const f = fixture(t);
  const { port, messages, options } = f.services();
  const input = f.input(760, "You", "Check the house temperature.", {
    turnSelection: { modelAlias: "sol", reasoningEffort: "high" },
  });
  const original = await port.append(input);
  const ordinaryInput = {
    context: input.access.context, channelId: input.target.channelId, messageId: input.messageId,
    authorPrincipalId: OWNER_ID, idempotencyKey: input.idempotencyKey,
    kind: "text" as const, text: input.text, mentions: [], attachmentIds: [],
    clientMessageId: input.messageId, replyToMessageId: input.replyToMessageId, tombstonesMessageId: null,
    provenance: { roundId: null, workId: null }, turnSelection: input.turnSelection,
  };
  const replay = await messages.sendMessage(ordinaryInput);
  assert.equal(replay.outcome, "replayed");
  assert.deepEqual(replay.message, original);
  await options.recordMessage({ message: replay.message, kind: "user_message_committed",
    requestId: input.access.context.requestId, correlationId: input.access.context.correlationId,
    turnSelection: input.turnSelection });
  await assert.rejects(messages.sendMessage({ ...ordinaryInput, text: "Change the temperature." }),
    (error: unknown) => error instanceof MessagingError && error.code === "idempotency_conflict");
  await assert.rejects(messages.sendMessage({ ...ordinaryInput, turnSelection: { modelAlias: "sol", reasoningEffort: "low" } }),
    (error: unknown) => error instanceof MessagingError && error.code === "idempotency_conflict");
  assert.deepEqual(f.counts(), { messages: 2, messageEvents: 2, communicationEvents: 1, works: 0 });
});

test("a saved voice confirmation executes through canonical submission once with prior speech in its Work context", { timeout: 5_000 }, async t => {
  const f = fixture(t);
  const { port, messages, targets, communications, options } = f.services();
  const question = await port.append(f.input(790, "You", "Which thermostat should I check?"));
  const explanation = await port.append(f.input(791, "Voice", "The downstairs thermostat is the second option.", {
    replyToMessageId: question.id,
  }));
  const firstSegment = await port.append(f.input(792, "You", "Yes, check that one", {
    turnSelection: { modelAlias: "sol", reasoningEffort: "high" },
  }));
  const interjection = await port.append(f.input(793, "Voice", "I am listening.", { replyToMessageId: firstSegment.id }));
  const input = f.input(794, "You", "and check upstairs too.", {
    turnSelection: { modelAlias: "sol", reasoningEffort: "high" },
  });
  const origin = await port.append(input);
  const instructionMessageIds = [firstSegment.id, origin.id];
  const expectedInstruction = `${firstSegment.text}\n${origin.text}`;
  assert.equal(f.counts().works, 0);

  const generateId = createFixtureIdGenerator(40_000);
  const work = createWorkService({ database: f.database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database: f.database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  let executions = 0;
  let capturedRun: Parameters<ResidentAgentPort["runWithTurn"]>[2] | undefined;
  const agent: ResidentAgentPort = {
    async modelCatalog() {
      return { models: [{ alias: "sol", provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" }],
        defaultModel: "gpt-5.6-sol", defaultProvider: "openai-codex", defaultReasoningEffort: "high",
        reasoningEfforts: ["low", "medium", "high"] };
    },
    async runWithTurn(chatId, instruction, run) {
      executions += 1;
      capturedRun = run;
      assert.equal(instruction, expectedInstruction);
      const turnId = `coord-${run.coordinationOrigin.workId}`;
      await run.onDurableStart({ turnId, chatId, persistedAt: AT,
        selection: { requestedProvider: null, requestedModelAlias: "sol", requestedModel: null, requestedEffort: "high",
          resolvedProvider: "openai-codex", resolvedModel: "gpt-5.6-sol", resolvedEffort: "high",
          actualProvider: "openai-codex", actualModel: "gpt-5.6-sol", actualEffort: "high" } });
      return { turnId, response: Promise.resolve({ text: "The downstairs thermostat reads 72 degrees.",
        model: "gpt-5.6-sol", toolCallCount: 0, durationMs: 1 }) };
    },
    stop: () => ({ stopped: true }),
  };
  const resident = new ResidentCoordinationAdapter(agent, createM11ResidentCoordinationPort(leases),
    () => new Date(AT), communications);
  let activeWork = 0;
  const service = createDirectMessageSubmissionService({ messages, context: targets, work, leases, communications,
    resolveResident: binding => binding === "jerry" ? { resident, holderInstanceId: "resident-1",
      models: agent, context: options.resolveResident(binding)!.context } : undefined,
    authority: { current: () => ({ capability: "messages", epoch: 3, mode: "canonical",
      writer: "home23-coordination", effectiveAtEventSequence: 1, rollbackEpoch: 1 }) },
    beginWork() { activeWork += 1; return () => { activeWork -= 1; }; },
    recoveryIdentity: () => ({ requestId: fixtureId("request", 793), correlationId: fixtureId("correlation", 793) }),
  });
  const submission = { context: input.access.context, channelId: input.target.channelId,
    idempotencyKey: input.idempotencyKey, instructionMessageIds,
    body: { messageId: input.messageId, clientMessageId: input.messageId, text: input.text,
      mentions: [], attachmentIds: [], replyToMessageId: input.replyToMessageId, ...input.turnSelection } };
  const accepted = await service.submitMessage(submission);
  const result = await accepted.response;
  assert.deepEqual(accepted.message, origin);
  assert.equal(accepted.work.originMessageId, origin.id);
  assert.equal(accepted.work.channelId, CHANNEL_ID);
  assert.equal(work.get(accepted.work.id)?.state, "succeeded");
  assert.equal(executions, 1);
  assert.equal(activeWork, 0);
  assert.ok(capturedRun);
  assert.equal(capturedRun.coordinationOrigin.originMessageId, origin.id);
  assert.deepEqual(capturedRun.turnSelection, input.turnSelection);
  assert.deepEqual(capturedRun.historyBackfill?.filter(entry => entry.messageId === question.id || entry.messageId === explanation.id)
    .map(entry => ({ id: entry.messageId, text: entry.text })),
  [{ id: question.id, text: question.text }, { id: explanation.id, text: explanation.text }]);
  assert.ok(capturedRun.historyBackfill?.some(entry => entry.messageId === interjection.id));
  assert.ok(!capturedRun.historyBackfill?.some(entry => instructionMessageIds.includes(entry.messageId)),
    "every selected owner segment remains current instruction rather than duplicate historical speech");
  const manifest = f.database.readOne<{ messages: string }>(
    "SELECT m.message_refs_json AS messages FROM context_manifests m JOIN works w ON w.context_manifest_id=m.id WHERE w.id=?",
    accepted.work.id)!;
  const references = JSON.parse(manifest.messages) as string[];
  for (const message of [question, explanation, firstSegment, interjection, origin]) assert.ok(references.includes(message.id));
  assert.equal(result.author.principalId, BOT_ID);
  assert.equal(result.kind, "result");
  assert.equal(result.text, "The downstairs thermostat reads 72 degrees.");
  assert.equal(result.replyToMessageId, origin.id);
  assert.deepEqual(result.provenance, { roundId: null, workId: accepted.work.id });

  f.database.reopen();
  assert.deepEqual(work.getInstructionMessageIds(accepted.work.id), instructionMessageIds);
  const recovered = await f.services().targets.recover(work.get(accepted.work.id)!);
  assert.equal(recovered.prepared.instruction, expectedInstruction);
  assert.deepEqual(recovered.prepared.instructionMessageIds, instructionMessageIds);
  assert.ok(!recovered.prepared.historyBackfill.some(entry => instructionMessageIds.includes(entry.messageId)));
  assert.ok(recovered.prepared.historyBackfill.some(entry => entry.messageId === interjection.id));
  await assert.rejects(service.submitMessage({ ...submission, instructionMessageIds: undefined }),
    (error: unknown) => error instanceof MessagingError && error.code === "idempotency_conflict");
  await assert.rejects(service.submitMessage({ ...submission, instructionMessageIds: [origin.id] }),
    (error: unknown) => error instanceof MessagingError && error.code === "idempotency_conflict");
  const replay = await service.submitMessage(submission);
  assert.equal(replay.replayed, true);
  assert.equal(replay.work.id, accepted.work.id);
  assert.deepEqual(await replay.response, result);
  assert.equal(executions, 1);
  assert.equal(activeWork, 0);
  assert.equal(f.counts().works, 1);
  assert.equal(f.counts().messages, 7, "one seed, five transcript rows and one canonical action result");
  assert.equal(f.database.readOne<{ count: number }>("SELECT count(*) AS count FROM attempts")!.count, 1);
  assert.equal(f.database.readOne<{ count: number }>("SELECT count(*) AS count FROM leases")!.count, 1);
  const page = await messages.listMessages({ context: f.access.context, channelId: CHANNEL_ID, limit: 20 });
  assert.deepEqual(page.messages.filter(message => message.sequence > 1), [question, explanation, firstSegment, interjection, origin, result]);
  const evidence = communications.history({ afterSequence: 0, limit: 100, requestId: f.access.context.requestId });
  assert.equal(evidence.kind, "events");
  if (evidence.kind === "events") {
    assert.equal(evidence.events.filter(event => event.kind === "user_message_committed" && event.messageId === origin.id).length, 1);
    assert.equal(evidence.events.filter(event => event.kind === "assistant_message_committed" && event.messageId === result.id).length, 1);
  }
});

test("instruction partitions reject bot, reordered, duplicate, future and foreign-channel rows", async t => {
  const f = fixture(t);
  const { port, targets } = f.services();
  const first = await port.append(f.input(810, "You", "Check downstairs"));
  const voice = await port.append(f.input(811, "Voice", "Anything else?"));
  const origin = await port.append(f.input(812, "You", "and upstairs."));
  const future = await port.append(f.input(813, "You", "This later turn must stay separate."));
  const foreign = fixtureId("message", 814);
  const foreignChannel = fixtureId("channel", 814);
  f.database.raw.prepare(`INSERT INTO channels SELECT ?,kind,title,purpose,owner_principal_id,responder_mode,
    coordinator_bot_id,response_order,max_bot_turns,lifecycle,pinned,version,next_message_sequence,created_at,updated_at
    FROM channels WHERE id=?`).run(foreignChannel, CHANNEL_ID);
  f.database.raw.prepare(`INSERT INTO channel_members SELECT ?,principal_id,kind,role,active,joined_at,left_at
    FROM channel_members WHERE channel_id=? AND principal_id=?`).run(foreignChannel, CHANNEL_ID, OWNER_ID);
  f.database.raw.prepare(`INSERT INTO messages (id,channel_id,channel_sequence,author_principal_id,author_kind,
    author_display_name,kind,body_text,stored_visibility,created_at) VALUES (?, ?, 1, ?, 'owner','Owner','text','Other conversation','visible',?)`)
    .run(foreign, foreignChannel, OWNER_ID, AT);
  const prepare = (ids: readonly string[]) => targets.prepare({ context: f.access.context, channelId: CHANNEL_ID,
    originMessage: origin, attachmentIds: [], instructionMessageIds: ids });
  for (const ids of [[], [voice.id, origin.id], [origin.id, first.id], [first.id, first.id, origin.id],
    [first.id], [future.id, origin.id], [foreign, origin.id], ["not-a-message", origin.id]]) {
    await assert.rejects(prepare(ids), (error: unknown) => error instanceof MessagingError && error.code === "invalid_relation");
  }
  const selected = await prepare([first.id, origin.id]);
  assert.equal(selected.instruction, `${first.text}\n${origin.text}`);
  assert.ok(selected.historyBackfill.some(entry => entry.messageId === voice.id));
  assert.ok(!selected.historyBackfill.some(entry => entry.messageId === future.id));
  const ordinary = await targets.prepare({ context: f.access.context, channelId: CHANNEL_ID, originMessage: origin, attachmentIds: [] });
  assert.equal(ordinary.instruction, origin.text);
  assert.notDeepEqual(selected.manifest.digests, ordinary.manifest.digests);
  assert.deepEqual(Object.keys(selected.manifest).sort(), Object.keys(ordinary.manifest).sort());
  assert.equal(f.counts().works, 0);
});

test("instruction evidence survives reopen and rejects changed, missing or corrupt durable IDs", async t => {
  const f = fixture(t);
  const { port, targets } = f.services();
  const first = await port.append(f.input(820, "You", "Check downstairs"));
  const origin = await port.append(f.input(821, "You", "and upstairs."));
  const instructionMessageIds = [first.id, origin.id];
  const prepared = await targets.prepare({ context: f.access.context, channelId: CHANNEL_ID,
    originMessage: origin, attachmentIds: [], instructionMessageIds });
  const work = createWorkService({ database: f.database, generateId: createFixtureIdGenerator(41_000), now: () => new Date(AT) });
  const creation = { principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: origin.id, roundId: null, kind: "resident_turn", idempotencyKey: "voice-partition-durable-0001",
    manifest: prepared.manifest, maxAutomaticOffers: 1, requestId: f.access.context.requestId,
    correlationId: f.access.context.correlationId, instructionMessageIds };
  const accepted = work.create(creation);
  f.database.reopen();
  assert.deepEqual(work.getInstructionMessageIds(accepted.work.id), instructionMessageIds);
  assert.equal(work.create(creation).replayed, true);
  for (const ids of [undefined, [origin.id]]) {
    await assert.rejects(async () => work.create({ ...creation, instructionMessageIds: ids }),
      (error: unknown) => error instanceof WorkError && error.code === "idempotency_conflict");
  }
  const evidence = f.database.readOne<{ payloadJson: string; payloadDigest: string }>(
    "SELECT payload_json AS payloadJson,payload_digest AS payloadDigest FROM events WHERE aggregate_kind='work' AND aggregate_id=? AND aggregate_version=1", accepted.work.id)!;
  assert.deepEqual(JSON.parse(evidence.payloadJson).instructionMessageIds, instructionMessageIds);
  assert.ok(!evidence.payloadJson.includes(first.text!));
  const replaceEvidence = (text: string, digest = createHash("sha256").update(text).digest("hex")) => {
    f.database.raw.prepare("UPDATE events SET payload_json=?,payload_digest=? WHERE aggregate_kind='work' AND aggregate_id=? AND aggregate_version=1")
      .run(text, digest, accepted.work.id);
  };
  for (const ids of [undefined, [origin.id]]) {
    const payload = JSON.parse(evidence.payloadJson);
    if (ids === undefined) delete payload.instructionMessageIds;
    else payload.instructionMessageIds = ids;
    replaceEvidence(JSON.stringify(payload));
    assert.throws(() => work.getInstructionMessageIds(accepted.work.id), /instruction evidence differs/);
    await assert.rejects(targets.recover(work.get(accepted.work.id)!),
      (error: unknown) => error instanceof MessagingError && error.code === "invalid_relation");
  }
  replaceEvidence(evidence.payloadJson, "0".repeat(64));
  assert.throws(() => work.getInstructionMessageIds(accepted.work.id), /evidence digest differs/);
  replaceEvidence(evidence.payloadJson, evidence.payloadDigest);
  assert.equal((await targets.recover(work.get(accepted.work.id)!)).prepared.instruction, `${first.text}\n${origin.text}`);
  f.database.raw.prepare("DELETE FROM events WHERE aggregate_kind='work' AND aggregate_id=? AND aggregate_version=1").run(accepted.work.id);
  assert.throws(() => work.getInstructionMessageIds(accepted.work.id), /instruction evidence differs/);
});

test("authenticated background detachment inherits the exact spoken request through durable parent lineage", async t => {
  const f = fixture(t);
  const { port, targets } = f.services();
  const first = await port.append(f.input(830, "You", "Review the system"));
  const origin = await port.append(f.input(831, "You", "and preserve every existing change."));
  const instructionMessageIds = [first.id, origin.id];
  const prepared = await targets.prepare({ context: f.access.context, channelId: CHANNEL_ID,
    originMessage: origin, attachmentIds: [], instructionMessageIds });
  const generateId = createFixtureIdGenerator(42_000);
  const now = () => new Date(AT);
  const work = createWorkService({ database: f.database, generateId, now });
  const leases = createLeaseService({ database: f.database, generateId, now, leaseTtlMs: 60_000 });
  const identity = { requestId: fixtureId("request", 830), correlationId: fixtureId("correlation", 830) };
  const parent = work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: origin.id, roundId: null, kind: "resident_turn", idempotencyKey: "voice-parent-detachment-0001",
    manifest: prepared.manifest, maxAutomaticOffers: 1, instructionMessageIds,
    turnSelection: { modelAlias: "sol", reasoningEffort: "high" }, ...identity }).work;
  const offer = leases.offer({ workId: parent.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1",
    authorityReference: "resident:jerry", automatic: true, ...identity });
  const binding = { workId: parent.id, attemptId: offer.attempt.id, leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offer.fencingToken, ...identity };
  leases.accept(binding); leases.start(binding);
  const parentOrigin = { kind: "coordination" as const, ...binding, authorityReference: "resident:jerry",
    channelId: CHANNEL_ID, originMessageId: origin.id, roundId: null };
  const credential = { residentSlug: "jerry", instanceId: "jerry-client", keyVersion: 1 };
  const scheduled: string[] = [];
  const admission = createForegroundDetachmentConsumer({ database: f.database, work, now,
    resolveResident: () => ({ clientInstanceId: "jerry-client", serverInstanceId: "resident-1", keyVersion: 1 }),
    schedule: id => { scheduled.push(id); } });
  const request = { parentOrigin, residentSlug: "jerry", invocationId: "voice-background-1", toolName: "spawn_agent",
    canonicalArgs: { task: "Review system without overwriting existing work" }, executionInstruction: "Review system without overwriting existing work",
    title: "System review", summary: "Review the current system", recoveryPolicy: "safe_before_start" as const };
  const accepted = admission.admit({ credential, request });
  assert.deepEqual(scheduled, [accepted.workId]);
  assert.deepEqual(admission.admit({ credential, request }), accepted);
  f.database.reopen();
  const child = work.get(accepted.workId)!;
  assert.equal(child.kind, "resident_work_thread");
  assert.equal(work.getInstructionMessageIds(child.id), undefined,
    "the child keeps its own planned execution digest with presentation and selected model");
  assert.deepEqual(readInheritedWorkInstructionMessageIds(f.database, child), instructionMessageIds);
  const recovered = await targets.recover(child);
  assert.equal(recovered.prepared.instruction, `${first.text}\n${origin.text}`);
  assert.deepEqual(recovered.prepared.manifest, prepared.manifest);
  assert.deepEqual(recovered.prepared.instructionMessageIds, instructionMessageIds);
  assert.ok(!recovered.prepared.historyBackfill.some(entry => instructionMessageIds.includes(entry.messageId)));
  assert.deepEqual(work.getPlannedInvocation(child.id)?.canonicalArgs, request.canonicalArgs);
  assert.deepEqual(work.getTurnSelection(child.id), { modelAlias: "sol", reasoningEffort: "high" });
  await assert.rejects(targets.recover({ ...child, originMessageId: first.id }), /invalid_relation/);
  const forged = work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: origin.id, roundId: null, kind: "resident_work_thread", idempotencyKey: "voice-forged-child-0001",
    manifest: prepared.manifest, maxAutomaticOffers: 1, ...identity,
    plannedInvocation: { ...request, invocationId: "voice-forged-2", parentOrigin: { ...parentOrigin, originMessageId: first.id } },
  }).work;
  await assert.rejects(targets.recover(forged), /invalid_relation/);
});

test("replay repairs interrupted communication recording without another Message or duplicate event", async t => {
  const f = fixture(t);
  const { options } = f.services();
  const input = f.input(770, "Voice", "We can continue when you are ready.");
  const interrupted = createLiveVoiceTranscriptPort({ ...options, recordMessage: async () => { throw new Error("interrupted recording"); } });
  await assert.rejects(interrupted.append(input), /interrupted recording/);
  assert.deepEqual(f.counts(), { messages: 2, messageEvents: 2, communicationEvents: 0, works: 0 });
  f.database.reopen();
  const { port } = f.services();
  const recovered = await port.append(input);
  assert.deepEqual(await port.append(input), recovered);
  assert.deepEqual(f.counts(), { messages: 2, messageEvents: 2, communicationEvents: 1, works: 0 });
});

test("transcripts reject redirected targets, owner scope loss, stale resident credentials, and noncanonical authority", async t => {
  const f = fixture(t);
  const { port, options } = f.services();
  const input = f.input(780, "Voice", "A private reply.");
  for (const target of [
    { ...input.target, targetPrincipalId: fixtureId("bot", 999) },
    { ...input.target, residentBinding: "forrest" },
    { ...input.target, conversationId: fixtureId("conversation", 999) },
    { ...input.target, channelId: fixtureId("channel", 999) },
  ]) await assert.rejects(port.append({ ...input, target }),
    (error: unknown) => error instanceof MessagingError && error.code === "identity_context_mismatch");
  await assert.rejects(port.append({ ...input, access: { ...f.access, context: {
    ...f.access.context, principalId: BOT_ID,
  } } }), (error: unknown) => error instanceof MessagingError && error.code === "identity_context_mismatch");
  assert.equal(f.access.context.identity.kind, "owner");
  if (f.access.context.identity.kind === "owner") {
    await assert.rejects(port.append({ ...input, access: { ...f.access, context: { ...f.access.context,
      identity: { kind: "owner", auth: { ...f.access.context.identity.auth, scopes: ["product:read"] } },
    } } }), (error: unknown) => error instanceof MessagingError && error.code === "scope_denied");
  }
  await assert.rejects(createLiveVoiceTranscriptPort({ ...options, resolveResident: () => undefined }).append(input),
    (error: unknown) => error instanceof MessagingError && error.code === "authority_unavailable");
  f.botRecord.activeKeyVersion = 2;
  await assert.rejects(port.append(input),
    (error: unknown) => error instanceof MessagingError && error.code === "identity_context_mismatch");
  f.botRecord.activeKeyVersion = 1;
  f.setAuthority(false);
  await assert.rejects(port.append(input),
    (error: unknown) => error instanceof MessagingError && error.code === "authority_unavailable");
  f.setAuthority(true);
  f.database.raw.prepare("UPDATE channels SET lifecycle='archived' WHERE id=?").run(CHANNEL_ID);
  await assert.rejects(port.append(input),
    (error: unknown) => error instanceof MessagingError && error.code === "unknown_channel");
  assert.deepEqual(f.counts(), { messages: 1, messageEvents: 1, communicationEvents: 0, works: 0 });
});
