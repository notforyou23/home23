import assert from "node:assert/strict";
import test from "node:test";

import {
  ResidentCoordinationAdapter,
  createM11ResidentCoordinationPort,
  type ResidentAgentPort,
} from "../../../src/coordination-adapter/index.js";
import { SqliteGroupChannelMessageContext } from "../../../src/coordination/app/channel-message-context.js";
import { createGroupChannelMessageService } from "../../../src/coordination/app/channel-message.js";
import { directMessageManifest } from "../../../src/coordination/app/direct-message.js";
import {
  ChannelCoordinatorError,
  createChannelCoordinator,
  type ChannelTurnTrigger,
  type CoordinatorAdmissionPlan,
  type CreateChannelCoordinatorOptions,
} from "../../../src/coordination/channel-coordinator/index.js";
import { createLeaseService } from "../../../src/coordination/leases/index.js";
import { createRoundService } from "../../../src/coordination/rounds/index.js";
import { createWorkService, type WorkRecord } from "../../../src/coordination/work/index.js";
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  MESSAGE_ID,
  M11TestDatabase,
  OWNER_ID,
  createFixtureIdGenerator,
  fixtureId,
} from "../work/test-fixture.js";

const BOT_2 = fixtureId("bot", 2);
const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000001";
const DEADLINE = "2026-08-25T16:10:00.000Z";
const AUTHORITY = Object.freeze({
  capability: "messages" as const,
  mode: "canonical" as const,
  epoch: 1,
  writer: "home23-coordination",
});

type DurabilityFailpoint = NonNullable<
  CreateChannelCoordinatorOptions["durabilityFailpoint"]
>;

function prepare(database: M11TestDatabase, responseOrder: "parallel" | "sequential"): void {
  database.raw.prepare(
    "INSERT INTO authority_epochs VALUES ('messages', 1, 'canonical', 'home23-coordination', 1, NULL, '{}', ?)",
  ).run(AT);
  database.raw.prepare(
    `UPDATE channels SET kind = 'group', responder_mode = 'mention_or_coordinator',
       coordinator_bot_id = ?, response_order = ?, max_bot_turns = 4
     WHERE id = ?`,
  ).run(BOT_ID, responseOrder, CHANNEL_ID);
  database.raw.prepare(
    "INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)",
  ).run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare(
    "INSERT INTO principals (id, kind, created_at) VALUES (?, 'bot', ?)",
  ).run(BOT_2, AT);
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
    `INSERT INTO channel_members (
      channel_id, principal_id, kind, role, active, joined_at, left_at
    ) VALUES (?, ?, 'bot', 'member', 1, ?, NULL)`,
  ).run(CHANNEL_ID, BOT_2, AT);
}

function initialManifest(database: M11TestDatabase) {
  const event = database.readOne<{ sequence: number }>(
    `SELECT sequence FROM events
     WHERE aggregate_kind = 'message' AND aggregate_id = ?
       AND type = 'message.appended'`,
    MESSAGE_ID,
  );
  assert.ok(event);
  return directMessageManifest({
    channelId: CHANNEL_ID,
    messageIds: [MESSAGE_ID],
    attachmentIds: [],
    channelSequence: 1,
    eventSequence: event.sequence,
  });
}

function admissionPlan(
  database: M11TestDatabase,
  responseOrder: "parallel" | "sequential",
): CoordinatorAdmissionPlan {
  return Object.freeze({
    version: 1 as const,
    channelId: CHANNEL_ID,
    conversationId: CONVERSATION_ID,
    originMessageId: MESSAGE_ID,
    originEventId: fixtureId("event", 1),
    actorPrincipalId: OWNER_ID,
    visibleParticipantIds: Object.freeze([BOT_ID, BOT_2]),
    selectedTargets: Object.freeze([
      Object.freeze({
        targetBotId: BOT_ID,
        targetBotDisplayName: "Jerry",
        targetPrincipalId: BOT_ID,
        residentBinding: "jerry",
      }),
      Object.freeze({
        targetBotId: BOT_2,
        targetBotDisplayName: "Ada",
        targetPrincipalId: BOT_2,
        residentBinding: "ada",
      }),
    ]),
    responseOrder,
    standingReference: `canonical-channel-membership:${CHANNEL_ID}:version:1`,
    manifest: initialManifest(database),
    turnSelection: Object.freeze({ modelAlias: "gpt-5.6", reasoningEffort: "max" }),
  });
}

