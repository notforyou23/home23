import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptTrustedM11ActivityFact,
  projectTrustedM11Activity,
  type TrustedM11ActivityFact,
} from "../../../src/coordination/activity/index.js";
import { audience, DIRECT_CHANNEL, event, fixtureId, JERRY, sourceWindow } from "./fixtures.js";

const WORK = fixtureId("work", 700);
const ATTEMPT = `att_${fixtureId("event", 701).slice(4)}`;

function trustedDependencies(throughEventSequence: number) {
  return {
    membership: {
      status: "available" as const,
      authentication: "authenticated" as const,
      authority: "trusted_m08_membership_snapshot" as const,
      snapshotVersion: 1,
      audience: audience(),
    },
    factAssembly: {
      status: "complete" as const,
      authority: "trusted_m11_fact_assembly" as const,
      throughEventSequence,
    },
  };
}

function fact(sequence: number, overrides: Partial<TrustedM11ActivityFact> = {}): TrustedM11ActivityFact {
  const state = overrides.observedState ?? "running";
  const durable = event(sequence, {
    type: "turn.updated",
    aggregate: { kind: "work", id: WORK, version: sequence },
    channelId: DIRECT_CHANNEL,
    actorPrincipalId: JERRY,
    payload: {
      workId: WORK,
      state,
      attemptId: ATTEMPT,
      attemptState: state,
      fencingToken: 7,
      reasonCode: overrides.terminalReasonCode ?? null,
    },
  });
  return {
    event: durable,
    sourceKind: "work_attempt",
    workId: WORK,
    workKind: "resident_turn",
    channelId: DIRECT_CHANNEL,
    actorPrincipalId: JERRY,
    attemptId: ATTEMPT,
    linkedRoundId: null,
    fencingToken: 7,
    authorityReference: "resident:turn-7",
    observedState: state,
    sourceUpdatedAt: durable.createdAt,
    freshness: "current",
    terminalReasonCode: null,
    artifactId: null,
    ...overrides,
  };
}

test("trusted M11 Work/Attempt facts retain order, fences, lineage, terminal explanations, and noise collapse", () => {
  const facts = [fact(1), fact(2), fact(3), fact(4, {
    observedState: "failed",
    terminalReasonCode: "deadline_exceeded",
  })];
  const result = projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 4),
    events: facts.map((value) => value.event),
    messages: [],
    facts,
    ...trustedDependencies(4),
  });
  assert.equal(result.kind, "projected");
  if (result.kind !== "projected") return;
  assert.deepEqual(result.projection.entries.map((entry) => entry.eventSequence), [3, 4]);
  assert.equal(result.projection.entries[0]?.collapsedCount, 3);
  assert.equal(result.projection.entries[0]?.source.authorityId, "resident:turn-7");
  assert.equal(result.projection.entries[1]?.terminalReason, "deadline_exceeded");
  assert.equal(result.projection.entries[1]?.terminalExplanation, "Stopped at the deadline.");
});

test("M11 adapter fails closed for a stale fence and a durable sequence gap", () => {
  const first = fact(1);
  const stale = fact(2, { fencingToken: 8 });
  assert.equal(adaptTrustedM11ActivityFact(stale), null);
  const result = projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 3),
    events: [first.event, stale.event],
    messages: [],
    facts: [first, stale],
    ...trustedDependencies(3),
  });
  assert.equal(result.kind, "projected");
  if (result.kind !== "projected") return;
  assert.deepEqual(result.projection.integrity, { status: "conflict", conflictAtEventSequence: 2 });
  assert.equal(result.projection.throughEventSequence, 1);
});

test("a queued Work without an Attempt preserves the explicit zero-fence seam", () => {
  const queued = fact(1, {
    attemptId: null,
    fencingToken: 0,
    observedState: "queued",
    event: event(1, {
      type: "turn.updated",
      aggregate: { kind: "work", id: WORK, version: 1 },
      channelId: DIRECT_CHANNEL,
      actorPrincipalId: JERRY,
      payload: { workId: WORK, state: "queued" },
    }),
  });
  const adapted = adaptTrustedM11ActivityFact(queued);
  assert.equal(adapted?.observation.observedState, "queued");
  assert.equal(adapted?.event.payload.category, "waiting");
});

test("processless Bot Work keeps bot_turn authority vocabulary through Activity", () => {
  const botAuthority = `bot:${fixtureId("bot", 705)}`;
  const specialist = fact(1, { workKind: "bot_turn", authorityReference: botAuthority });
  const adapted = adaptTrustedM11ActivityFact(specialist);
  assert.equal(adapted?.observation.authoritySystem, "bot_turn");
  const result = projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 1),
    events: [specialist.event],
    messages: [],
    facts: [specialist],
    ...trustedDependencies(1),
  });
  assert.equal(result.kind, "projected");
  if (result.kind === "projected") {
    assert.equal(result.projection.entries[0]?.source.authoritySystem, "bot_turn");
    assert.equal(result.projection.entries[0]?.source.authorityId, botAuthority);
  }
  assert.equal(adaptTrustedM11ActivityFact(fact(2, { workKind: "unknown_turn" })), null);
});

