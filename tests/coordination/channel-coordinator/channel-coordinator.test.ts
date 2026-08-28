import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { assertChannelTurnCapacity, createChannelCoordinator, ChannelCoordinatorError } from "../../../src/coordination/channel-coordinator/index.js";
import { createLeaseService, LeaseError } from "../../../src/coordination/leases/index.js";
import { createRoundService } from "../../../src/coordination/rounds/index.js";
import { createWorkService } from "../../../src/coordination/work/index.js";
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  MESSAGE_ID,
  M11TestDatabase,
  OWNER_ID,
  createFixtureIdGenerator,
  fixtureId,
  manifestInput,
} from "../work/test-fixture.js";

const BOT_2 = fixtureId("bot", 2);
const DEADLINE = "2026-08-25T16:10:00.000Z";

function prepare(database: M11TestDatabase): void {
  database.raw.prepare(
    "INSERT INTO authority_epochs VALUES ('messages', 1, 'canonical', 'home23-coordination', 1, NULL, '{}', ?)",
  ).run(AT);
  database.raw.prepare(
    `UPDATE channels SET kind = 'group', responder_mode = 'mention_or_coordinator',
       coordinator_bot_id = ?, max_bot_turns = 4 WHERE id = ?`,
  ).run(BOT_ID, CHANNEL_ID);
  database.raw.prepare("INSERT INTO principals (id, kind, created_at) VALUES (?, 'bot', ?)").run(BOT_2, AT);
  database.raw.prepare(
    `INSERT INTO bots (
      id, principal_id, name, purpose, lifecycle, conversation_id, resident_binding,
      continuing_identity, durable_mailbox, required_capabilities_json,
      active_instance_id, active_key_version, resident_protocol_version,
      resident_capabilities_json, resident_registered_at, last_heartbeat_at,
      reported_availability, version, created_at, updated_at
    ) VALUES (?, ?, 'Ada', 'Persistent resident', 'active', NULL, 'ada', 1, 1,
              '["messages"]', 'resident-2', 1, 1, '["messages"]', ?, ?,
              'available', 1, ?, ?)`,
  ).run(BOT_2, BOT_2, AT, AT, AT, AT);
  database.raw.prepare(
    `INSERT INTO channel_members VALUES (?, ?, 'bot', 'member', 1, ?, NULL)`,
  ).run(CHANNEL_ID, BOT_2, AT);
}

function harness(database: M11TestDatabase, clock: { value: Date }, start = 10_000) {
  const generateId = createFixtureIdGenerator(start);
  const work = createWorkService({ database, generateId, now: () => clock.value });
  const rounds = createRoundService({ database, generateId, now: () => clock.value });
  const leases = createLeaseService({ database, generateId, now: () => clock.value, leaseTtlMs: 60_000 });
  const coordinator = createChannelCoordinator({
    database,
    rounds,
    work,
    enabled: true,
    expectedAuthorityWriter: "home23-coordination",
    now: () => clock.value,
  });
  return { coordinator, work, rounds, leases };
}