function trigger(
  plan: CoordinatorAdmissionPlan,
  input: {
    mentionedBotIds?: readonly string[];
    manifest?: CoordinatorAdmissionPlan["manifest"];
    identitySuffix?: number;
  } = {},
): ChannelTurnTrigger {
  const identitySuffix = input.identitySuffix ?? 800;
  return Object.freeze({
    eventId: plan.originEventId,
    messageId: plan.originMessageId,
    channelId: plan.channelId,
    actorPrincipalId: plan.actorPrincipalId,
    selection: "mentions" as const,
    mentionedBotIds: input.mentionedBotIds ?? plan.selectedTargets.map(
      (target) => target.targetBotId,
    ),
    plannedBotIds: plan.selectedTargets.map((target) => target.targetBotId),
    admissionPlan: plan,
    visibleParticipantIds: plan.visibleParticipantIds,
    standing: Object.freeze({
      source: "trusted_policy_boundary" as const,
      reference: plan.standingReference,
      channelId: plan.channelId,
      allowedParticipantIds: plan.visibleParticipantIds,
      broadcastAllowed: false,
    }),
    authority: AUTHORITY,
    deadlineAt: DEADLINE,
    manifest: input.manifest ?? plan.manifest,
    turnSelection: plan.turnSelection,
    requestId: fixtureId("request", identitySuffix),
    correlationId: fixtureId("correlation", identitySuffix),
  });
}

function replayIdentity(suffix: number) {
  return Object.freeze({
    messageId: MESSAGE_ID,
    channelId: CHANNEL_ID,
    actorPrincipalId: OWNER_ID,
    authority: AUTHORITY,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  });
}

function harness(
  database: M11TestDatabase,
  idStart: number,
  durabilityFailpoint?: DurabilityFailpoint,
  now: () => Date = () => new Date(AT),
) {
  const generateId = createFixtureIdGenerator(idStart);
  const work = createWorkService({ database, generateId, now });
  const rounds = createRoundService({ database, generateId, now });
  const leases = createLeaseService({
    database,
    generateId,
    now,
    leaseTtlMs: 60_000,
  });
  const coordinator = createChannelCoordinator({
    database,
    rounds,
    work,
    enabled: true,
    expectedAuthorityWriter: AUTHORITY.writer,
    now,
    ...(durabilityFailpoint === undefined ? {} : { durabilityFailpoint }),
  });
  const context = new SqliteGroupChannelMessageContext(database, {
    async listMessages() {
      throw new Error("durability recovery must not resnapshot mutable Message projections");
    },
  });
  return { coordinator, context, leases, rounds, work };
}

function roundId(database: M11TestDatabase): string {
  const row = database.readOne<{ id: string }>("SELECT id FROM rounds");
  assert.ok(row);
  return row.id;
}

function roundWorks(database: M11TestDatabase, durableRoundId: string): readonly WorkRecord[] {
  const context = new SqliteGroupChannelMessageContext(database, {
    async listMessages() {
      throw new Error("not used");
    },
  });
  return context.listRoundWorks(durableRoundId);
}

function terminalizeSucceeded(
  services: ReturnType<typeof harness>,
  work: WorkRecord,
  suffix: number,
): void {
  const authorityReference = `resident:${work.targetPrincipalId}`;
  const holderInstanceId = `resident-${suffix}`;
  const offered = services.leases.offer({
    workId: work.id,
    holderPrincipalId: work.targetPrincipalId,
    holderInstanceId,
    authorityReference,
    automatic: true,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  });
  const binding = {
    workId: work.id,
    attemptId: offered.attempt.id,
    leaseId: offered.lease.id,
    holderPrincipalId: work.targetPrincipalId,
    holderInstanceId,
    fencingToken: offered.fencingToken,
    requestId: fixtureId("request", suffix + 1),
    correlationId: fixtureId("correlation", suffix + 1),
  };
  services.leases.accept(binding);
  services.leases.start({
    ...binding,
    requestId: fixtureId("request", suffix + 2),
    correlationId: fixtureId("correlation", suffix + 2),
  });
  services.leases.terminalize({
    ...binding,
    requestId: fixtureId("request", suffix + 3),
    correlationId: fixtureId("correlation", suffix + 3),
    receipt: {
      status: "succeeded",
      sourceReference: authorityReference,
      resultDigest: "c".repeat(64),
      artifactIds: [],
      timestamp: AT,
    },
  });
}

