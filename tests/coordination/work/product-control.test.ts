import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";

import Database from "better-sqlite3";

import { createLeaseService } from "../../../src/coordination/leases/index.js";
import { COORDINATION_MIGRATIONS } from "../../../src/coordination/migrations/index.js";
import { PRODUCT_WORK_THREAD_KIND, createProductWorkControl, createWorkService, WorkError } from "../../../src/coordination/work/index.js";
import { createCanonicalOrphanRecovery } from "../../../src/work/foreground-detach.js";
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, M11TestDatabase, OWNER_ID, createFixtureIdGenerator, fixtureId, manifestInput } from "./test-fixture.js";

const context = (suffix: number, principalId = OWNER_ID) => ({ principalId, requestId: fixtureId("request", suffix), correlationId: fixtureId("correlation", suffix), identity: { kind: "owner" as const, auth: {} as any } });
const CONVERSATION_ID = fixtureId("conversation", 1);

// Mirrors the installed Apple contract's ConnectedAgentsWorkThread.displayState.
// It recognizes selected assignment states and otherwise falls back to state.
function appleDisplayState(work: {state:string;assignmentState?:string}): string {
  switch(work.assignmentState) {
    case 'complete': case 'cancelled': case 'blocked': case 'needs_review': return work.assignmentState;
    case 'active': return ['succeeded','failed','cancelled'].includes(work.state) ? 'following_up' : work.state;
    default: return work.state==='succeeded' ? 'returned' : work.state;
  }
}

function setup(start = 8000) {
  const database = M11TestDatabase.temporary();
  database.raw.prepare("INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)")
    .run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare("UPDATE bots SET conversation_id = ? WHERE id = ?")
    .run(CONVERSATION_ID, BOT_ID);
  const generateId = createFixtureIdGenerator(start);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const control = createProductWorkControl({ database, work, leases, now: () => new Date(AT) });
  const queued = work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null, kind: "resident_turn", idempotencyKey: `product-control-create-${start}`, manifest: manifestInput(), maxAutomaticOffers: 2, requestId: fixtureId("request", start), correlationId: fixtureId("correlation", start), turnSelection: { modelAlias: "sol", reasoningEffort: "xhigh" } }).work;
  return { database, generateId, work, leases, control, queued };
}

test("queued cancellation is durable, compact, and replay-safe across service restart", (t) => {
  const s = setup(); t.after(() => s.database.close());
  const first = s.control.cancel({ context: context(1), workId: s.queued.id, idempotencyKey: "cancel-product-0001" });
  assert.equal(first.outcome, "cancelled"); assert.equal(first.work.state, "cancelled"); assert.equal(first.replayed, false);
  s.database.reopen();
  const restarted = createProductWorkControl({ database: s.database, work: createWorkService({ database: s.database, generateId: s.generateId }), leases: createLeaseService({ database: s.database, generateId: s.generateId, leaseTtlMs: 60_000 }) });
  const replay = restarted.cancel({ context: context(2), workId: s.queued.id, idempotencyKey: "cancel-product-0001" });
  assert.equal(replay.replayed, true); assert.equal(s.database.readOne<{count:number}>("SELECT count(*) AS count FROM terminal_receipts WHERE work_id = ?", s.queued.id)?.count, 1);
});