function trigger(overrides: Record<string, unknown> = {}) {
  const mentionedBotIds = (overrides.mentionedBotIds as readonly string[] | undefined) ??
    [BOT_2, BOT_ID];
  const plannedBotIds = (overrides.plannedBotIds as readonly string[] | undefined) ??
    [...mentionedBotIds].sort();
  const eventId = (overrides.eventId as string | undefined) ?? fixtureId("event", 1);
  const messageId = (overrides.messageId as string | undefined) ?? MESSAGE_ID;
  const manifest = (overrides.manifest as ReturnType<typeof manifestInput> | undefined) ??
    manifestInput({ messageIds: [messageId] });
  const turnSelection = (overrides.turnSelection as {
    modelAlias: string | null;
    reasoningEffort: null;
  } | undefined) ?? { modelAlias: null, reasoningEffort: null };
  const targets = plannedBotIds.map((botId) => ({
    targetBotId: botId,
    targetBotDisplayName: botId === BOT_ID ? "Jerry" : "Ada",
    targetPrincipalId: botId,
    residentBinding: botId === BOT_ID ? "jerry" : "ada",
  }));
  return {
    eventId,
    messageId,
    channelId: CHANNEL_ID,
    actorPrincipalId: OWNER_ID,
    selection: "mentions" as const,
    mentionedBotIds,
    plannedBotIds,
    admissionPlan: {
      version: 1 as const,
      channelId: CHANNEL_ID,
      conversationId: "cnv_0198d95f-6c00-7000-8000-000000000001",
      originMessageId: messageId,
      originEventId: eventId,
      actorPrincipalId: OWNER_ID,
      visibleParticipantIds: [BOT_ID, BOT_2],
      selectedTargets: targets,
      responseOrder: "parallel" as const,
      standingReference: "policy:channel-owner",
      manifest,
      turnSelection,
    },
    visibleParticipantIds: [BOT_ID, BOT_2],
    standing: {
      source: "trusted_policy_boundary" as const,
      reference: "policy:channel-owner",
      channelId: CHANNEL_ID,
      allowedParticipantIds: [BOT_ID, BOT_2],
      broadcastAllowed: true,
    },
    authority: { capability: "messages" as const, mode: "canonical" as const, epoch: 1, writer: "home23-coordination" },
    deadlineAt: DEADLINE,
    manifest,
    turnSelection,
    requestId: fixtureId("request", 800),
    correlationId: fixtureId("correlation", 800),
    ...overrides,
  };
}

function terminalize(
  services: ReturnType<typeof harness>,
  workId: string,
  botId: string,
  status: "succeeded" | "failed",
  suffix: number,
): void {
  const offered = services.leases.offer({
    workId, holderPrincipalId: botId, holderInstanceId: `resident-${suffix}`,
    authorityReference: `resident:turn-${suffix}`, automatic: true,
    requestId: fixtureId("request", suffix), correlationId: fixtureId("correlation", suffix),
  });
  const binding = {
    workId, attemptId: offered.attempt.id, leaseId: offered.lease.id,
    holderPrincipalId: botId, holderInstanceId: `resident-${suffix}`,
    fencingToken: offered.fencingToken,
    requestId: fixtureId("request", suffix + 20), correlationId: fixtureId("correlation", suffix + 20),
  };
  services.leases.accept(binding);
  services.leases.start(binding);
  services.leases.terminalize({
    ...binding,
    receipt: {
      status, sourceReference: `resident:turn-${suffix}`,
      resultDigest: String(suffix % 10).repeat(64), artifactIds: [], timestamp: AT,
    },
  });
}

