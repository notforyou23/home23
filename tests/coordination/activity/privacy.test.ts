import assert from "node:assert/strict";
import test from "node:test";

import { projectActivity } from "../../../src/coordination/activity/index.js";
import {
  DIRECT_CHANNEL,
  JERRY,
  OUTSIDER,
  OWNER,
  PRIVATE_CHANNEL,
  audience,
  event,
  fixtureId,
  observation,
  resultMessage,
  sourceWindow,
} from "./fixtures.js";

test("Activity hides nonmember facts and stops before a canonical-binding conflict", () => {
  const privateObservation = observation(41, "started", { channelId: PRIVATE_CHANNEL });
  const memberSwap = observation(42, "started", {
    actorPrincipalId: JERRY,
    bindingActorPrincipalId: OUTSIDER,
  });
  const channelSwap = observation(43, "started", {
    bindingChannelId: DIRECT_CHANNEL,
  });
  const visible = observation(44, "started");

  const result = projectActivity({
    sourceWindow: sourceWindow(40, 44),
    events: [],
    messages: [],
    workObservations: [privateObservation, memberSwap, channelSwap, visible],
    audience: audience(),
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.throughEventSequence, 41);
  assert.deepEqual(result.integrity, {
    status: "conflict",
    conflictAtEventSequence: 42,
  });
});

test("free-form summaries, transcript, PII, reasoning, tools, paths, and secrets never surface", () => {
  const base = observation(45, "progress", {
    channelId: DIRECT_CHANNEL,
    safeSummary: "Alice has cancer and her SSN is 123-45-6789.",
  });
  const unsafeProgress = {
    ...base,
    observation: {
      ...base.observation,
      reasoning: "raw chain-of-thought",
      toolPayload: { command: "cat /Users/resident/private.txt", token: "secret-value" },
      residentTranscript: "private resident transcript",
    },
  };
  const message = resultMessage(46, { text: "SECRET PRIVATE TRANSCRIPT Bearer abc.def.ghi" });
  const canonicalEvent = event(46);
  const messageEvent = {
    ...canonicalEvent,
    payload: {
      ...canonicalEvent.payload,
      reasoning: "event chain-of-thought",
      toolArguments: { token: "event-secret" },
    },
  };

  const result = projectActivity({
    sourceWindow: sourceWindow(44, 46),
    events: [messageEvent],
    messages: [message],
    workObservations: [unsafeProgress],
    audience: audience(),
  });

  assert.deepEqual(result.entries.map((entry) => entry.label), ["Working", "Result posted"]);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "Alice",
    "123-45-6789",
    "raw chain-of-thought",
    "toolPayload",
    "private resident transcript",
    "PRIVATE TRANSCRIPT",
    "/Users/",
    "secret-value",
    "event-secret",
    "Bearer",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("unscoped artifact facts are visible only to their attributed principal", () => {
  const artifactId = fixtureId("artifact", 61);
  const readyEvent = event(47, {
    type: "attachment.updated",
    aggregate: { kind: "artifact", id: artifactId, version: 2 },
    channelId: null,
    actorPrincipalId: OWNER,
    payload: {
      artifactId,
      state: "ready",
      filesystemPath: "/Users/resident/private.txt",
      sha256: "a".repeat(64),
    },
  });

  const ownerResult = projectActivity({
    sourceWindow: sourceWindow(46, 47),
    events: [readyEvent],
    messages: [],
    workObservations: [],
    audience: audience(),
  });
  const botResult = projectActivity({
    sourceWindow: sourceWindow(46, 47),
    events: [readyEvent],
    messages: [],
    workObservations: [],
    audience: audience(JERRY),
  });

  assert.equal(ownerResult.entries[0]?.category, "artifact");
  assert.equal(ownerResult.entries[0]?.artifactId, artifactId);
  assert.equal(JSON.stringify(ownerResult).includes("/Users/"), false);
  assert.deepEqual(botResult.entries, []);
});

test("stale running observations become attention without erasing stale terminal truth", () => {
  const result = projectActivity({
    sourceWindow: sourceWindow(47, 49),
    events: [],
    messages: [],
    workObservations: [
      observation(48, "progress", { freshness: "stale" }),
      observation(49, "failure", {
        freshness: "stale",
        terminalReason: "deadline_exceeded",
      }),
    ],
    audience: audience(),
  });

  assert.deepEqual(
    result.entries.map(({ category, state, label, terminalExplanation }) => ({
      category,
      state,
      label,
      terminalExplanation,
    })),
    [
      { category: "waiting", state: "attention", label: "Status may be stale", terminalExplanation: null },
      { category: "failure", state: "failed", label: "Failed", terminalExplanation: "Stopped at the deadline." },
    ],
  );
});

test("cancelling and cancelled use stopping and idle semantics", () => {
  const result = projectActivity({
    sourceWindow: sourceWindow(49, 51),
    events: [],
    messages: [],
    workObservations: [
      observation(50, "waiting", { observedState: "cancelling" }),
      observation(51, "failure", {
        observedState: "cancelled",
        terminalReason: "cancelled_by_owner",
      }),
    ],
    audience: audience(),
  });

  assert.deepEqual(
    result.entries.map((entry) => [entry.category, entry.state, entry.label]),
    [
      ["waiting", "stopping", "Stopping"],
      ["completion", "idle", "Cancelled"],
    ],
  );
});

test("mismatched message provenance fails closed", () => {
  const message = resultMessage(52);
  const mismatched = event(52, {
    payload: { ...event(52).payload, workId: fixtureId("work", 99) },
  });
  const result = projectActivity({
    sourceWindow: sourceWindow(51, 52),
    events: [mismatched],
    messages: [message],
    workObservations: [],
    audience: audience(),
  });
  assert.deepEqual(result.entries, []);
  assert.equal(result.throughEventSequence, 51);
  assert.deepEqual(result.integrity, {
    status: "conflict",
    conflictAtEventSequence: 52,
  });
});

test("an unpaired activity event cannot advance the visible watermark", () => {
  const paired = observation(53, "started");
  const result = projectActivity({
    sourceWindow: sourceWindow(52, 53),
    events: [paired.event],
    messages: [],
    workObservations: [],
    audience: audience(),
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.throughEventSequence, 52);
  assert.deepEqual(result.integrity, {
    status: "conflict",
    conflictAtEventSequence: 53,
  });
});

test("an owner may expire a Bot-owned artifact without creating Activity or a conflict", () => {
  const artifactId = fixtureId("artifact", 62);
  const expiration = event(54, {
    type: "attachment.updated",
    aggregate: { kind: "artifact", id: artifactId, version: 3 },
    channelId: null,
    actorPrincipalId: OWNER,
    payload: {
      artifactId,
      state: "expired",
      ownerPrincipalId: JERRY,
    },
  });

  const result = projectActivity({
    sourceWindow: sourceWindow(53, 54),
    events: [expiration],
    messages: [],
    workObservations: [],
    audience: audience(),
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.throughEventSequence, 54);
  assert.deepEqual(result.integrity, { status: "complete" });
});
