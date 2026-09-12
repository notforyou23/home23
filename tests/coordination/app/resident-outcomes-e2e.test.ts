import { parseHistoricalContext } from '../../../src/agent/historical-context.js';
import { createResidentOutcomeStore } from '../../../src/coordination/app/resident-outcomes.js';
import { RESIDENT_OUTCOMES_MIGRATION_SQL } from '../../../src/coordination/migrations/0014-resident-outcomes.js';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ResidentCoordinationAdapter, createM11ResidentCoordinationPort } from "../../../src/coordination-adapter/index.js";
import { createCoordinationApplication, createDirectMessageSubmissionService, disabledCoordinationFeatureFlags, SqliteDirectMessageContext } from "../../../src/coordination/app/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";
import { SqliteBotConversationBindingAdapter, SqliteMessagingRepository } from "../../../src/coordination/channels/index.js";
import { SqliteEventRepository } from "../../../src/coordination/events/index.js";
import { SqliteCommunicationEventRepository } from "../../../src/coordination/communications/index.js";
import { createLeaseService, LeaseError } from "../../../src/coordination/leases/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import { createUnreadService, SqliteUnreadRepository } from "../../../src/coordination/unread/index.js";
import { createWorkService, M11MessageProvenanceAuthority } from "../../../src/coordination/work/index.js";
import type { ResidentAgentPort } from "../../../src/coordination-adapter/index.js";
import { AT, BOT_ID, CHANNEL_ID, M11TestDatabase, OWNER_ID, createFixtureIdGenerator, fixtureId } from "../work/test-fixture.js";
import type { AuthorityEpoch } from "../../../src/coordination/epochs/index.js";

const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000901";
const canonicalMessagesAuthority = Object.freeze({
  capability: "messages" as const,
  epoch: 3,
  mode: "canonical" as const,
  writer: "home23-coordination",
  effectiveAtEventSequence: 41,
  rollbackEpoch: 1,
});