test("running cancellation revokes the current fence and completes cancellation", (t) => {
  const s = setup(9000); t.after(() => s.database.close());
  const offer = s.leases.offer({ workId: s.queued.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", authorityReference: `resident:${BOT_ID}:resident-1`, automatic: true, requestId: fixtureId("request", 90), correlationId: fixtureId("correlation", 90) });
  const binding = { workId: s.queued.id, attemptId: offer.attempt.id, leaseId: offer.lease.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offer.fencingToken, requestId: fixtureId("request", 91), correlationId: fixtureId("correlation", 91) };
  s.leases.accept(binding); s.leases.start(binding);
  const stopped = s.control.cancel({ context: context(92), workId: s.queued.id, idempotencyKey: "cancel-running-0001" });
  assert.equal(stopped.outcome, "cancelled"); assert.equal(stopped.work.state, "cancelled");
  assert.equal(s.control.cancel({ context: context(93), workId: s.queued.id, idempotencyKey: "cancel-running-0001" }).replayed, true);
  assert.equal(s.database.readOne<{count:number}>("SELECT count(*) AS count FROM terminal_receipts WHERE work_id = ?", s.queued.id)?.count, 1);
  assert.equal(s.database.readOne<{state:string}>("SELECT state FROM attempts WHERE id = ?", binding.attemptId)?.state, "cancelled");
  assert.equal(s.database.readOne<{state:string}>("SELECT state FROM leases WHERE id = ?", binding.leaseId)?.state, "revoked");
});

test("restart recovery completes an already-revoked cancellation before retry", (t) => {
  const s = setup(9500); t.after(() => s.database.close());
  const offer = s.leases.offer({ workId: s.queued.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", authorityReference: `resident:${BOT_ID}:resident-1`, automatic: true, requestId: fixtureId("request", 95), correlationId: fixtureId("correlation", 95) });
  const binding = { workId: s.queued.id, attemptId: offer.attempt.id, leaseId: offer.lease.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offer.fencingToken, requestId: fixtureId("request", 96), correlationId: fixtureId("correlation", 96) };
  s.leases.accept(binding); s.leases.start(binding);
  s.leases.revoke({ ...binding, reasonCode: "product_cancelled" });
  s.database.reopen();

  const restartedWork = createWorkService({ database: s.database, generateId: s.generateId });
  const restartedLeases = createLeaseService({ database: s.database, generateId: s.generateId, leaseTtlMs: 60_000 });
  const restarted = createProductWorkControl({ database: s.database, work: restartedWork, leases: restartedLeases });
  assert.deepEqual(restarted.recoverCancellations({ requestId: fixtureId("request", 97), correlationId: fixtureId("correlation", 97) }), {
    discovered: 1,
    completed: 1,
  });
  const recovered = restarted.cancel({ context: context(97), workId: s.queued.id, idempotencyKey: "cancel-running-recovery-0001" });
  assert.equal(recovered.outcome, "cancelled");
  assert.equal(recovered.work.state, "cancelled");
  const retried = restarted.retry({ context: context(98), workId: s.queued.id, idempotencyKey: "retry-after-cancel-recovery-0001" });
  assert.equal(retried.outcome, "retried");
  assert.equal(retried.work.retryOfWorkId, s.queued.id);
  assert.equal(s.database.readOne<{count:number}>("SELECT count(*) AS count FROM terminal_receipts WHERE work_id = ?", s.queued.id)?.count, 1);
});

test("terminal retry creates one linked queued Work and rejects nonterminal or foreign scope", (t) => {
  const s = setup(10000); t.after(() => s.database.close());
  s.control.cancel({ context: context(100), workId: s.queued.id, idempotencyKey: "cancel-before-retry" });
  const retried = s.control.retry({ context: context(101), workId: s.queued.id, idempotencyKey: "retry-product-0001" });
  assert.equal(retried.outcome, "retried"); assert.equal(retried.work.state, "queued"); assert.equal(retried.work.retryOfWorkId, s.queued.id);
  assert.deepEqual(s.work.getTurnSelection(retried.work.id), { modelAlias: "sol", reasoningEffort: "xhigh" });
  const replay = s.control.retry({ context: context(102), workId: s.queued.id, idempotencyKey: "retry-product-0001" });
  assert.equal(replay.work.id, retried.work.id); assert.equal(replay.replayed, true);
  assert.throws(() => s.control.retry({ context: context(103), workId: retried.work.id, idempotencyKey: "retry-invalid-0001" }), (error: unknown) => error instanceof WorkError && error.code === "illegal_state");
  assert.throws(() => s.control.get({ context: context(104, BOT_ID), workId: s.queued.id }), (error: unknown) => error instanceof WorkError && error.code === "ineligible");
});

test("an expired Attempt is durably closed before retrying as new Work", (t) => {
  const s = setup(11000); t.after(() => s.database.close());
  const offer = s.leases.offer({ workId: s.queued.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", authorityReference: `resident:${BOT_ID}:resident-1`, automatic: true, requestId: fixtureId("request", 110), correlationId: fixtureId("correlation", 110) });
  const binding = { workId: s.queued.id, attemptId: offer.attempt.id, leaseId: offer.lease.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offer.fencingToken, requestId: fixtureId("request", 111), correlationId: fixtureId("correlation", 111) };
  s.leases.accept(binding); s.leases.expire({ ...binding, reasonCode: "positive_not_started" });
  assert.equal(s.control.get({ context: context(112), workId: s.queued.id }).retryAvailable, true);
  const retry = s.control.retry({ context: context(113), workId: s.queued.id, idempotencyKey: "retry-expired-0001" });
  assert.equal(retry.work.state, "queued"); assert.equal(s.work.get(s.queued.id)?.state, "cancelled");
});

test("Working Thread list is owner-scoped, excludes speaking turns, and projects multiple durable assignments", (t) => {
  const s = setup(12000); t.after(() => s.database.close());
  const createThread = (suffix: number) => s.work.create({
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: PRODUCT_WORK_THREAD_KIND,
    idempotencyKey: `working-thread-${suffix}`,
    manifest: manifestInput(),
    maxAutomaticOffers: 2,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
    presentation: { title: `Assignment ${suffix}`, summary: `Independent assignment ${suffix}` },
  }).work;
  const older = createThread(121);
  const newer = createThread(122);
  const offer = s.leases.offer({ workId: older.id, holderPrincipalId: BOT_ID,
    holderInstanceId: "resident-1", authorityReference: "resident:jerry", automatic: true,
    requestId: fixtureId("request", 128), correlationId: fixtureId("correlation", 128) });
  const binding = { workId: older.id, attemptId: offer.attempt.id, leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offer.fencingToken,
    requestId: fixtureId("request", 129), correlationId: fixtureId("correlation", 129) };
  s.leases.accept(binding); s.leases.start(binding);
  s.leases.terminalize({ ...binding, receipt: { status: "succeeded", sourceReference: "resident:jerry",
    resultDigest: createHash("sha256").update("Finished safely.").digest("hex"), artifactIds: [], timestamp: AT } });
  const listed = s.control.list({ context: context(123), limit: 50 });
  assert.deepEqual(listed.works.map((work) => work.id), [newer.id, older.id]);
  assert.equal(listed.nextCursor, null);
  const firstPage = s.control.list({ context: context(123), limit: 1 });
  assert.equal(firstPage.nextCursor, 'work-offset:1');
  const secondPage = s.control.list({ context: context(123), limit: 1, cursor: firstPage.nextCursor! });
  assert.deepEqual([...firstPage.works, ...secondPage.works].map(w => w.id), [newer.id, older.id]);
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual(s.control.list({ context: context(125, BOT_ID), cursor: firstPage.nextCursor! }).works, []);
  assert.throws(() => s.control.list({ context: context(123), cursor: 'work-offset:-1' }), WorkError);
  assert.equal(listed.works.some((work) => work.id === s.queued.id), false,
    "ordinary resident speaking Work must not appear as a Working Thread");
  assert.deepEqual(listed.works[1], {
    id: older.id,
    channelId: CHANNEL_ID,
    conversationId: CONVERSATION_ID,
    originMessageId: MESSAGE_ID,
    accountableResident: {
      principalId: BOT_ID,
      residentBinding: "jerry",
      displayName: "Jerry",
    },
    kind: PRODUCT_WORK_THREAD_KIND,
    title: "Assignment 121",
    summary: "Independent assignment 121",
    state: "succeeded",
    assignmentState: "complete",
    assignmentSummary: null,
    cancelAvailable: false,
    retryAvailable: false,
    createdAt: AT,
    updatedAt: AT,
    terminalAt: AT,
    retryOfWorkId: null,
    retriedByWorkIds: [],
    finalResultMessageId: null,
  });
  assert.deepEqual(
    s.control.list({ context: context(124), conversationId: CONVERSATION_ID, limit: 1 }).works.map((work) => work.id),
    [newer.id],
  );
  assert.deepEqual(s.control.list({ context: context(125, BOT_ID) }).works, []);
  const cancelled = s.control.cancel({ context: context(126), workId: newer.id, idempotencyKey: "visible-cancel" });
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.work.state, "cancelled");
  assert.throws(
    () => s.control.retry({ context: context(127), workId: newer.id, idempotencyKey: "unsupported-visible-retry" }),
    (error: unknown) => error instanceof WorkError && error.code === "illegal_state",
  );
});

test("Working Thread Stop stays stopping until the resident or restart recovery acknowledges cancellation", (t) => {
  const s = setup(13000); t.after(() => s.database.close());
  const thread = s.work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null,
    kind: PRODUCT_WORK_THREAD_KIND, idempotencyKey: "working-thread-stop-130",
    manifest: manifestInput(), maxAutomaticOffers: 2,
    requestId: fixtureId("request", 130), correlationId: fixtureId("correlation", 130),
    presentation: { title: "Long validation", summary: "Run the long validation" } }).work;
  const offer = s.leases.offer({ workId: thread.id, holderPrincipalId: BOT_ID,
    holderInstanceId: "resident-1", authorityReference: "resident:jerry", automatic: true,
    requestId: fixtureId("request", 131), correlationId: fixtureId("correlation", 131) });
  const binding = { workId: thread.id, attemptId: offer.attempt.id, leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offer.fencingToken,
    requestId: fixtureId("request", 132), correlationId: fixtureId("correlation", 132) };
  s.leases.accept(binding); s.leases.start(binding);

  const stopped = s.control.cancel({ context: context(133), workId: thread.id, idempotencyKey: "stop-thread-130" });
  assert.equal(stopped.outcome, "cancellation_requested");
  assert.equal(stopped.work.state, "stopping");
  assert.equal(s.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM terminal_receipts WHERE work_id = ?", thread.id,
  )?.count, 0, "Core must not claim the resident stopped before it acknowledges");
  assert.deepEqual(s.control.recoverCancellations({
    requestId: fixtureId("request", 134), correlationId: fixtureId("correlation", 134),
  }), { discovered: 0, completed: 0 });

  const recover = createCanonicalOrphanRecovery({
    database: s.database as never, work: s.work, leases: s.leases, now: () => new Date(AT),
  });
  assert.equal(recover(thread.id), "cancelled");
  assert.equal(s.control.get({ context: context(135), workId: thread.id }).state, "cancelled");
});

test("dispatch crash recovery records failure from queued, offered, accepted, and running boundaries", (t) => {
  const s = setup(14000); t.after(() => s.database.close());
  const recover = createCanonicalOrphanRecovery({
    database: s.database as never, work: s.work, leases: s.leases, now: () => new Date(AT),
  });
  const make = (suffix: number) => s.work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null,
    kind: PRODUCT_WORK_THREAD_KIND, idempotencyKey: `orphan-thread-${suffix}`,
    manifest: manifestInput(), maxAutomaticOffers: 2,
    requestId: fixtureId("request", suffix), correlationId: fixtureId("correlation", suffix),
    presentation: { title: `Orphan ${suffix}`, summary: `Orphan assignment ${suffix}` } }).work;
  const transition = (workId: string, suffix: number, state: "offered" | "accepted" | "running") => {
    const offer = s.leases.offer({ workId, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1",
      authorityReference: "resident:jerry", automatic: true,
      requestId: fixtureId("request", suffix), correlationId: fixtureId("correlation", suffix) });
    const binding = { workId, attemptId: offer.attempt.id, leaseId: offer.lease.id,
      holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offer.fencingToken,
      requestId: fixtureId("request", suffix + 1), correlationId: fixtureId("correlation", suffix + 1) };
    if (state !== "offered") s.leases.accept(binding);
    if (state === "running") s.leases.start(binding);
  };
  const queued = make(141); const offered = make(142); const accepted = make(143); const running = make(144);
  transition(offered.id, 145, "offered");
  transition(accepted.id, 147, "accepted");
  transition(running.id, 149, "running");
  for (const work of [queued, offered, accepted, running]) {
    assert.equal(recover(work.id), "failed");
    assert.equal(s.work.get(work.id)?.state, "failed");
  }
});

