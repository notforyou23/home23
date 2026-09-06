import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivityCursorCodec,
  compactActivity,
  normalizeActivityPageLimit,
  pageActivity,
  projectActivity,
} from "../../../src/coordination/activity/index.js";
import {
  DIRECT_CHANNEL,
  GROUP_CHANNEL,
  JERRY,
  OWNER,
  audience,
  observation,
  sourceWindow,
} from "./fixtures.js";

test("Activity pages use exclusive scoped boundaries and bounded limits", () => {
  const projection = projectActivity({
    sourceWindow: sourceWindow(52, 57),
    events: [],
    messages: [],
    workObservations: [
      observation(53, "started"),
      observation(54, "waiting"),
      observation(55, "retry"),
      observation(56, "failure"),
      observation(57, "started", { channelId: DIRECT_CHANNEL }),
    ],
    audience: audience(),
  });
  const scope = { kind: "channel" as const, channelId: GROUP_CHANNEL };

  const first = pageActivity(projection.entries, { after: null, limit: 2, scope });
  assert.deepEqual(first.entries.map((entry) => entry.eventSequence), [53, 54]);
  assert.deepEqual(first.nextBoundary, {
    eventSequence: 54,
    key: first.entries[1]?.key,
  });

  const second = pageActivity(projection.entries, {
    after: first.nextBoundary,
    limit: 2,
    scope,
  });
  assert.deepEqual(second.entries.map((entry) => entry.eventSequence), [55, 56]);
  assert.equal(second.nextBoundary, null);
  assert.equal(second.entries.some((entry) => entry.channelId === DIRECT_CHANNEL), false);

  assert.equal(normalizeActivityPageLimit(undefined), 50);
  assert.equal(normalizeActivityPageLimit(100), 100);
  assert.throws(() => normalizeActivityPageLimit(0), /activity page limit/);
  assert.throws(() => normalizeActivityPageLimit(101), /activity page limit/);
});

test("signed Activity cursors bind the boundary to viewer, route, scope, and direction", () => {
  const projection = projectActivity({
    sourceWindow: sourceWindow(57, 58),
    events: [],
    messages: [],
    workObservations: [observation(58, "started")],
    audience: audience(),
  });
  const entry = projection.entries[0]!;
  const codec = new ActivityCursorCodec(Buffer.alloc(32, 0x23));
  const scope = { kind: "channel" as const, channelId: GROUP_CHANNEL };
  const cursor = codec.encode(
    { eventSequence: entry.eventSequence, key: entry.key },
    OWNER,
    scope,
  );

  assert.deepEqual(codec.decode(cursor, OWNER, scope), {
    eventSequence: entry.eventSequence,
    key: entry.key,
  });
  assert.throws(() => codec.decode(cursor, JERRY, scope), /activity cursor is invalid/);
  assert.throws(
    () => codec.decode(`${cursor.slice(0, -1)}x`, OWNER, scope),
    /activity cursor is invalid/,
  );
});

test("30-day compaction summarizes only aged same-authority progress and retains terminal explanation", () => {
  const old = (seconds: number) => `2026-07-20T12:00:${String(seconds).padStart(2, "0")}.000Z`;
  const firstProgress = observation(59, "progress", {
    observedAt: old(1), sourceUpdatedAt: old(1), safeSummary: "First noisy update.",
  });
  const secondProgress = observation(60, "progress", {
    observedAt: old(3), sourceUpdatedAt: old(3), safeSummary: "Second noisy update.",
  });
  const failure = observation(61, "failure", {
    observedAt: old(4), sourceUpdatedAt: old(4), terminalReason: "deadline_exceeded",
  });
  const source = projectActivity({
    sourceWindow: sourceWindow(58, 62),
    events: [],
    messages: [],
    workObservations: [
      firstProgress,
      observation(62, "retry", { observedAt: old(2), sourceUpdatedAt: old(2) }),
      secondProgress,
      failure,
    ],
    audience: audience(),
  }).entries;
  const snapshot = JSON.stringify(source);

  const compacted = compactActivity(source, "2026-08-25T12:00:00.000Z");

  assert.deepEqual(
    compacted.map((entry) => [
      entry.eventSequence,
      entry.category,
      entry.label,
      entry.compacted,
      entry.collapsedCount,
    ]),
    [
      [60, "progress", "2 progress updates", true, 2],
      [61, "failure", "Failed", false, 1],
      [62, "retry", "Retry scheduled", false, 1],
    ],
  );
  assert.equal(compacted[1]?.terminalExplanation, "Stopped at the deadline.");
  assert.equal(JSON.stringify(source), snapshot, "source projection was mutated");
  assert.deepEqual(compactActivity(compacted, "2026-08-25T12:00:00.000Z"), compacted);
});

test("compaction never combines progress from distinct authority lineages", () => {
  const old = "2026-07-20T12:00:00.000Z";
  const source = projectActivity({
    sourceWindow: sourceWindow(62, 64),
    events: [],
    messages: [],
    workObservations: [
      observation(63, "progress", {
        observedAt: old,
        sourceUpdatedAt: old,
        authorityId: "resident-turn-a",
        sourceVersion: "1",
      }),
      observation(64, "progress", {
        observedAt: "2026-07-20T12:00:01.000Z",
        sourceUpdatedAt: "2026-07-20T12:00:01.000Z",
        authorityId: "resident-turn-b",
        sourceVersion: "1",
      }),
    ],
    audience: audience(),
  }).entries;

  const compacted = compactActivity(source, "2026-08-25T12:00:00.000Z");
  assert.equal(compacted.length, 2);
  assert.deepEqual(compacted.map((entry) => entry.source.authorityId), [
    "resident-turn-a",
    "resident-turn-b",
  ]);
});

test("an entry exactly 30 days old remains detailed until it is older than the boundary", () => {
  const boundary = observation(65, "progress", {
    observedAt: "2026-07-26T12:00:00.000Z",
    sourceUpdatedAt: "2026-07-26T12:00:00.000Z",
  });
  const source = projectActivity({
    sourceWindow: sourceWindow(64, 65),
    events: [],
    messages: [],
    workObservations: [boundary],
    audience: audience(),
  }).entries;

  assert.equal(compactActivity(source, "2026-08-25T12:00:00.000Z")[0]?.compacted, false);
});

test("a delayed old observation cannot compact progress that also contains recent activity", () => {
  const source = projectActivity({
    sourceWindow: sourceWindow(65, 67),
    events: [],
    messages: [],
    workObservations: [
      observation(66, "progress", {
        observedAt: "2026-08-24T12:00:00.000Z",
        sourceUpdatedAt: "2026-08-24T12:00:00.000Z",
      }),
      observation(67, "progress", {
        observedAt: "2026-07-01T12:00:00.000Z",
        sourceUpdatedAt: "2026-07-01T12:00:00.000Z",
      }),
    ],
    audience: audience(),
  }).entries;

  assert.equal(source[0]?.updatedAt, "2026-07-01T12:00:00.000Z");
  assert.equal(source[0]?.interval.endedAt, "2026-08-24T12:00:00.000Z");
  assert.equal(compactActivity(source, "2026-08-25T12:00:00.000Z")[0]?.compacted, false);
});