for (const [laterMessages, legacySnapshot, splitVoice] of [[2,false,false],[102,false,false],[2,true,false],[2,false,true],[102,false,true]] as const) test(`outcome follow-through preserves the strict resident history boundary with ${laterMessages} later messages, legacy snapshot ${legacySnapshot}, split voice ${splitVoice}`, async (t) => {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  database.raw.prepare("INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)")
    .run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare("UPDATE bots SET conversation_id = ? WHERE id = ?").run(CONVERSATION_ID, BOT_ID);

  const botRecord = Object.freeze({
    id: BOT_ID, principalId: BOT_ID, name: "Jerry", purpose: "Persistent resident",
    lifecycle: "active" as const, conversationId: CONVERSATION_ID, residentBinding: "jerry",
    continuingIdentity: true, durableMailbox: true, requiredCapabilities: Object.freeze(["messages"]),
    activeInstanceId: "resident-1", activeKeyVersion: 1, residentProtocolVersion: 1,
    residentCapabilities: Object.freeze(["messages"]), residentRegisteredAt: AT,
    lastHeartbeatAt: AT, reportedAvailability: "available" as const, availability: "available" as const,
    version: 1, createdAt: AT, updatedAt: AT,
  });
  const directory = {
    listVisibleBots: async () => [botRecord],
    resolveAlias: async (_namespace: string, value: string) => value === "jerry" ? botRecord : null,
    getBotByResidentBinding: async (value: string) => value === "jerry" ? botRecord : null,
  };
  const repository = new SqliteMessagingRepository(database, {
    botConversationBinding: new SqliteBotConversationBindingAdapter(),
    messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
  });
  const messages = createMessageService({ repository, participantDirectory: directory, now: () => new Date(AT) });
  const generateId = createFixtureIdGenerator(30_000);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const communications = new SqliteCommunicationEventRepository(database);
  let resolveAgent!: (response: { text: string; model: string; toolCallCount: number; durationMs: number }) => void;
  const agentResponse = new Promise<{ text: string; model: string; toolCallCount: number; durationMs: number }>((resolve) => {
    resolveAgent = resolve;
  });
  let residentAttachments = 0; let initialReviewRejected = false;
  const instructions:string[]=[]; const histories:unknown[]=[];
  const agent: ResidentAgentPort = {
    async modelCatalog() {
      return {
        models: [{ alias: "sol", provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" }],
        defaultModel: "gpt-5.6-terra",
        defaultProvider: "openai-codex",
        defaultReasoningEffort: "medium",
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      };
    },
    async runWithTurn(chatId, _text, options) {
      if (legacySnapshot && residentAttachments === 1 && !initialReviewRejected) { initialReviewRejected = true; throw new Error('fixture pre-admission interruption'); }
      parseHistoricalContext(options.historyBackfill, options.coordinationOrigin.originMessageId);
      residentAttachments += 1; instructions.push(_text); histories.push(options.historyBackfill);
      const turnId = `coord-${options.coordinationOrigin.workId}`;
      const selected = options.turnSelection.modelAlias === "sol"
        ? { provider: "openai-codex", model: "gpt-5.6-sol" }
        : { provider: "openai-codex", model: "gpt-5.6-terra" };
      const actualEffort = options.turnSelection.reasoningEffort ?? "medium";
      await options.onDurableStart({
        turnId, chatId, persistedAt: AT,
        selection: {
          requestedProvider: null,
          requestedModelAlias: options.turnSelection.modelAlias,
          requestedModel: null,
          requestedEffort: options.turnSelection.reasoningEffort,
          resolvedProvider: selected.provider,
          resolvedModel: selected.model,
          resolvedEffort: actualEffort,
          actualProvider: selected.provider,
          actualModel: selected.model,
          actualEffort,
        },
      });
      options.onEvent({
        turnId,
        sequence: 1,
        occurredAt: AT,
        provider: "fixture",
        model: "test-executor",
        reasoningEffort: actualEffort,
        event: { type: "status", status: "working", sourceEventType: "runtime.status" },
      });
      return { turnId, response: agentResponse };
    },
    stop: () => ({ stopped: true }),
  };
  const resident = new ResidentCoordinationAdapter(
    agent,
    createM11ResidentCoordinationPort(leases),
    () => new Date(AT),
    communications,
  );
  const owner = {
    principalId: OWNER_ID, requestId: fixtureId("request", 900), correlationId: fixtureId("correlation", 900),
    identity: { kind: "owner" as const, auth: {
      principalId: OWNER_ID as "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000900",
      sessionId: "ses_0198d95f-6c00-7000-8000-000000000900", scopes: ["product:read", "message:send"] as const,
    } },
  };
  let activeBackgroundWork = 0;
  const beginWork = () => {
    activeBackgroundWork += 1;
    return () => { activeBackgroundWork -= 1; };
  };
  const residentContext = ({ principalId, requestId, correlationId }: {
    residentBinding: string; principalId: string; requestId: string; correlationId: string;
  }) => ({
    principalId, requestId, correlationId,
    identity: { kind: "resident", resident: { requestId, correlationId, credential: {
      residentSlug: "jerry", role: "resident", instanceId: "resident-1", keyVersion: 1,
    } } },
  } as const);

  database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
  const outcomes=createResidentOutcomeStore(database);
  const service=createDirectMessageSubmissionService({messages,context:new SqliteDirectMessageContext(database,messages),work,leases,communications,outcomes,
    resolveResident:()=>({resident,holderInstanceId:'resident-1',models:agent,context:input=>residentContext({...input,residentBinding:'jerry'})}),
    authority:{current:()=>canonicalMessagesAuthority},beginWork,recoveryIdentity:()=>({requestId:fixtureId('request',999),correlationId:fixtureId('correlation',999)})});
  const originalText = splitVoice ? 'Review the work\nand preserve my changes.' : 'Review the work and preserve my changes.';
  if (splitVoice) await messages.sendMessage({ context: owner, channelId: CHANNEL_ID, messageId: fixtureId('message', 899),
    authorPrincipalId: OWNER_ID, idempotencyKey: 'outcome-voice-first-segment', kind: 'text', text: 'Review the work',
    mentions: [], clientMessageId: fixtureId('message', 899), replyToMessageId: null, tombstonesMessageId: null,
    provenance: { roundId: null, workId: null } });
  const accepted=await service.submitMessage({context:owner,channelId:CHANNEL_ID,idempotencyKey:'outcome-origin-0001',
    ...(splitVoice ? { instructionMessageIds: [fixtureId('message',899),fixtureId('message',900)] } : {}),
    body:{messageId:fixtureId('message',900),clientMessageId:'client-outcome',text:splitVoice?'and preserve my changes.':originalText,attachmentIds:[],mentions:[],replyToMessageId:null}});
  resolveAgent({text:'Evidence report',model:'gpt-5.6-terra',toolCallCount:0,durationMs:1});await accepted.response;
  for(let n=0;n<laterMessages;n++)await messages.sendMessage({context:owner,channelId:CHANNEL_ID,messageId:fixtureId('message',50000+n),authorPrincipalId:OWNER_ID,idempotencyKey:`outcome-latest-${n}`,kind:'text',text:`Latest correction ${n}: do not publish`,mentions:[],clientMessageId:null,replyToMessageId:null,tombstonesMessageId:null,provenance:{roundId:null,workId:null}});
  outcomes.enqueue('specialist:fixture',accepted.work.id,{status:'completed',result:'Untrusted worker evidence'});
  await service.processResidentOutcomes();const review=outcomes.pending()[0].reviewWorkId!;assert.ok(review);
  if (legacySnapshot) {
    await service.awaitSettlement(review).catch(() => undefined);
    const row=outcomes.forReview(review)!; const prepared=JSON.parse(row.prepared!);
    const original=await messages.getMessage!({context:owner,messageId:accepted.work.originMessageId!});
    prepared.historyBackfill.unshift({messageId:original.id,sequence:original.sequence,role:'user',text:original.text,createdAt:original.createdAt});
    outcomes.update(row,'prepared_json',JSON.stringify(prepared));
    await service.processResidentOutcomes();
  }
  await service.awaitSettlement(review);await service.processResidentOutcomes();
  assert.equal(residentAttachments,2);assert.match(instructions[1],/INTERNAL WORK OUTCOME/);
  assert.match(instructions[1],/preserve my changes/);assert.ok(JSON.stringify(histories[1]).includes(`Latest correction ${laterMessages-1}`));
  assert.equal(instructions[0], originalText);
  assert.ok(instructions[1].includes(JSON.stringify(originalText)));
  assert.equal(work.get(review)?.state,'succeeded');assert.equal(outcomes.pending().length,0);
  assert.equal(database.readOne<{n:number}>("SELECT count(*) AS n FROM messages WHERE work_id=? AND kind='result'",review)?.n,1);
  database.reopen();await service.processResidentOutcomes();assert.equal(residentAttachments,2);
  const recovered = await new SqliteDirectMessageContext(database, messages).recover(work.get(review)!);
  assert.match(recovered.prepared.instruction, /INTERNAL WORK OUTCOME/);
  assert.equal(recovered.prepared.originalOwnerRequest, originalText);
  assert.ok(JSON.stringify(recovered.prepared.historyBackfill).includes(`Latest correction ${laterMessages-1}`));
  const row = outcomes.forReview(review)!;
  const snapshot = JSON.parse(row.prepared!);
  const parent = work.get(review)!;
  const lease = database.readOne<{ id: string; fencingToken: number }>('SELECT id, fencing_token AS fencingToken FROM leases WHERE attempt_id = ?', parent.currentAttemptId)!;
  const child = work.create({ principalId: parent.principalId, targetPrincipalId: parent.targetPrincipalId,
    channelId: parent.channelId, originMessageId: parent.originMessageId, roundId: null,
    kind: 'resident_work_thread', idempotencyKey: 'review-child-recovery', maxAutomaticOffers: 1,
    requestId: fixtureId('request', 888), correlationId: fixtureId('correlation', 888), manifest: snapshot.manifest,
    plannedInvocation: { parentOrigin: { kind: 'coordination', workId: parent.id,
      attemptId: parent.currentAttemptId!, leaseId: lease.id, fencingToken: lease.fencingToken,
      holderPrincipalId: BOT_ID, holderInstanceId: 'resident-1', authorityReference: 'resident:jerry',
      channelId: CHANNEL_ID, originMessageId: parent.originMessageId, roundId: null },
      residentSlug: 'jerry', invocationId: 'recovery-child', toolName: 'coding_run', canonicalArgs: { prompt: 'Continue the existing repair' },
      executionInstruction: 'Continue the existing repair', title: 'Repair', summary: 'Repair', recoveryPolicy: 'safe_before_start' },
  }).work;
  const recoveredChild = await new SqliteDirectMessageContext(database, messages).recover(child);
  assert.match(recoveredChild.prepared.instruction, /INTERNAL WORK OUTCOME/);
  assert.equal(recoveredChild.prepared.originalOwnerRequest, originalText);
  assert.ok(JSON.stringify(recoveredChild.prepared.historyBackfill).includes(`Latest correction ${laterMessages-1}`));
  database.reopen();
  assert.equal((await new SqliteDirectMessageContext(database, messages).recover(work.get(child.id)!)).originMessageId, parent.originMessageId);
  snapshot.manifest.digests.context = 'tampered';
  outcomes.update(row, 'prepared_json', JSON.stringify(snapshot));
  await assert.rejects(new SqliteDirectMessageContext(database, messages).recover(work.get(review)!), /invalid_relation/);

});