test('the channel owner can see and stop Jerry-initiated joined Work without a false terminal receipt',t=>{
  const s=setup(88000);t.after(()=>s.database.close());
  const child=s.work.create({principalId:BOT_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null,
    kind:'channel.bot_turn',idempotencyKey:'jerry-scheduled-channel-run',manifest:manifestInput(),maxAutomaticOffers:2,
    requestId:fixtureId('request',88001),correlationId:fixtureId('correlation',88001),presentation:{title:'Scheduled run',summary:'Editorial work'}}).work;
  assert.equal(s.control.list({context:context(88002)}).works.find(w=>w.id===child.id)?.kind,PRODUCT_WORK_THREAD_KIND);
  assert.equal(s.work.get(child.id)!.kind,'channel.bot_turn','canonical Round lineage remains unchanged');
  const offered=s.leases.offer({workId:child.id,holderPrincipalId:BOT_ID,holderInstanceId:'resident-1',authorityReference:'resident:jerry',automatic:true,
    requestId:fixtureId('request',88003),correlationId:fixtureId('correlation',88003)});
  const binding={workId:child.id,attemptId:offered.attempt.id,leaseId:offered.lease.id,holderPrincipalId:BOT_ID,holderInstanceId:'resident-1',fencingToken:offered.fencingToken,
    requestId:fixtureId('request',88004),correlationId:fixtureId('correlation',88004)};
  s.leases.accept(binding);s.leases.start(binding);
  assert.equal(s.control.cancel({context:context(88005),workId:child.id,idempotencyKey:'stop-scheduled-run'}).outcome,'cancellation_requested');
  s.control.recoverCancellations({requestId:fixtureId('request',88006),correlationId:fixtureId('correlation',88006)});
  assert.equal(s.work.get(child.id)!.state,'cancelling','generic recovery must not manufacture a stopped receipt for joined execution');
});