test("a queued Work can hand authority to its first fenced resident Attempt", () => {
  const outboxId = `obx_${fixtureId("event", 702).slice(4)}`;
  const queued = fact(1, {
    attemptId: null,
    fencingToken: 0,
    authorityReference: `work:${WORK}`,
    observedState: "queued",
    event: event(1, {
      type: "turn.updated",
      aggregate: { kind: "work", id: WORK, version: 1 },
      channelId: DIRECT_CHANNEL,
      actorPrincipalId: "user_owner",
      payload: { workId: WORK, state: "queued" },
    }),
  });
  const pending = fact(2, {
    sourceKind: "outbox",
    attemptId: null,
    fencingToken: 0,
    authorityReference: `outbox:${outboxId}`,
    observedState: "queued",
    event: event(2, {
      type: "activity.updated",
      aggregate: { kind: "outbox", id: outboxId, version: 1 },
      channelId: null,
      actorPrincipalId: null,
      payload: { outboxId, workId: WORK, state: "pending" },
    }),
  });
  const leased = fact(3, {
    observedState: "leased",
    authorityReference: "resident:jerry",
    event: event(3, {
      type: "turn.updated",
      aggregate: { kind: "work", id: WORK, version: 2 },
      channelId: DIRECT_CHANNEL,
      actorPrincipalId: JERRY,
      payload: {
        workId: WORK,
        state: "leased",
        attemptId: ATTEMPT,
        attemptState: "offered",
        fencingToken: 7,
      },
    }),
  });
  const result = projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 3),
    events: [queued.event, pending.event, leased.event],
    messages: [],
    facts: [queued, pending, leased],
    ...trustedDependencies(3),
  });
  assert.equal(result.kind, "projected");
  if (result.kind !== "projected") return;
  assert.deepEqual(result.projection.integrity, { status: "complete" });
  assert.deepEqual(
    result.projection.entries.map((entry) => [entry.eventSequence, entry.category]),
    [[1, "waiting"], [2, "waiting"], [3, "started"]],
  );
});

test("source versions remain unique across Works handled by the same resident", () => {
  const otherWork = fixtureId("work", 703);
  const otherAttempt = `att_${fixtureId("event", 704).slice(4)}`;
  const first = fact(1);
  const second = fact(2, {
    workId: otherWork,
    attemptId: otherAttempt,
    event: event(2, {
      type: "turn.updated",
      aggregate: { kind: "work", id: otherWork, version: 1 },
      channelId: DIRECT_CHANNEL,
      actorPrincipalId: JERRY,
      payload: {
        workId: otherWork,
        state: "running",
        attemptId: otherAttempt,
        attemptState: "running",
        fencingToken: 7,
      },
    }),
  });
  const firstAdapted = adaptTrustedM11ActivityFact(first);
  const secondAdapted = adaptTrustedM11ActivityFact(second);
  assert.notEqual(
    firstAdapted?.observation.sourceVersion,
    secondAdapted?.observation.sourceVersion,
  );
  const result = projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 2),
    events: [first.event, second.event],
    messages: [],
    facts: [first, second],
    ...trustedDependencies(2),
  });
  assert.equal(result.kind, "projected");
  if (result.kind !== "projected") return;
  assert.deepEqual(result.projection.integrity, { status: "complete" });
  assert.deepEqual(
    result.projection.entries.map((entry) => entry.workId).sort(),
    [WORK, otherWork].sort(),
  );
});

test("canonical event mismatches are not overwritten and canonical Work attribution stays stable", () => {
  const queued = fact(1, {
    attemptId: null,
    fencingToken: 0,
    observedState: "queued",
    event: event(1, {
      type: "turn.updated",
      aggregate: { kind: "work", id: WORK, version: 1 },
      channelId: DIRECT_CHANNEL,
      actorPrincipalId: "user_owner",
      payload: { workId: WORK, state: "queued" },
    }),
  });
  assert.equal(adaptTrustedM11ActivityFact(queued)?.binding.actorPrincipalId, JERRY);
  const tampered = { ...queued.event, payload: { ...queued.event.payload, state: "running" } };
  const result = projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 1), events: [tampered], messages: [], facts: [queued],
    ...trustedDependencies(1),
  });
  assert.equal(result.kind, "projected");
  if (result.kind === "projected") {
    assert.deepEqual(result.projection.integrity, { status: "conflict", conflictAtEventSequence: 1 });
  }
});