function appendResult(
  database: M11TestDatabase,
  input: { roundId: string; workId: string },
): string {
  const messageId = fixtureId("message", 2);
  database.mutateWithEvent((transaction) => {
    transaction.run(
      `INSERT INTO messages (
        id, channel_id, channel_sequence, author_principal_id, author_kind,
        author_display_name, kind, body_text, stored_visibility,
        client_message_id, reply_to_message_id, tombstones_message_id,
        round_id, work_id, created_at
      ) VALUES (?, ?, 2, ?, 'bot', 'Jerry', 'result', 'first answer',
                'visible', NULL, ?, NULL, ?, ?, ?)`,
      messageId,
      CHANNEL_ID,
      BOT_ID,
      MESSAGE_ID,
      input.roundId,
      input.workId,
      AT,
    );
    transaction.run(
      "UPDATE channels SET next_message_sequence = 3 WHERE id = ?",
      CHANNEL_ID,
    );
    return {
      value: undefined,
      event: {
        type: "message.appended",
        aggregateKind: "message",
        aggregateId: messageId,
        aggregateVersion: 1,
        channelId: CHANNEL_ID,
        actorPrincipalId: BOT_ID,
        requestId: fixtureId("request", 950),
        correlationId: fixtureId("correlation", 950),
        payload: {},
        createdAt: AT,
      },
    };
  });
  return messageId;
}

test("restart before the first Work repairs the exact parallel admission from the Round event", async () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database, "parallel");
    const plan = admissionPlan(database, "parallel");
    const crashed = harness(database, 20_000, (point) => {
      if (point === "after_round_created") throw new Error("simulated process loss after Round");
    });

    assert.throws(
      () => crashed.coordinator.start(trigger(plan)),
      /simulated process loss after Round/,
    );
    const durableRoundId = roundId(database);
    assert.equal(roundWorks(database, durableRoundId).length, 0);
    assert.deepEqual(crashed.context.listRecoveryRoundIds(100), [durableRoundId]);

    database.reopen();
    const restarted = harness(database, 21_000);
    const recoveredPlan = await restarted.context.recoverPlan(durableRoundId);
    assert.equal(recoveredPlan.prepared.responseOrder, "parallel");
    assert.deepEqual(
      recoveredPlan.prepared.selectedTargets.map((target) => target.residentBinding),
      ["jerry", "ada"],
    );
    const replay = restarted.coordinator.admissionReplay(replayIdentity(801));
    assert.ok(replay);
    assert.equal(replay.round.id, durableRoundId);
    assert.deepEqual(replay.recipients, [BOT_ID, BOT_2]);
    assert.deepEqual(replay.works.map((work) => work.targetPrincipalId), [BOT_ID, BOT_2]);
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM rounds")?.count, 1);
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 2);
    await Promise.all(replay.works.map((work) => restarted.context.recover(work)));
  } finally {
    database.close();
  }
});

test("restart after parallel Work one repairs the missing Work once and replays the exact set", async () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database, "parallel");
    const plan = admissionPlan(database, "parallel");
    const crashed = harness(database, 30_000, (point, detail) => {
      if (point === "after_work_created" && detail.workCount === 1) {
        throw new Error("simulated process loss after parallel Work one");
      }
    });

    assert.throws(
      () => crashed.coordinator.start(trigger(plan)),
      /simulated process loss after parallel Work one/,
    );
    const durableRoundId = roundId(database);
    const firstWorkId = roundWorks(database, durableRoundId)[0]?.id;
    assert.ok(firstWorkId);

    database.reopen();
    const restarted = harness(database, 31_000);
    const repaired = restarted.coordinator.admissionReplay(replayIdentity(802));
    assert.ok(repaired);
    assert.deepEqual(repaired.works.map((work) => work.targetPrincipalId), [BOT_ID, BOT_2]);
    assert.equal(repaired.works[0]?.id, firstWorkId);
    const replayed = restarted.coordinator.admissionReplay(replayIdentity(803));
    assert.ok(replayed);
    assert.deepEqual(replayed.works.map((work) => work.id), repaired.works.map((work) => work.id));
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM rounds")?.count, 1);
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 2);
    await Promise.all(replayed.works.map((work) => restarted.context.recover(work)));
  } finally {
    database.close();
  }
});