for (const execution of ['succeeded', 'failed', 'cancelled'] as const) {
  for (const conclusion of ['active', 'blocked', 'complete', 'cancelled'] as const) {
    test(`terminal scheduled ${execution} with ${conclusion} assessment has a terminal iOS card`, t => {
      const s = setup(89000); t.after(() => s.database.close());
      const child = s.work.create({ principalId: BOT_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
        originMessageId: MESSAGE_ID, roundId: null, kind: 'channel.bot_turn', idempotencyKey: 'scheduled-terminal-card',
        manifest: manifestInput(), maxAutomaticOffers: 1, requestId: fixtureId('request',89001), correlationId: fixtureId('correlation',89001),
        presentation: { title: 'Scheduled channel run', summary: 'Run the cycle' } }).work;
      s.database.mutateWithEvent(() => ({value:undefined,event:{type:'activity.updated',aggregateKind:'scheduled_channel_run',
        aggregateId:'sched-run-0198d95f-6c00-7000-8000-000000089000',aggregateVersion:1,channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,
        requestId:fixtureId('request',89002),correlationId:fixtureId('correlation',89002),
        payload:{messageId:MESSAGE_ID,channelId:CHANNEL_ID,botId:BOT_ID},createdAt:AT}}));
      s.database.mutateWithEvent(() => ({value:undefined,event:{type:'activity.updated',aggregateKind:'resident_assignment',
        aggregateId:child.id,aggregateVersion:1,channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,
        requestId:fixtureId('request',89003),correlationId:fixtureId('correlation',89003),
        payload:{workId:child.id,state:conclusion,summary:'Project guard remains enabled',evidence:[],waitFor:[],revisitAt:null},createdAt:AT}}));
      if (execution === 'cancelled') {
        s.work.cancelQueued({workId:child.id,actorPrincipalId:BOT_ID,reasonCode:'fixture_stop',sourceReference:'fixture:stop',timestamp:AT,
          requestId:fixtureId('request',89006),correlationId:fixtureId('correlation',89006)});
      } else {
        const offered=s.leases.offer({workId:child.id,holderPrincipalId:BOT_ID,holderInstanceId:'resident-1',authorityReference:'resident:jerry',automatic:true,
          requestId:fixtureId('request',89006),correlationId:fixtureId('correlation',89006)});
        const binding={workId:child.id,attemptId:offered.attempt.id,leaseId:offered.lease.id,holderPrincipalId:BOT_ID,holderInstanceId:'resident-1',fencingToken:offered.fencingToken,
          requestId:fixtureId('request',89007),correlationId:fixtureId('correlation',89007)};
        s.leases.accept(binding);s.leases.start(binding);
        s.leases.terminalize({...binding,receipt:{status:execution,sourceReference:'resident:jerry',resultDigest:'a'.repeat(64),artifactIds:[],timestamp:AT}});
      }
      const expected = execution !== 'succeeded' ? execution : conclusion === 'blocked' ? 'failed'
        : conclusion === 'cancelled' ? 'cancelled' : conclusion === 'complete' ? 'complete' : 'returned';
      const shown = s.control.get({context:context(89004),workId:child.id});
      assert.equal(shown.assignmentState, expected);
      assert.equal(appleDisplayState(shown),expected,'current iOS contract must display the terminal task outcome');
      assert.equal(shown.executionState,execution);
      assert.equal(s.work.get(child.id)!.state,execution,'presentation must preserve canonical execution history');
      assert.equal(shown.assignmentSummary,'Project guard remains enabled');
      assert.deepEqual(s.control.list({context:context(89005)}).works.find(row=>row.id===child.id),shown);
    });
  }
}

