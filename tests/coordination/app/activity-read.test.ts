import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteActivityReadService } from "../../../src/coordination/app/index.js";
import { MessagingError, type MessagingActorContext } from "../../../src/coordination/channels/index.js";
import type { M11Database } from "../../../src/coordination/work/index.js";
import { fixtureId } from "../activity/fixtures.js";
import { DIRECT_CHANNEL, JERRY } from "../activity/fixtures.js";

function ownerContext(scopes: readonly ("product:read" | "message:send" | "attachment:write")[]): MessagingActorContext {
  return {
    principalId: "user_owner",
    requestId: fixtureId("request", 901),
    correlationId: fixtureId("correlation", 901),
    identity: {
      kind: "owner",
      auth: {
        principalId: "user_owner",
        deviceId: "dev_activity-reader",
        sessionId: "ses_activity-reader",
        scopes,
      },
    },
  };
}

test("a cached Activity projection never bypasses current identity or scope validation", async () => {
  let membershipReads = 0;
  const database = {
    readOne: () => ({ currentSequence: 0, retainedFloor: null, retainedCount: 0 }),
    readAll: () => {
      membershipReads += 1;
      return [];
    },
  } as unknown as M11Database;
  const activity = createSqliteActivityReadService({
    database,
    events: { resumeAfter: () => { throw new Error("empty event window"); } } as never,
    messages: { listMessages: async () => { throw new Error("empty event window"); } },
  });
  const input = {
    context: ownerContext(["product:read"]),
    scope: { kind: "all" as const },
    after: null,
    limit: 50,
  };

  assert.deepEqual(await activity.list(input), {
    entries: [],
    nextBoundary: null,
    throughEventSequence: 0,
  });
  await assert.rejects(
    activity.list({ ...input, context: ownerContext(["message:send"]) }),
    (error: unknown) => error instanceof MessagingError && error.code === "scope_denied",
  );
  await assert.rejects(
    activity.list({
      ...input,
      context: {
        ...ownerContext(["product:read"]),
        principalId: fixtureId("principal", 902),
      },
    }),
    (error: unknown) =>
      error instanceof MessagingError && error.code === "identity_context_mismatch",
  );
  assert.equal(membershipReads, 1, "rejected contexts must not reach membership storage");
});

test("a rejected fence stays stale attention after the retained Work later succeeds", async () => {
  const workId = fixtureId("work", 910);
  const observationId = fixtureId("workObservation", 911);
  const durableEvent = Object.freeze({
    id: fixtureId("event", 912),
    sequence: 1,
    schemaVersion: 1,
    type: "activity.updated",
    durability: "durable" as const,
    aggregate: Object.freeze({ kind: "workObservation", id: observationId, version: 1 }),
    channelId: DIRECT_CHANNEL,
    actorPrincipalId: JERRY,
    requestId: fixtureId("request", 912),
    correlationId: fixtureId("correlation", 912),
    createdAt: "2026-08-28T01:00:00.000Z",
    payload: Object.freeze({
      observationId,
      workId,
      outcomeCode: "stale_fence",
      rejectedFence: 2,
      evidenceDigest: "a".repeat(64),
    }),
  });
  const database = {
    readOne: (sql: string) => {
      if (sql.includes("sqlite_sequence")) {
        return { currentSequence: 1, retainedFloor: 1, retainedCount: 1 };
      }
      if (sql.includes("FROM work_observations")) {
        return {
          id: observationId,
          workId,
          attemptId: null,
          authorityReference: "coordination:rejected-fence",
          fencingToken: 2,
          observationKind: "rejected_fence",
          outcomeCode: "stale_fence",
          createdAt: durableEvent.createdAt,
        };
      }
      if (sql.includes("FROM works")) {
        return {
          id: workId,
          targetPrincipalId: JERRY,
          channelId: DIRECT_CHANNEL,
          roundId: null,
          kind: "resident_turn",
          executionAuthoritySystem: "resident_turn",
          state: "succeeded",
          updatedAt: "2026-08-28T01:05:00.000Z",
        };
      }
      throw new Error(`unexpected readOne: ${sql}`);
    },
    readAll: (sql: string) => {
      if (!sql.includes("FROM channel_members viewer")) {
        throw new Error(`unexpected readAll: ${sql}`);
      }
      return [
        { channelId: DIRECT_CHANNEL, memberPrincipalId: "user_owner" },
        { channelId: DIRECT_CHANNEL, memberPrincipalId: JERRY },
      ];
    },
  } as unknown as M11Database;
  const activity = createSqliteActivityReadService({
    database,
    events: {
      resumeAfter: () => ({
        kind: "events",
        events: [durableEvent],
        throughSequence: 1,
        currentSequence: 1,
        retentionFloorSequence: 1,
        hasMore: false,
      }),
    } as never,
    messages: { listMessages: async () => { throw new Error("no Message facts expected"); } },
  });

  const page = await activity.list({
    context: ownerContext(["product:read"]),
    scope: { kind: "all" },
    after: null,
    limit: 50,
  });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0]?.label, "Status may be stale");
  assert.equal(page.entries[0]?.state, "attention");
  assert.equal(page.entries[0]?.terminalReason, null);
  assert.equal(page.entries[0]?.source.freshness, "stale");
});