test("application recovery rebuilds zero-Work admission with exact caller selection", async () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database, "parallel");
    const plan = admissionPlan(database, "parallel");
    const crashed = harness(database, 35_000, (point) => {
      if (point === "after_round_created") throw new Error("simulated caller loss after Round");
    });
    assert.throws(
      () => crashed.coordinator.start(trigger(plan)),
      /simulated caller loss after Round/u,
    );
    const durableRoundId = roundId(database);
    assert.equal(roundWorks(database, durableRoundId).length, 0);
    database.raw.prepare(
      `INSERT INTO authority_epochs VALUES (
        'messages', 2, 'canonical', 'home23-coordination', 1, 1, '{}', ?
      )`,
    ).run(AT);

    database.reopen();
    const restarted = harness(database, 36_000);
    const selections: Array<Readonly<{
      binding: string;
      modelAlias: string | null;
      reasoningEffort: string | null;
    }>> = [];
    const residentTargets = new Map(
      plan.selectedTargets.map((target, index) => {
        const agent: ResidentAgentPort = {
          async modelCatalog() {
            return {
              models: [{
                alias: "gpt-5.6",
                provider: "fixture",
                model: "gpt-5.6",
                reasoningEffort: "max",
              }],
              defaultModel: "fixture-default",
              defaultProvider: "fixture",
              defaultReasoningEffort: "medium",
              reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
            };
          },
          async runWithTurn(chatId, _text, options) {
            selections.push(Object.freeze({
              binding: target.residentBinding,
              modelAlias: options.turnSelection.modelAlias,
              reasoningEffort: options.turnSelection.reasoningEffort,
            }));
            const turnId = `recovered-${target.residentBinding}`;
            await options.onDurableStart({
              turnId,
              chatId,
              persistedAt: AT,
              selection: {
                requestedProvider: null,
                requestedModelAlias: options.turnSelection.modelAlias,
                requestedModel: null,
                requestedEffort: options.turnSelection.reasoningEffort,
                resolvedProvider: "fixture",
                resolvedModel: "gpt-5.6",
                resolvedEffort: "max",
                actualProvider: "fixture",
                actualModel: "gpt-5.6",
                actualEffort: "max",
              },
            });
            return {
              turnId,
              response: Promise.resolve({
                text: "",
                model: "gpt-5.6",
                toolCallCount: 0,
                durationMs: 1,
              }),
            };
          },
          stop: () => ({ stopped: true }),
        };
        return [target.residentBinding, {
          resident: new ResidentCoordinationAdapter(
            agent,
            createM11ResidentCoordinationPort(restarted.leases),
            () => new Date(AT),
          ),
          holderInstanceId: `resident-${index + 1}`,
          models: agent,
          context: ({ principalId, requestId, correlationId }: {
            principalId: string;
            requestId: string;
            correlationId: string;
          }) => ({
            principalId,
            requestId,
            correlationId,
            identity: {
              kind: "resident" as const,
              resident: {
                requestId,
                correlationId,
                credential: {
                  residentSlug: target.residentBinding,
                  role: "resident" as const,
                  instanceId: `resident-${index + 1}`,
                  keyVersion: 1,
                },
              },
            },
          }),
        }] as const;
      }),
    );
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
    const service = createGroupChannelMessageService({
      messages: {
        async sendMessage() {
          throw new Error("an explicit pass must not fabricate a result Message");
        },
        async listMessages() {
          throw new Error("durable recovery must not resnapshot mutable Messages");
        },
      },
      context: restarted.context,
      coordinator: restarted.coordinator,
      work: restarted.work,
      leases: restarted.leases,
      resolveResident: (binding) => residentTargets.get(binding),
      authority: {
        current: () => ({
          capability: "messages" as const,
          epoch: 2,
          mode: "canonical" as const,
          writer: "home23-coordination",
          effectiveAtEventSequence: 1,
          rollbackEpoch: 1,
        }),
      },
      recordMessage: async () => undefined,
      beginWork: () => () => resolveEnded(),
      recoveryIdentity: () => ({
        requestId: fixtureId("request", 1_500),
        correlationId: fixtureId("correlation", 1_500),
      }),
      now: () => new Date(AT),
    });
    const receipt = await service.recoverResidentWork();
    assert.deepEqual(receipt, { discovered: 1, scheduled: 1, refused: 0 });
    await ended;

    assert.deepEqual(
      selections.sort((left, right) => left.binding.localeCompare(right.binding)),
      [
        { binding: "ada", modelAlias: "gpt-5.6", reasoningEffort: "max" },
        { binding: "jerry", modelAlias: "gpt-5.6", reasoningEffort: "max" },
      ],
    );
    assert.deepEqual(
      roundWorks(database, durableRoundId).map((work) => work.state),
      ["succeeded", "succeeded"],
    );
    assert.equal(restarted.rounds.get(durableRoundId)?.state, "completed");
  } finally {
    database.close();
  }
});

