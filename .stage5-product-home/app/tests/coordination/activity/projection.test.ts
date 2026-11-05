import assert from "node:assert/strict";
import test from "node:test";

import { projectActivity } from "../../../src/coordination/activity/index.js";
import {
  FORREST,
  GROUP_CHANNEL,
  JERRY,
  audience,
  event,
  fixtureId,
  observation,
  resultMessage,
  sourceWindow,
} from "./fixtures.js";

test("a direct result and its canonical ordered facts produce attributable Activity", () => {
  const started = observation(11, "started", { channelId: fixtureId("channel", 21) });
  const progress = observation(12, "progress", {
    channelId: fixtureId("channel", 21),
    safeSummary: "Checking the source receipt.",
  });
  const message = resultMessage(13);

  const result = projectActivity({
    sourceWindow: sourceWindow(10, 13),
    events: [event(13)],
    messages: [message],
    workObservations: [progress, started],
    audience: audience(),
  });

  assert.deepEqual(
    result.entries.map((entry) => ({
      sequence: entry.eventSequence,
      category: entry.category,
      state: entry.state,
      label: entry.label,
      actor: entry.actor,
      channelId: entry.channelId,
      workId: entry.workId,
      observationId: entry.observationId,
    })),
    [
      {
        sequence: 11,
        category: "started",
        state: "accepted",
        label: "Started",
        actor: { principalId: JERRY, displayName: null },
        channelId: fixtureId("channel", 21),
        workId: fixtureId("work", 82),
        observationId: started.observation.id,
      },
      {
        sequence: 12,
        category: "progress",
        state: "working",
        label: "Working",
        actor: { principalId: JERRY, displayName: null },
        channelId: fixtureId("channel", 21),
        workId: fixtureId("work", 82),
        observationId: progress.observation.id,
      },
      {
        sequence: 13,
        category: "completion",
        state: "idle",
        label: "Result posted",
        actor: { principalId: JERRY, displayName: "Jerry" },
        channelId: fixtureId("channel", 21),
        workId: fixtureId("work", 82),
        observationId: null,
      },
    ],
  );
  assert.equal(result.entries[2]?.messageId, message.id);
  assert.equal(result.entries[2]?.terminalExplanation, "A durable result message was posted.");
  assert.deepEqual(result.integrity, { status: "complete" });
  assert.equal(result.throughEventSequence, 13);
});

test("a Channel stream collapses noise without crossing attribution or transition boundaries", () => {
  const firstProgress = observation(22, "progress", { safeSummary: "Checking source one." });
  const latestProgress = observation(23, "progress", { safeSummary: "Checking source two." });
  const retry = observation(25, "retry", {
    actorPrincipalId: FORREST,
    workId: fixtureId("work", 83),
  });
  const artifact = observation(27, "artifact", {
    actorPrincipalId: FORREST,
    workId: fixtureId("work", 83),
  });
  const completion = observation(28, "completion", {
    actorPrincipalId: FORREST,
    workId: fixtureId("work", 83),
    terminalReason: "passed",
  });

  const result = projectActivity({
    sourceWindow: sourceWindow(20, 28),
    events: [],
    messages: [],
    workObservations: [
      completion,
      observation(24, "waiting"),
      latestProgress,
      observation(21, "started"),
      firstProgress,
      retry,
      observation(26, "failure"),
      artifact,
      latestProgress,
    ],
    audience: audience(),
  });

  assert.deepEqual(
    result.entries.map((entry) => [entry.eventSequence, entry.category, entry.label]),
    [
      [21, "started", "Started"],
      [23, "progress", "Working"],
      [24, "waiting", "Waiting"],
      [25, "retry", "Retry scheduled"],
      [26, "failure", "Failed"],
      [27, "artifact", "Artifact ready"],
      [28, "completion", "Passed"],
    ],
  );
  assert.equal(result.entries[1]?.collapsedCount, 2);
  assert.deepEqual(result.entries[1]?.interval, {
    firstEventSequence: 22,
    lastEventSequence: 23,
    startedAt: firstProgress.event.createdAt,
    endedAt: latestProgress.event.createdAt,
  });
  assert.equal(result.entries[4]?.terminalExplanation, "Execution failed.");
  assert.equal(result.entries[5]?.artifactId, fixtureId("artifact", 51));
  assert.equal(result.entries[6]?.terminalExplanation, "Passed without posting a message.");
  assert.ok(result.entries.every((entry) => entry.channelId === GROUP_CHANNEL));
});