test('scheduled card semantics require the exact admission channel, author, target, and message', t => {
  const s=setup(89500);t.after(()=>s.database.close());
  const child=s.work.create({principalId:BOT_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:MESSAGE_ID,roundId:null,
    kind:'channel.bot_turn',idempotencyKey:'unrelated-schedule-admission',manifest:manifestInput(),maxAutomaticOffers:1,
    requestId:fixtureId('request',89501),correlationId:fixtureId('correlation',89501),presentation:{title:'Normal assignment',summary:'Wait for a dependency'}}).work;
  s.work.cancelQueued({workId:child.id,actorPrincipalId:BOT_ID,reasonCode:'fixture_stop',sourceReference:'fixture:stop',timestamp:AT,
    requestId:fixtureId('request',89502),correlationId:fixtureId('correlation',89502)});
  s.database.mutateWithEvent(()=>({value:undefined,event:{type:'activity.updated',aggregateKind:'resident_assignment',aggregateId:child.id,
    aggregateVersion:1,channelId:CHANNEL_ID,actorPrincipalId:BOT_ID,requestId:fixtureId('request',89503),correlationId:fixtureId('correlation',89503),
    payload:{workId:child.id,state:'blocked',summary:'Wait for a dependency',evidence:[],waitFor:[],revisitAt:null},createdAt:AT}}));
  for(const [index,variant] of ['channel','author','target','payloadChannel','payloadAuthor','message','nullMessage','nonStringMessage'].entries()) {
    s.database.mutateWithEvent(()=>({value:undefined,event:{type:'activity.updated',aggregateKind:'scheduled_channel_run',aggregateId:`unrelated-schedule-${index}`,
      aggregateVersion:1,channelId:variant==='channel'?fixtureId('channel',89504):CHANNEL_ID,
      actorPrincipalId:variant==='author'?fixtureId('bot',89504):BOT_ID,
      requestId:fixtureId('request',89504+index),correlationId:fixtureId('correlation',89504+index),
      payload:{messageId:variant==='message'?fixtureId('message',89504):variant==='nullMessage'?null:variant==='nonStringMessage'?{id:MESSAGE_ID}:MESSAGE_ID,
        channelId:variant==='payloadChannel'?fixtureId('channel',89504):CHANNEL_ID,
        botId:variant==='payloadAuthor'?fixtureId('bot',89504):BOT_ID,
        ...(variant==='target'?{targetBotId:fixtureId('bot',89504)}:{})},createdAt:AT}}));
    assert.equal(s.control.get({context:context(89508),workId:child.id}).assignmentState,'blocked',variant);
  }
});