test("sequential restart retains the admission order and resident binding across mutable Channel drift", async () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database, "sequential");
    const plan = admissionPlan(database, "sequential");
    const crashed = harness(database, 40_000, (point, detail) => {
      if (point === "after_work_created" && detail.workCount === 1) {
        throw new Error("simulated process loss after sequential Work one");
      }
    });
    assert.throws(
      () => crashed.coordinator.start(trigger(plan)),
      /simulated process loss after sequential Work one/,
    );
    const durableRoundId = roundId(database);

    database.reopen();
    const resumed = harness(database, 41_000);
    const initial = resumed.coordinator.resumeAdmission({
      roundId: durableRoundId,
      authority: AUTHORITY,
      requestId: fixtureId("request", 804),
      correlationId: fixtureId("correlation", 804),
    });
    assert.equal(initial.round.state, "coordinating");
    assert.deepEqual(initial.works.map((work) => work.targetPrincipalId), [BOT_ID]);
    assert.equal(
      (await resumed.context.recoverPlan(durableRoundId)).prepared.selectedTargets.length,
      2,
      "an active sequential admission intentionally retains only its first Work",
    );
    terminalizeSucceeded(resumed, initial.works[0]!, 900);
    const resultMessageId = appendResult(database, {
      roundId: durableRoundId,
      workId: initial.works[0]!.id,
    });
    database.raw.prepare(
      `UPDATE channels SET responder_mode = 'mentions_only', coordinator_bot_id = NULL,
         response_order = 'parallel', max_bot_turns = 1, version = version + 1
       WHERE id = ?`,
    ).run(CHANNEL_ID);

    database.reopen();
    const restarted = harness(database, 42_000);
    const recovered = await restarted.context.recoverPlan(durableRoundId);
    assert.equal(recovered.prepared.responseOrder, "sequential");
    assert.deepEqual(
      recovered.prepared.selectedTargets.map((target) => [
        target.targetBotId,
        target.targetBotDisplayName,
        target.residentBinding,
      ]),
      [
        [BOT_ID, "Jerry", "jerry"],
        [BOT_2, "Ada", "ada"],
      ],
    );
    const secondPrepared = await restarted.context.prepareSequentialTurn({
      plan: recovered.prepared,
      roundId: durableRoundId,
      targetBotId: BOT_2,
    });
    assert.deepEqual(secondPrepared.manifest.messageIds, [MESSAGE_ID, resultMessageId]);
    assert.match(secondPrepared.instruction, /Jerry: first answer/);

    const second = restarted.coordinator.start(trigger(plan, {
      mentionedBotIds: [BOT_2],
      manifest: secondPrepared.manifest,
      identitySuffix: 805,
    }));
    assert.equal(second.round.id, durableRoundId);
    assert.deepEqual(second.recipients, [BOT_2]);
    assert.equal(second.works.length, 1);
    assert.equal(second.works[0]?.work.targetPrincipalId, BOT_2);
    const recoveredSecond = await restarted.context.recover(second.works[0]!.work);
    assert.equal(recoveredSecond.selectedTargets[0]?.residentBinding, "ada");
    assert.deepEqual(recoveredSecond.manifest.messageIds, [MESSAGE_ID, resultMessageId]);

    const replayed = restarted.coordinator.start(trigger(plan, {
      mentionedBotIds: [BOT_2],
      manifest: secondPrepared.manifest,
      identitySuffix: 806,
    }));
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.works[0]?.work.id, second.works[0]?.work.id);
    assert.deepEqual(
      roundWorks(database, durableRoundId).map((work) => work.targetPrincipalId),
      [BOT_ID, BOT_2],
    );
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM rounds")?.count, 1);
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 2);
  } finally {
    database.close();
  }
});