function appendOwnerMessage(database: M11TestDatabase, messageId: string, sequence: number, eventSuffix: number): void {
  database.raw.prepare(
    `INSERT INTO messages VALUES (?, ?, ?, ?, 'owner', 'Owner', 'text', 'next', 'visible', NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(messageId, CHANNEL_ID, sequence, OWNER_ID, AT);
  database.raw.prepare(
    `INSERT INTO events (
      id, schema_version, type, durability, aggregate_kind, aggregate_id,
      aggregate_version, channel_id, actor_principal_id, request_id,
      correlation_id, payload_json, payload_digest, created_at
    ) VALUES (?, 1, 'message.appended', 'durable', 'message', ?, 1, ?, ?, ?, ?, '{}', ?, ?)`,
  ).run(
    fixtureId("event", eventSuffix), messageId, CHANNEL_ID, OWNER_ID,
    fixtureId("request", eventSuffix), fixtureId("correlation", eventSuffix),
    createHash("sha256").update("{}").digest("hex"), AT,
  );
}

test("capability defaults off and recipient selection is sorted, visible, scoped, and persistent only", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database);
    const clock = { value: new Date(AT) };
    const live = harness(database, clock);
    const off = createChannelCoordinator({
      database, rounds: live.rounds, work: live.work, expectedAuthorityWriter: "home23-coordination",
    });
    assert.throws(() => off.start(trigger()), (error: unknown) => error instanceof ChannelCoordinatorError && error.code === "capability_off");

    const dispatch = live.coordinator.start(trigger({
      mentionedBotIds: [BOT_2, fixtureId("bot", 99), BOT_ID],
      plannedBotIds: [BOT_2],
      visibleParticipantIds: [BOT_ID, BOT_2],
      standing: { ...trigger().standing, allowedParticipantIds: [BOT_2] },
    }));
    assert.deepEqual(dispatch.recipients, [BOT_2]);
    assert.equal(dispatch.works[0]?.work.targetPrincipalId, BOT_2);
    assert.equal(dispatch.works[0]?.work.maxAutomaticOffers, 2, "one initial offer plus one retry");
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM channel_members")?.count, 3);
    assert.equal(dispatch.provenance.standingReference, "policy:channel-owner");
    assert.deepEqual(dispatch.activityFacts.map((fact) => fact.workId), dispatch.works.map((entry) => entry.work.id));
    assert.equal("instruction" in dispatch.activityFacts[0]!, false, "Activity facts remain content-free");
  } finally { database.close(); }
});

test("mentions-only Channels use the first selected Bot only as Round lifecycle coordinator", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database);
    database.raw.prepare(
      `UPDATE channels SET responder_mode = 'mentions_only', coordinator_bot_id = NULL
       WHERE id = ?`,
    ).run(CHANNEL_ID);
    const services = harness(database, { value: new Date(AT) }, 15_000);
    const dispatch = services.coordinator.start(trigger({ mentionedBotIds: [BOT_2] }));

    assert.deepEqual(dispatch.recipients, [BOT_2]);
    assert.equal(dispatch.round.coordinatorBotId, BOT_2);
    assert.equal(dispatch.works.length, 1);
    assert.equal(dispatch.works[0]?.work.targetPrincipalId, BOT_2);
    assert.deepEqual(
      database.readOne<{ responderMode: string; coordinatorBotId: string | null }>(
        `SELECT responder_mode AS responderMode,
                coordinator_bot_id AS coordinatorBotId
         FROM channels WHERE id = ?`,
        CHANNEL_ID,
      ),
      { responderMode: "mentions_only", coordinatorBotId: null },
      "Round coordination must not rewrite the stored responder policy",
    );
  } finally { database.close(); }
});

test("capacity is exactly four turns per Bot and twelve per Round", () => {
  assert.doesNotThrow(() => assertChannelTurnCapacity({ roundTurns: 11, botTurns: 3 }));
  assert.throws(
    () => assertChannelTurnCapacity({ roundTurns: 11, botTurns: 4 }),
    (error: unknown) => error instanceof ChannelCoordinatorError && error.code === "turn_limit",
  );
  assert.throws(
    () => assertChannelTurnCapacity({ roundTurns: 12, botTurns: 0 }),
    (error: unknown) => error instanceof ChannelCoordinatorError && error.code === "round_limit",
  );
});

test("configured maxBotTurns bounds durable Work count rather than only pass count", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database);
    database.raw.prepare("UPDATE channels SET max_bot_turns = 1 WHERE id = ?").run(CHANNEL_ID);
    const services = harness(database, { value: new Date(AT) }, 18_000);
    assert.throws(
      () => services.coordinator.start(trigger({
        mentionedBotIds: [BOT_ID],
        plannedBotIds: [BOT_ID, BOT_2],
      })),
      (error: unknown) => error instanceof ChannelCoordinatorError && error.code === "round_limit",
    );
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM rounds")?.count, 0);
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 0);

    database.raw.prepare("UPDATE channels SET max_bot_turns = 2 WHERE id = ?").run(CHANNEL_ID);
    const first = services.coordinator.start(trigger({
      mentionedBotIds: [BOT_ID],
      plannedBotIds: [BOT_ID, BOT_2],
    }));
    const second = services.coordinator.start(trigger({
      mentionedBotIds: [BOT_2],
      plannedBotIds: [BOT_ID, BOT_2],
    }));
    assert.equal(second.round.id, first.round.id);
    assert.equal(first.round.passCount, 1);
    assert.equal(second.round.passCount, 1);
    assert.equal(database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM works WHERE round_id = ?",
      first.round.id,
    )?.count, 2);
  } finally { database.close(); }
});

test("duplicate trigger and restart recover the same Round, Work, and single wake intent", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database);
    const clock = { value: new Date(AT) };
    let services = harness(database, clock, 20_000);
    const first = services.coordinator.start(trigger());
    assert.deepEqual(first.recipients, [BOT_ID, BOT_2]);
    const replay = services.coordinator.start(trigger());
    assert.equal(replay.replayed, true);
    assert.equal(replay.round.id, first.round.id);
    assert.deepEqual(replay.works.map((entry) => entry.work.id), first.works.map((entry) => entry.work.id));
    database.reopen();
    services = harness(database, clock, 30_000);
    const recovered = services.coordinator.recover({
      roundId: first.round.id,
      requestId: fixtureId("request", 801),
      correlationId: fixtureId("correlation", 801),
    });
    assert.equal(recovered.outcome, "waiting");
    assert.equal(recovered.works.length, 2);
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM outbox WHERE kind = 'work.wake'")?.count, 2);
    services.rounds.beginPass({
      roundId: first.round.id,
      requestId: fixtureId("request", 809),
      correlationId: fixtureId("correlation", 809),
    });
    database.raw.prepare(
      `UPDATE channels SET responder_mode = 'mentions_only',
         coordinator_bot_id = NULL, response_order = 'parallel', max_bot_turns = 1
       WHERE id = ?`,
    ).run(CHANNEL_ID);
    const activeAdmission = services.coordinator.admissionReplay(trigger());
    assert.equal(activeAdmission?.round.state, "coordinating");
    assert.deepEqual(
      activeAdmission?.works.map((entry) => entry.id),
      first.works.map((entry) => entry.work.id),
    );

    for (const [index, entry] of first.works.entries()) {
      terminalize(services, entry.work.id, entry.work.targetPrincipalId, "succeeded", 820 + index);
    }
    services.coordinator.reconcile({
      roundId: first.round.id,
      requestId: fixtureId("request", 808),
      correlationId: fixtureId("correlation", 808),
    });
    const terminalAdmission = services.coordinator.admissionReplay(trigger());
    assert.equal(terminalAdmission?.replayed, true);
    assert.equal(terminalAdmission?.round.id, first.round.id);
    assert.deepEqual(
      terminalAdmission?.works.map((entry) => entry.id),
      first.works.map((entry) => entry.work.id),
    );
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 2);
  } finally { database.close(); }
});

test("stale authority and stale lease fences fail closed without duplicate execution", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database);
    const clock = { value: new Date(AT) };
    const services = harness(database, clock, 40_000);
    assert.throws(
      () => services.coordinator.start(trigger({ authority: { ...trigger().authority, epoch: 0 } })),
      (error: unknown) => error instanceof ChannelCoordinatorError && error.code === "stale_authority",
    );
    const dispatch = services.coordinator.start(trigger({ mentionedBotIds: [BOT_ID] }));
    const offered = services.leases.offer({
      workId: dispatch.works[0]!.work.id,
      holderPrincipalId: BOT_ID,
      holderInstanceId: "resident-1",
      authorityReference: "resident:jerry",
      automatic: true,
      requestId: fixtureId("request", 802),
      correlationId: fixtureId("correlation", 802),
    });
    assert.throws(
      () => services.leases.accept({
        workId: offered.work.id, attemptId: offered.attempt.id, leaseId: offered.lease.id,
        holderPrincipalId: BOT_ID, holderInstanceId: "resident-1",
        fencingToken: offered.fencingToken + 1,
        requestId: fixtureId("request", 803), correlationId: fixtureId("correlation", 803),
      }),
      (error: unknown) => error instanceof LeaseError && error.code === "stale_fence",
    );
    assert.equal(services.work.get(offered.work.id)?.state, "leased");
  } finally { database.close(); }
});

test("explicit pass completes, partial failure fails, and active-turn loop is rejected", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database);
    const clock = { value: new Date(AT) };
    const services = harness(database, clock, 50_000);
    const single = services.coordinator.start(trigger({ mentionedBotIds: [BOT_ID] }));
    terminalize(services, single.works[0]!.work.id, BOT_ID, "succeeded", 810);
    const passed = services.coordinator.reconcile({
      roundId: single.round.id,
      dispositions: { [single.works[0]!.work.id]: "passed" },
      requestId: fixtureId("request", 804), correlationId: fixtureId("correlation", 804),
    });
    assert.equal(passed.outcome, "completed");
    assert.equal(passed.reasonCode, "passed");

    const secondMessage = fixtureId("message", 2);
    appendOwnerMessage(database, secondMessage, 2, 2);
    const mixed = services.coordinator.start(trigger({ eventId: fixtureId("event", 2), messageId: secondMessage, manifest: manifestInput({ messageIds: [secondMessage], counts: { messages: 1, artifacts: 0 } }) }));
    const loopMessage = fixtureId("message", 4);
    appendOwnerMessage(database, loopMessage, 3, 4);
    assert.throws(
      () => services.coordinator.start(trigger({
        eventId: fixtureId("event", 4), messageId: loopMessage, mentionedBotIds: [BOT_ID],
        manifest: manifestInput({ messageIds: [loopMessage], counts: { messages: 1, artifacts: 0 } }),
      })),
      (error: unknown) => error instanceof ChannelCoordinatorError && error.code === "turn_in_progress",
    );
    for (const [index, entry] of mixed.works.entries()) {
      terminalize(services, entry.work.id, entry.work.targetPrincipalId, index === 0 ? "succeeded" : "failed", 830 + index);
    }
    const partial = services.coordinator.reconcile({
      roundId: mixed.round.id,
      requestId: fixtureId("request", 805), correlationId: fixtureId("correlation", 805),
    });
    assert.equal(partial.outcome, "failed");
    assert.equal(partial.reasonCode, "partial_failure");
    const failedReplay = services.coordinator.admissionReplay(trigger({
      eventId: fixtureId("event", 2),
      messageId: secondMessage,
      manifest: manifestInput({ messageIds: [secondMessage], counts: { messages: 1, artifacts: 0 } }),
    }));
    assert.equal(failedReplay?.round.id, mixed.round.id);
    assert.equal(failedReplay?.round.state, "failed");
    assert.deepEqual(
      failedReplay?.works.map((work) => work.id),
      mixed.works.map((entry) => entry.work.id),
    );
  } finally { database.close(); }
});

test("deadline and cancellation terminalize durably and cancel queued Work", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database);
    const clock = { value: new Date(AT) };
    const services = harness(database, clock, 60_000);
    let stage = "start deadline";
    try {
    const deadline = services.coordinator.start(trigger({ mentionedBotIds: [BOT_ID] }));
    stage = "recover deadline";
    clock.value = new Date(DEADLINE);
    const expired = services.coordinator.recover({
      roundId: deadline.round.id,
      requestId: fixtureId("request", 806), correlationId: fixtureId("correlation", 806),
    });
    assert.equal(expired.outcome, "failed");
    assert.equal(expired.reasonCode, "deadline_exceeded");

    stage = "insert cancel message";
    clock.value = new Date(AT);
    const nextMessage = fixtureId("message", 3);
    appendOwnerMessage(database, nextMessage, 2, 3);
    stage = "start cancellable";
    const cancellable = services.coordinator.start(trigger({
      eventId: fixtureId("event", 3), messageId: nextMessage, mentionedBotIds: [BOT_2],
      manifest: manifestInput({ messageIds: [nextMessage], counts: { messages: 1, artifacts: 0 } }),
    }));
    stage = "cancel";
    const cancelled = services.coordinator.cancel({
      roundId: cancellable.round.id,
      actorPrincipalId: OWNER_ID,
      requestId: fixtureId("request", 807), correlationId: fixtureId("correlation", 807),
    });
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal(cancelled.works[0]?.state, "cancelled");
    assert.equal(cancelled.reasonCode, "owner_cancelled");
    const cancelledReplay = services.coordinator.admissionReplay(trigger({
      eventId: fixtureId("event", 3),
      messageId: nextMessage,
      mentionedBotIds: [BOT_2],
      manifest: manifestInput({ messageIds: [nextMessage], counts: { messages: 1, artifacts: 0 } }),
    }));
    assert.equal(cancelledReplay?.round.id, cancellable.round.id);
    assert.equal(cancelledReplay?.round.state, "cancelled");
    assert.deepEqual(cancelledReplay?.works.map((work) => work.id), [cancellable.works[0]!.work.id]);
    } catch (error) {
      throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  } finally { database.close(); }
});