test("scheduled provenance builds one indexed admission set for single and page projections on schema v21", (t) => {
  const s = setup(89600); t.after(() => s.database.close());
  const children = Array.from({ length: 100 }, (_, index) => s.work.create({
    principalId: BOT_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID, originMessageId: MESSAGE_ID,
    roundId: null, kind: 'channel.bot_turn', idempotencyKey: `scheduled-plan-${index}`,
    manifest: manifestInput(), maxAutomaticOffers: 1,
    requestId: fixtureId('request', 89600 + index), correlationId: fixtureId('correlation', 89600 + index),
    presentation: { title: 'Scheduled run', summary: 'One bounded execution' },
  }).work);
  type Parameters = Array<string | number | bigint | Buffer | null>;
  const statements: Array<{ sql: string; parameters: Parameters }> = [];
  const readOne = s.database.readOne.bind(s.database);
  const readAll = s.database.readAll.bind(s.database);
  s.database.readOne = ((sql: string, ...parameters: Parameters) => {
    if (sql.includes(' AS scheduledRun')) statements.push({ sql, parameters });
    return readOne(sql, ...parameters);
  }) as typeof s.database.readOne;
  s.database.readAll = ((sql: string, ...parameters: Parameters) => {
    if (sql.includes(' AS scheduledRun')) statements.push({ sql, parameters });
    return readAll(sql, ...parameters);
  }) as typeof s.database.readAll;
  s.control.get({ context: context(89700), workId: children[0].id });
  assert.equal(s.control.list({ context: context(89701), limit: 100 }).works.length, 100);
  assert.equal(statements.length, 2, 'exercise the actual production single and page SQL');

  const database = new Database(':memory:'); t.after(() => database.close());
  // Keep exercising the legacy schema even when the product adds migrations.
  const legacyMigrations = COORDINATION_MIGRATIONS.filter(migration => migration.version <= 21);
  assert.equal(legacyMigrations.at(-1)?.version, 21);
  for (const migration of legacyMigrations) database.exec(migration.sql);
  assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE name='events_scheduled_origin_message'").get(), undefined);
  // Copy only the parents and rows needed by the real presentation queries.
  // The target database uses every existing migration, including v21's triggers.
  for (const table of ['principals', 'channels', 'conversation_handles', 'bots', 'channel_members',
    'messages', 'events', 'context_manifests', 'works', 'work_thread_presentations']) {
    const rows = s.database.raw.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, string | number | bigint | Buffer | null>>;
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    const insert = database.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    for (const row of rows) insert.run(...columns.map(column => row[column]));
  }
  const insertEvent = database.prepare(`INSERT INTO events
    (id,schema_version,type,durability,aggregate_kind,aggregate_id,aggregate_version,channel_id,actor_principal_id,
      request_id,correlation_id,payload_json,payload_digest,created_at)
    VALUES (?,1,'activity.updated','durable',?,?,1,?,?,?,?,?,?,?)`);
  const scheduledCount = 1024;
  const unrelatedCount = 4096;
  database.transaction(() => {
    for (let index = 0; index <= scheduledCount + unrelatedCount; index++) {
      const scheduled = index <= scheduledCount;
      const payload = JSON.stringify({ messageId: index === scheduledCount ? MESSAGE_ID : fixtureId('message', 100000 + index),
        channelId: CHANNEL_ID, botId: BOT_ID, targetBotId: index === scheduledCount ? null : BOT_ID });
      insertEvent.run(fixtureId('event', 100000 + index), scheduled ? 'scheduled_channel_run' : 'unrelated_activity',
        `sched-run-${String(index).padStart(8, '0')}`, CHANNEL_ID, BOT_ID,
        fixtureId('request', 100000 + index), fixtureId('correlation', 100000 + index),
        payload, createHash('sha256').update(payload).digest('hex'), AT);
    }
  })();
  database.exec('ANALYZE');

  for (const [index, statement] of statements.entries()) {
    const label = index === 0 ? 'single' : 'page';
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.parameters) as Array<{ id: number; parent: number; detail: string }>;
    const eventSeek = plan.find(row => /SEARCH (?:events|scheduled) USING INDEX sqlite_autoindex_events_2 \(aggregate_kind=\?\)/.test(row.detail));
    assert.ok(eventSeek, `${label}: use the existing event aggregate index`);
    let parent = plan.find(row => row.id === eventSeek.parent);
    assert.ok(parent?.detail.startsWith('LIST SUBQUERY'), `${label}: admission history must be an uncorrelated set, not a range scan per Work`);
    while (parent) {
      assert.doesNotMatch(parent.detail, /CORRELATED/);
      parent = plan.find(row => row.id === parent?.parent);
    }
    assert.ok(!plan.some(row => /SCAN (?:events|scheduled)\b/.test(row.detail)), `${label}: no event table scan`);
    const bytecode = database.prepare(`EXPLAIN ${statement.sql}`).all(...statement.parameters) as Array<{
      addr: number; opcode: string; p1: number; p2: number; p4: string | null;
    }>;
    const membership = bytecode.find(row => row.opcode === 'OpenEphemeral' && row.p2 === 4 && row.p4?.startsWith('k(4,'));
    assert.ok(membership, `${label}: materialize the four provenance keys`);
    assert.ok(bytecode.some(row => row.opcode === 'Once' && row.addr < membership.addr && row.p2 > membership.addr),
      `${label}: build the set once per statement`);
    assert.ok(bytecode.some(row => row.opcode === 'NotFound' && row.p1 === membership.p1 && row.p4 === '4'),
      `${label}: probe the tuple index without a NULL-detection scan`);
    const rows = database.prepare(statement.sql).all(...statement.parameters) as Array<{ scheduledRun: number }>;
    assert.equal(rows.length, index === 0 ? 1 : 100);
    assert.ok(rows.every(row => row.scheduledRun === 1), `${label}: targetBotId:null retains the botId fallback`);
    t.diagnostic(`${label} admission plan: ${eventSeek.detail}; uncorrelated LIST SUBQUERY; Once + four-key NotFound`);
  }
  const page = database.prepare(statements[1].sql);
  const start = performance.now();
  for (let iteration = 0; iteration < 10; iteration++) page.all(...statements[1].parameters);
  t.diagnostic(`Populated 100-Work page, ${scheduledCount + 1} admissions and ${unrelatedCount} unrelated events: ` +
    `${((performance.now() - start) / 10).toFixed(2)} ms/query across 10 runs (observation only)`);
});