test("successful reconcile refuses to complete a sequential prefix", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database, "sequential");
    const plan = admissionPlan(database, "sequential");
    const services = harness(database, 50_000);
    const started = services.coordinator.start(trigger(plan, { mentionedBotIds: [BOT_ID] }));
    assert.equal(started.works.length, 1);
    terminalizeSucceeded(services, started.works[0]!.work, 1_000);

    assert.throws(
      () => services.coordinator.reconcile({
        roundId: started.round.id,
        dispositions: { [started.works[0]!.work.id]: "completed" },
        requestId: fixtureId("request", 1_010),
        correlationId: fixtureId("correlation", 1_010),
      }),
      (error: unknown) => error instanceof ChannelCoordinatorError &&
        error.code === "illegal_state" && /admission plan is complete/u.test(error.message),
    );
    assert.equal(services.rounds.get(started.round.id)?.state, "coordinating");
    assert.deepEqual(
      roundWorks(database, started.round.id).map((work) => work.targetPrincipalId),
      [BOT_ID],
    );
  } finally {
    database.close();
  }
});

test("terminal replay rejects a falsely completed sequential prefix", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database, "sequential");
    const plan = admissionPlan(database, "sequential");
    const services = harness(database, 60_000);
    const started = services.coordinator.start(trigger(plan, { mentionedBotIds: [BOT_ID] }));
    terminalizeSucceeded(services, started.works[0]!.work, 1_100);
    services.rounds.terminalize({
      roundId: started.round.id,
      status: "completed",
      reasonCode: "completed",
      requestId: fixtureId("request", 1_110),
      correlationId: fixtureId("correlation", 1_110),
    });

    database.reopen();
    const restarted = harness(database, 61_000);
    assert.throws(
      () => restarted.coordinator.admissionReplay(replayIdentity(1_111)),
      (error: unknown) => error instanceof ChannelCoordinatorError &&
        error.code === "illegal_state" && /terminal Round is incomplete/u.test(error.message),
    );
    assert.equal(roundWorks(database, started.round.id).length, 1);
  } finally {
    database.close();
  }
});

test("a full sequential terminal admission replays exactly without new Work", async () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database, "sequential");
    const plan = admissionPlan(database, "sequential");
    const services = harness(database, 70_000);
    const first = services.coordinator.start(trigger(plan, { mentionedBotIds: [BOT_ID] }));
    terminalizeSucceeded(services, first.works[0]!.work, 1_200);
    appendResult(database, { roundId: first.round.id, workId: first.works[0]!.work.id });
    const recovered = await services.context.recoverPlan(first.round.id);
    const secondPrepared = await services.context.prepareSequentialTurn({
      plan: recovered.prepared,
      roundId: first.round.id,
      targetBotId: BOT_2,
    });
    const second = services.coordinator.start(trigger(plan, {
      mentionedBotIds: [BOT_2],
      manifest: secondPrepared.manifest,
      identitySuffix: 1_210,
    }));
    terminalizeSucceeded(services, second.works[0]!.work, 1_220);
    const allWorks = roundWorks(database, first.round.id);
    const completed = services.coordinator.reconcile({
      roundId: first.round.id,
      dispositions: Object.fromEntries(allWorks.map((work) => [work.id, "completed"])),
      requestId: fixtureId("request", 1_230),
      correlationId: fixtureId("correlation", 1_230),
    });
    assert.equal(completed.outcome, "completed");
    const workIds = allWorks.map((work) => work.id);

    database.reopen();
    const restarted = harness(database, 71_000);
    const replay = restarted.coordinator.admissionReplay(replayIdentity(1_231));
    assert.ok(replay);
    assert.equal(replay.round.state, "completed");
    assert.deepEqual(replay.works.map((work) => work.id), workIds);
    assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 2);
  } finally {
    database.close();
  }
});