test("conflicting canonical sources cap the watermark before the unresolved sequence", () => {
  const valid = observation(31, "started");
  const conflicting = {
    ...valid,
    observation: {
      ...valid.observation,
      sourceUpdatedAt: "2026-08-25T12:01:30.000Z",
    },
  };
  const duplicateEvent = event(32, {
    type: "unknown.additive",
    aggregate: { kind: "unknown", id: "unknown-32", version: 1 },
  });

  const result = projectActivity({
    sourceWindow: sourceWindow(30, 32),
    events: [duplicateEvent, duplicateEvent],
    messages: [],
    workObservations: [valid, conflicting],
    audience: audience(),
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.throughEventSequence, 30);
  assert.deepEqual(result.integrity, {
    status: "conflict",
    conflictAtEventSequence: 31,
  });
});

test("a canonical Work terminal observation supersedes a result-message completion", () => {
  const message = resultMessage(33);
  const completion = observation(34, "completion", {
    channelId: fixtureId("channel", 21),
  });
  const result = projectActivity({
    sourceWindow: sourceWindow(32, 34),
    events: [event(33)],
    messages: [message],
    workObservations: [completion],
    audience: audience(),
  });

  assert.deepEqual(
    result.entries.filter((entry) => entry.workId === fixtureId("work", 82))
      .map((entry) => [entry.eventSequence, entry.category, entry.source.kind]),
    [[34, "completion", "work_observation"]],
  );
  assert.equal(result.entries[0]?.messageId, message.id);
});

test("a result authorized after Work terminal advances the merged Activity boundary", () => {
  const completion = observation(33, "completion", {
    channelId: fixtureId("channel", 21),
  });
  const message = resultMessage(34);
  const result = projectActivity({
    sourceWindow: sourceWindow(32, 34),
    events: [event(34)],
    messages: [message],
    workObservations: [completion],
    audience: audience(),
  });

  assert.deepEqual(result.integrity, { status: "complete" });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.eventSequence, 34);
  assert.equal(result.entries[0]?.source.kind, "work_observation");
  assert.equal(result.entries[0]?.messageId, message.id);
  assert.deepEqual(result.entries[0]?.interval, {
    firstEventSequence: 33,
    lastEventSequence: 34,
    startedAt: message.createdAt,
    endedAt: completion.event.createdAt,
  });
});

test("the same authoritative source version is idempotent across distinct delivery events", () => {
  const first = observation(35, "progress", {
    sourceVersion: "resident-version-7",
    observedAt: "2026-08-25T12:00:30.000Z",
    sourceUpdatedAt: "2026-08-25T12:00:30.000Z",
  });
  const repeated = observation(36, "progress", {
    sourceVersion: "resident-version-7",
    observedAt: "2026-08-25T12:00:30.000Z",
    sourceUpdatedAt: "2026-08-25T12:00:30.000Z",
  });

  const result = projectActivity({
    sourceWindow: sourceWindow(34, 36),
    events: [],
    messages: [],
    workObservations: [repeated, first],
    audience: audience(),
  });

  assert.deepEqual(result.entries.map((entry) => entry.eventSequence), [35]);
  assert.equal(result.throughEventSequence, 36);
  assert.deepEqual(result.integrity, { status: "complete" });
});

test("the locked safe presentation token uses observation time without exposing arbitrary summaries", () => {
  const observedAt = "2026-08-25T12:00:30.000Z";
  const canonical = observation(37, "progress", {
    observedAt,
    sourceUpdatedAt: "2026-08-25T12:00:28.000Z",
    safeSummary: "Checking one source.",
  });
  const delayed = {
    ...canonical,
    event: {
      ...canonical.event,
      createdAt: "2026-08-25T12:00:37.000Z",
    },
  };

  const result = projectActivity({
    sourceWindow: sourceWindow(36, 37),
    events: [],
    messages: [],
    workObservations: [delayed],
    audience: audience(),
  });

  assert.equal(result.entries[0]?.label, "Checking one source");
  assert.equal(result.entries[0]?.updatedAt, observedAt);
  assert.deepEqual(result.entries[0]?.interval, {
    firstEventSequence: 37,
    lastEventSequence: 37,
    startedAt: observedAt,
    endedAt: observedAt,
  });
});

test("a durable sequence gap caps the watermark while transient events never advance it", () => {
  const unknown = (sequence: number) => event(sequence, {
    type: "future.additive",
    aggregate: { kind: "future", id: `future-${sequence}`, version: 1 },
  });
  const gap = projectActivity({
    sourceWindow: sourceWindow(9, 12),
    events: [unknown(10), unknown(12)],
    messages: [],
    workObservations: [],
    audience: audience(),
  });
  const transient = projectActivity({
    sourceWindow: sourceWindow(18, 18),
    events: [event(19, {
      type: "message.delta",
      durability: "transient",
      aggregate: { kind: "message", id: fixtureId("message", 19), version: 1 },
    })],
    messages: [],
    workObservations: [],
    audience: audience(),
  });

  assert.deepEqual(gap.integrity, {
    status: "conflict",
    conflictAtEventSequence: 11,
  });
  assert.equal(gap.throughEventSequence, 10);
  assert.deepEqual(transient.integrity, { status: "complete" });
  assert.equal(transient.throughEventSequence, 18);
});