test("Working Thread list projects a whole page with constant base queries and matches single-item projection", (t) => {
  const s = setup(15000); t.after(() => s.database.close());
  const threads = Array.from({ length: 7 }, (_, index) => s.work.create({
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: PRODUCT_WORK_THREAD_KIND,
    idempotencyKey: `batched-working-thread-${index}`,
    manifest: manifestInput(),
    maxAutomaticOffers: 2,
    requestId: fixtureId("request", 150 + index),
    correlationId: fixtureId("correlation", 150 + index),
    presentation: { title: `Batched ${index}`, summary: `Batched assignment ${index}` },
  }).work);
  const later = new Date(Date.parse(AT) + 60_000).toISOString();
  const insertRetry = s.database.raw.prepare(
    "INSERT INTO work_retry_provenance (source_work_id, retry_work_id, created_at) VALUES (?, ?, ?)",
  );
  insertRetry.run(threads[0].id, threads[2].id, later);
  insertRetry.run(threads[0].id, threads[1].id, AT);
  insertRetry.run(threads[3].id, threads[4].id, AT);
  s.control.cancel({ context: context(160), workId: threads[5].id, idempotencyKey: "batched-cancel" });

  const statements: string[] = [];
  const readOne = s.database.readOne.bind(s.database);
  const readAll = s.database.readAll.bind(s.database);
  s.database.readOne = ((sql: string, ...parameters: never[]) => { statements.push(sql); return readOne(sql, ...parameters); }) as typeof s.database.readOne;
  s.database.readAll = ((sql: string, ...parameters: never[]) => { statements.push(sql); return readAll(sql, ...parameters); }) as typeof s.database.readAll;
  const count = (pattern: RegExp) => statements.filter((sql) => pattern.test(sql)).length;
  const baseQueries = (limit: number) => {
    statements.length = 0;
    const page = s.control.list({ context: context(161), limit });
    return {
      page,
      presentations: count(/JOIN conversation_handles h ON h\.channel_id = w\.channel_id\s+JOIN bots bot/),
      workRows: count(/FROM works\s+WHERE id (=|IN)/),
      retries: count(/FROM work_retry_provenance/),
      outcomeStoreProbes: count(/sqlite_master/),
    };
  };

  const small = baseQueries(2);
  const large = baseQueries(100);
  assert.equal(small.page.works.length, 2);
  assert.equal(large.page.works.length, 7);
  for (const run of [small, large]) {
    assert.equal(run.presentations, 1, "one presentation query per page");
    assert.equal(run.workRows, 1, "one Work row query per page");
    assert.equal(run.retries, 2, "one retry-source and one retried-by query per page");
    assert.equal(run.outcomeStoreProbes, 1, "one resident assignment reader per page");
  }

  s.database.readOne = readOne;
  s.database.readAll = readAll;
  const single = large.page.works.map((work) => s.control.get({ context: context(162), workId: work.id }));
  assert.equal(JSON.stringify(large.page.works), JSON.stringify(single), "batched list is byte-identical to single projection");
  assert.ok(large.page.works.every((work) => Object.isFrozen(work) && Object.isFrozen(work.accountableResident) && Object.isFrozen(work.retriedByWorkIds)));
  const byId = new Map(large.page.works.map((work) => [work.id, work]));
  assert.deepEqual(byId.get(threads[0].id)?.retriedByWorkIds, [threads[1].id, threads[2].id]);
  assert.equal(byId.get(threads[4].id)?.retryOfWorkId, threads[3].id);
  assert.equal(byId.get(threads[5].id)?.state, "cancelled");

  const paged: string[] = [];
  let cursor: string | undefined;
  do {
    const page = s.control.list({ context: context(163), limit: 3, ...(cursor ? { cursor } : {}) });
    paged.push(...page.works.map((work) => JSON.stringify(work)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(paged, large.page.works.map((work) => JSON.stringify(work)));
});