test("deadline replay preserves legitimate zero-Work cancellation and partial failure", () => {
  for (const scenario of ["before_work", "after_parallel_work_one"] as const) {
    const database = M11TestDatabase.temporary();
    try {
      prepare(database, "parallel");
      const plan = admissionPlan(database, "parallel");
      let clock = new Date(AT);
      const crashed = harness(database, scenario === "before_work" ? 80_000 : 90_000,
        (point, detail) => {
          if (
            (scenario === "before_work" && point === "after_round_created") ||
            (scenario === "after_parallel_work_one" && point === "after_work_created" &&
              detail.workCount === 1)
          ) {
            throw new Error(`simulated ${scenario} process loss`);
          }
        },
        () => clock,
      );
      assert.throws(
        () => crashed.coordinator.start(trigger(plan)),
        new RegExp(`simulated ${scenario} process loss`, "u"),
      );
      const durableRoundId = roundId(database);
      const workCountBeforeDeadline = roundWorks(database, durableRoundId).length;
      assert.equal(workCountBeforeDeadline, scenario === "before_work" ? 0 : 1);

      clock = new Date("2026-08-25T16:11:00.000Z");
      database.reopen();
      const restarted = harness(database, scenario === "before_work" ? 81_000 : 91_000,
        undefined, () => clock);
      const replay = restarted.coordinator.admissionReplay(
        replayIdentity(scenario === "before_work" ? 1_300 : 1_301),
      );
      assert.ok(replay);
      assert.equal(replay.round.state, scenario === "before_work" ? "cancelled" : "failed");
      assert.equal(replay.round.terminalReason, "deadline_exceeded");
      assert.equal(replay.works.length, workCountBeforeDeadline);
      assert.ok(
        replay.works.every((work) => ["succeeded", "failed", "cancelled"].includes(work.state)),
        "a terminal Round replay must contain only terminal Work",
      );
      if (scenario === "after_parallel_work_one") {
        assert.equal(replay.works[0]?.state, "cancelled");
        assert.equal(replay.works[0]?.terminalReason, "round_deadline_exceeded");
      }
      assert.equal(roundWorks(database, durableRoundId).length, workCountBeforeDeadline);
    } finally {
      database.close();
    }
  }
});

test("deadline waits for running Work before returning one coherent terminal replay", () => {
  const database = M11TestDatabase.temporary();
  try {
    prepare(database, "sequential");
    const plan = admissionPlan(database, "sequential");
    let clock = new Date(AT);
    const services = harness(database, 100_000, undefined, () => clock);
    const started = services.coordinator.start(trigger(plan, { mentionedBotIds: [BOT_ID] }));
    const work = started.works[0]!.work;
    const offered = services.leases.offer({
      workId: work.id,
      holderPrincipalId: work.targetPrincipalId,
      holderInstanceId: "resident-deadline",
      authorityReference: "resident:jerry",
      automatic: true,
      requestId: fixtureId("request", 1_400),
      correlationId: fixtureId("correlation", 1_400),
    });
    const binding = {
      workId: work.id,
      attemptId: offered.attempt.id,
      leaseId: offered.lease.id,
      holderPrincipalId: work.targetPrincipalId,
      holderInstanceId: "resident-deadline",
      fencingToken: offered.fencingToken,
      requestId: fixtureId("request", 1_401),
      correlationId: fixtureId("correlation", 1_401),
    };
    services.leases.accept(binding);
    services.leases.start({
      ...binding,
      requestId: fixtureId("request", 1_402),
      correlationId: fixtureId("correlation", 1_402),
    });

    clock = new Date("2026-08-25T16:11:00.000Z");
    const pending = services.coordinator.reconcile({
      roundId: started.round.id,
      requestId: fixtureId("request", 1_403),
      correlationId: fixtureId("correlation", 1_403),
    });
    assert.equal(pending.outcome, "waiting");
    assert.equal(pending.round.state, "coordinating");
    assert.equal(pending.works[0]?.state, "running");

    services.leases.terminalize({
      ...binding,
      requestId: fixtureId("request", 1_404),
      correlationId: fixtureId("correlation", 1_404),
      receipt: {
        status: "succeeded",
        sourceReference: "resident:jerry",
        resultDigest: "d".repeat(64),
        artifactIds: [],
        timestamp: clock.toISOString(),
      },
    });
    const terminal = services.coordinator.reconcile({
      roundId: started.round.id,
      requestId: fixtureId("request", 1_405),
      correlationId: fixtureId("correlation", 1_405),
    });
    assert.equal(terminal.outcome, "failed");
    assert.equal(terminal.reasonCode, "deadline_exceeded");
    assert.equal(terminal.works[0]?.state, "succeeded");
    assert.ok(terminal.works.every((candidate) =>
      ["succeeded", "failed", "cancelled"].includes(candidate.state)));
  } finally {
    database.close();
  }
});