test("a Work cannot change its canonical Channel or actor binding", () => {
  const result = projectActivity({
    sourceWindow: sourceWindow(36, 38),
    events: [],
    messages: [],
    workObservations: [
      observation(37, "started"),
      observation(38, "progress", { channelId: fixtureId("channel", 21) }),
    ],
    audience: audience(),
  });

  assert.deepEqual(result.entries.map((entry) => entry.eventSequence), [37]);
  assert.equal(result.throughEventSequence, 37);
  assert.deepEqual(result.integrity, {
    status: "conflict",
    conflictAtEventSequence: 38,
  });
});

test("result Messages reconcile only with a compatible later Work completion", () => {
  const contradictoryMessage = resultMessage(39);
  const contradiction = projectActivity({
    sourceWindow: sourceWindow(38, 40),
    events: [event(39)],
    messages: [contradictoryMessage],
    workObservations: [observation(40, "completion", {
      channelId: fixtureId("channel", 21),
      terminalReason: "passed",
    })],
    audience: audience(),
  });
  assert.equal(contradiction.throughEventSequence, 39);
  assert.deepEqual(contradiction.integrity, {
    status: "conflict",
    conflictAtEventSequence: 40,
  });
  assert.equal(contradiction.entries[0]?.messageId, contradictoryMessage.id);

  const compatibleMessage = resultMessage(41);
  const compatible = projectActivity({
    sourceWindow: sourceWindow(40, 42),
    events: [event(41)],
    messages: [compatibleMessage],
    workObservations: [observation(42, "completion", {
      channelId: fixtureId("channel", 21),
      terminalReason: "completed",
    })],
    audience: audience(),
  });
  assert.deepEqual(compatible.integrity, { status: "complete" });
  assert.equal(compatible.entries.length, 1);
  assert.equal(compatible.entries[0]?.source.kind, "work_observation");
  assert.equal(compatible.entries[0]?.messageId, compatibleMessage.id);
});

test("facts beyond an earlier integrity conflict cannot rewrite the trusted prefix", () => {
  const message = resultMessage(9);
  const unpaired = observation(10, "started", {
    channelId: fixtureId("channel", 21),
  });
  const laterCompletion = observation(11, "completion", {
    channelId: fixtureId("channel", 21),
  });
  const result = projectActivity({
    sourceWindow: sourceWindow(8, 11),
    events: [event(9), unpaired.event],
    messages: [message],
    workObservations: [laterCompletion],
    audience: audience(),
  });

  assert.equal(result.throughEventSequence, 9);
  assert.deepEqual(result.integrity, {
    status: "conflict",
    conflictAtEventSequence: 10,
  });
  assert.equal(result.entries[0]?.messageId, message.id);
  assert.equal(result.entries[0]?.source.kind, "event");
});

test("a complete retained source window rejects a partition that omits its prior sequence", () => {
  const sliced = projectActivity({
    sourceWindow: sourceWindow(38, 40),
    events: [],
    messages: [],
    workObservations: [observation(40, "completion", {
      channelId: fixtureId("channel", 21),
    })],
    audience: audience(),
  });

  assert.deepEqual(sliced.entries, []);
  assert.equal(sliced.throughEventSequence, 38);
  assert.deepEqual(sliced.integrity, {
    status: "conflict",
    conflictAtEventSequence: 39,
  });
});

test("delayed observations keep sequence order with chronological interval bounds", () => {
  const laterSequenceEarlierTime = observation(44, "progress", {
    observedAt: "2026-08-25T12:00:25.000Z",
    sourceUpdatedAt: "2026-08-25T12:00:25.000Z",
  });
  const progress = projectActivity({
    sourceWindow: sourceWindow(42, 44),
    events: [],
    messages: [],
    workObservations: [
      eventlessObservation(43, "2026-08-25T12:00:30.000Z"),
      laterSequenceEarlierTime,
    ],
    audience: audience(),
  });
  assert.deepEqual(progress.entries[0]?.interval, {
    firstEventSequence: 43,
    lastEventSequence: 44,
    startedAt: "2026-08-25T12:00:25.000Z",
    endedAt: "2026-08-25T12:00:30.000Z",
  });

  const message = resultMessage(45);
  const completion = observation(46, "completion", {
    channelId: fixtureId("channel", 21),
    observedAt: "2026-08-25T12:00:20.000Z",
    sourceUpdatedAt: "2026-08-25T12:00:20.000Z",
  });
  const delayedCompletion = {
    ...completion,
    event: { ...completion.event, createdAt: "2026-08-25T12:00:46.000Z" },
  };
  const reconciled = projectActivity({
    sourceWindow: sourceWindow(44, 46),
    events: [event(45)],
    messages: [message],
    workObservations: [delayedCompletion],
    audience: audience(),
  });
  assert.deepEqual(reconciled.entries[0]?.interval, {
    firstEventSequence: 45,
    lastEventSequence: 46,
    startedAt: "2026-08-25T12:00:20.000Z",
    endedAt: "2026-08-25T12:00:45.000Z",
  });
});

function eventlessObservation(sequence: number, observedAt: string) {
  return observation(sequence, "progress", {
    observedAt,
    sourceUpdatedAt: observedAt,
  });
}