test("contradictory facts for one durable event fail closed", () => {
  const current = fact(1);
  const contradictory = { ...current, authorityReference: "resident:other-turn" };
  const result = projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 1), events: [current.event], messages: [],
    facts: [current, contradictory], ...trustedDependencies(1),
  });
  assert.equal(result.kind, "projected");
  if (result.kind === "projected") {
    assert.deepEqual(result.projection.integrity, { status: "conflict", conflictAtEventSequence: 1 });
  }
});

test("terminal facts cannot erase or rewrite the durable reason", () => {
  const terminal = fact(1, { observedState: "failed", terminalReasonCode: "deadline_exceeded" });
  assert.equal(adaptTrustedM11ActivityFact({ ...terminal, terminalReasonCode: null }), null);
  assert.equal(adaptTrustedM11ActivityFact({ ...terminal, terminalReasonCode: "source_unavailable" }), null);
});

test("canonical M11 cancellation codes stay generic unless owner causality is explicit", () => {
  const receipt = fact(1, { observedState: "cancelled", terminalReasonCode: "receipt_cancelled" });
  const generic = adaptTrustedM11ActivityFact(receipt);
  assert.equal(generic?.event.payload.terminalReason, "cancelled");
  const owner = fact(2, { observedState: "cancelled", terminalReasonCode: "owner_cancelled" });
  assert.equal(adaptTrustedM11ActivityFact(owner)?.event.payload.terminalReason, "cancelled_by_owner");
});

test("Outbox and linked Round facts adapt without trusting their public attribution", () => {
  const outboxId = `obx_${fixtureId("event", 810).slice(4)}`;
  const outbox = fact(1, {
    sourceKind: "outbox",
    attemptId: null,
    fencingToken: 0,
    event: event(1, {
      type: "activity.updated",
      aggregate: { kind: "outbox", id: outboxId, version: 2 },
      channelId: null,
      actorPrincipalId: null,
      payload: { outboxId, workId: WORK, state: "claimed" },
    }),
  });
  const roundId = fixtureId("round", 811);
  const round = fact(2, {
    sourceKind: "round",
    linkedRoundId: roundId,
    attemptId: null,
    fencingToken: 0,
    observedState: "succeeded",
    terminalReasonCode: "completed",
    event: event(2, {
      type: "turn.updated",
      aggregate: { kind: "round", id: roundId, version: 3 },
      payload: { roundId, state: "completed", reasonCode: "completed" },
    }),
  });
  const result = projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 2), events: [outbox.event, round.event], messages: [],
    facts: [outbox, round], ...trustedDependencies(2),
  });
  assert.equal(result.kind, "projected");
  if (result.kind !== "projected") return;
  assert.deepEqual(result.projection.entries.map((entry) => entry.category), ["progress", "completion"]);
});

test("membership absence keeps Activity capability off and nonmembers see no M11 facts", () => {
  const work = fact(1);
  assert.deepEqual(projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 1), events: [work.event], messages: [], facts: [work],
    membership: { status: "unavailable" },
    factAssembly: trustedDependencies(1).factAssembly,
  }), { kind: "capability_off", reason: "membership_unavailable" });
  const hidden = projectTrustedM11Activity({
    sourceWindow: sourceWindow(0, 1), events: [work.event], messages: [], facts: [work],
    ...trustedDependencies(1),
    membership: {
      ...trustedDependencies(1).membership,
      audience: audience(fixtureId("principal", 999), []),
    },
  });
  assert.equal(hidden.kind, "projected");
  if (hidden.kind === "projected") assert.deepEqual(hidden.projection.entries, []);
});

test("Activity remains off without authenticated M08 lineage or complete M11 assembly", () => {
  const work = fact(1);
  const base = {
    sourceWindow: sourceWindow(0, 1), events: [work.event], messages: [], facts: [work],
  };
  assert.deepEqual(projectTrustedM11Activity({
    ...base,
    membership: { status: "unavailable" },
    factAssembly: trustedDependencies(1).factAssembly,
  }), { kind: "capability_off", reason: "membership_unavailable" });
  assert.deepEqual(projectTrustedM11Activity({
    ...base,
    membership: trustedDependencies(1).membership,
    factAssembly: { status: "unavailable" },
  }), { kind: "capability_off", reason: "fact_assembly_unavailable" });
  assert.deepEqual(projectTrustedM11Activity({
    ...base,
    membership: trustedDependencies(1).membership,
    factAssembly: {
      status: "complete", authority: "trusted_m11_fact_assembly", throughEventSequence: 0,
    },
  }), { kind: "capability_off", reason: "fact_assembly_unavailable" });
});