test("Activity derives queued and Outbox Bot authority from immutable Work kind while residents stay resident", async () => {
  const cases = [
    { source: "work", workKind: "bot_turn", expected: "bot_turn" },
    { source: "outbox", workKind: "bot_turn", expected: "bot_turn" },
    { source: "work", workKind: "resident_turn", expected: "resident_turn" },
    { source: "work", workKind: "channel.bot_turn", expected: "resident_turn" },
    { source: "work", workKind: "channel.bot_turn", expected: "bot_turn" },
  ] as const;

  for (const [index, current] of cases.entries()) {
    const workId = fixtureId("work", 920 + index);
    const outboxId = `obx_${fixtureId("event", 930 + index).slice(4)}`;
    const durableEvent = Object.freeze({
      id: fixtureId("event", 920 + index),
      sequence: 1,
      schemaVersion: 1,
      type: current.source === "work" ? "turn.updated" : "activity.updated",
      durability: "durable" as const,
      aggregate: Object.freeze(current.source === "work"
        ? { kind: "work", id: workId, version: 1 }
        : { kind: "outbox", id: outboxId, version: 1 }),
      channelId: DIRECT_CHANNEL,
      actorPrincipalId: JERRY,
      requestId: fixtureId("request", 920 + index),
      correlationId: fixtureId("correlation", 920 + index),
      createdAt: `2026-08-28T02:00:0${index}.000Z`,
      payload: Object.freeze(current.source === "work"
        ? { workId, state: "queued" }
        : { outboxId, workId, state: "pending" }),
    });
    const database = {
      readOne: (sql: string) => {
        if (sql.includes("sqlite_sequence")) {
          return { currentSequence: 1, retainedFloor: 1, retainedCount: 1 };
        }
        if (sql.includes("FROM outbox WHERE id")) {
          return { id: outboxId, workId, kind: "work.wake", updatedAt: durableEvent.createdAt };
        }
        if (sql.includes("FROM works")) {
          return {
            id: workId,
            targetPrincipalId: JERRY,
            channelId: DIRECT_CHANNEL,
            roundId: null,
            kind: current.workKind,
            executionAuthoritySystem: current.expected,
            state: "queued",
            updatedAt: durableEvent.createdAt,
          };
        }
        throw new Error(`unexpected readOne: ${sql}`);
      },
      readAll: (sql: string) => {
        if (!sql.includes("FROM channel_members viewer")) {
          throw new Error(`unexpected readAll: ${sql}`);
        }
        return [
          { channelId: DIRECT_CHANNEL, memberPrincipalId: "user_owner" },
          { channelId: DIRECT_CHANNEL, memberPrincipalId: JERRY },
        ];
      },
    } as unknown as M11Database;
    const activity = createSqliteActivityReadService({
      database,
      events: {
        resumeAfter: () => ({
          kind: "events",
          events: [durableEvent],
          throughSequence: 1,
          currentSequence: 1,
          retentionFloorSequence: 1,
          hasMore: false,
        }),
      } as never,
      messages: { listMessages: async () => { throw new Error("no Message facts expected"); } },
    });

    const page = await activity.list({
      context: ownerContext(["product:read"]),
      scope: { kind: "all" },
      after: null,
      limit: 50,
    });
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]?.source.authoritySystem, current.expected);
  }
});
