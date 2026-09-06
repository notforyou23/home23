const assert = require("node:assert/strict");
const test = require("node:test");

const Inspector = require("../../engine/src/dashboard/connected-agents-inspector.js");

function event(id, sequence, kind, options = {}) {
  return {
    schemaVersion: 1,
    eventId: `cevt_${id}`,
    eventSequence: sequence,
    conversationId: "cnv_0198d95f-6c00-7000-8000-000000000001",
    channelId: "chn_0198d95f-6c00-7000-8000-000000000001",
    messageId: options.messageId || null,
    workId: options.workId || "wrk_0198d95f-6c00-7000-8000-000000000001",
    attemptId: options.attemptId || "att_0198d95f-6c00-7000-8000-000000000001",
    turnId: options.turnId || "turn_1",
    parentEventId: options.parentEventId || null,
    actor: { principalId: "bot_fixture", displayName: "Jerry", kind: "resident_bot" },
    source: {
      system: "provider",
      provider: "openai-codex",
      model: "gpt-5.6",
      sourceEventType: options.sourceEventType || null,
      ...(options.source || {}),
    },
    kind,
    provenance: options.provenance || null,
    occurredAt: `2026-08-27T12:00:0${sequence}.000Z`,
    payload: options.payload || {},
    terminal: options.terminal === true,
    ...(options.additional || {}),
  };
}

test("projection orders replay, retains exact unknown evidence, nesting, and deterministic export", () => {
  const store = new Inspector.EvidenceStore();
  const reasoning = event("reasoning", 2, "reasoning", {
    provenance: "provider_verbatim_reasoning",
    payload: {
      text: "Exact reasoning\n/private/fixture token-shaped-value-stays-exact",
      unknownNested: { z: 1, a: "x".repeat(2_000) },
    },
    additional: { futureEnvelope: { retained: true } },
  });
  const tool = event("tool", 3, "tool_call_started", {
    parentEventId: reasoning.eventId,
    payload: {
      toolCallId: "call_exact",
      arguments: {
        path: "/private/fixture/file.txt",
        authorization: "Bearer exact-fixture-value",
      },
    },
  });
  const status = event("status", 1, "status", {
    payload: { status: "streaming", requestedEffort: "high" },
  });

  assert.equal(store.ingest(tool), "inserted");
  assert.equal(store.ingest(reasoning), "inserted");
  assert.equal(store.ingest(status), "inserted");
  assert.deepEqual(store.eventsForTurn("turn_1").map((x) => x.eventId), [
    status.eventId,
    reasoning.eventId,
    tool.eventId,
  ]);
  assert.equal(Inspector.eventDepth(tool, store.eventsForTurn("turn_1")), 1);
  assert.equal(Inspector.eventLabel(reasoning), "Provider reasoning — verbatim");
  const exported = JSON.parse(store.exportFullEvidence("turn_1"));
  assert.equal(exported.events[1].futureEnvelope.retained, true);
  assert.equal(exported.events[2].payload.arguments.authorization, "Bearer exact-fixture-value");
  assert.equal(exported.events[2].payload.arguments.path, "/private/fixture/file.txt");
  assert.deepEqual(exported.integrityConflicts, []);
});

test("quick glance is calm metadata and terminal receipt uses actual resident selection", () => {
  const store = new Inspector.EvidenceStore();
  [
    event("status", 1, "status", {
      payload: {
        status: "running",
        requestedEffort: "low",
        requestedModel: "alias-fast",
        resolvedEffort: "medium",
      },
    }),
    event("reasoning", 2, "reasoning", { provenance: "provider_reasoning_summary" }),
    event("tool", 3, "tool_call_started", { payload: { toolCallId: "call_1" } }),
    event("tool-progress", 4, "tool_call_progress", { payload: { toolCallId: "call_1" } }),
    event("worker", 5, "worker_started"),
    event("artifact", 6, "artifact"),
    event("receipt", 7, "receipt", {
      payload: { status: "succeeded" },
      source: { reasoningEffort: "max" },
      terminal: true,
    }),
  ].forEach((value) => store.ingest(value));

  const turn = store.turn("turn_1");
  assert.deepEqual(turn.quickGlance, {
    status: "succeeded",
    model: "gpt-5.6",
    effort: "max",
    eventCount: 7,
    reasoningEventCount: 1,
    toolCallCount: 1,
    agentAndWorkerCount: 1,
    artifactAndMediaCount: 1,
    hasAttention: false,
    latestEventSequence: 7,
  });
  assert.equal(turn.terminal, true);
  assert.deepEqual(Inspector.selectionReceipt(turn), {
    actor: "Jerry",
    attemptId: "att_0198d95f-6c00-7000-8000-000000000001",
    requestedProvider: null,
    requestedModel: "alias-fast",
    requestedEffort: "low",
    resolvedProvider: null,
    resolvedModel: null,
    resolvedEffort: "medium",
    actualProvider: "openai-codex",
    actualModel: "gpt-5.6",
    actualEffort: "max",
  });
});

test("conflicting duplicate stays exported and raises a non-color attention cue", () => {
  const store = new Inspector.EvidenceStore();
  const first = event("same", 1, "tool_call_completed", {
    payload: { result: "first exact result" },
  });
  const conflict = event("same", 1, "tool_call_completed", {
    payload: { result: "different exact result" },
  });
  assert.equal(store.ingest(first), "inserted");
  assert.equal(store.ingest(first), "duplicate");
  assert.equal(store.ingest(conflict), "conflicting_duplicate");
  assert.equal(store.turn("turn_1").quickGlance.hasAttention, true);
  const exported = JSON.parse(store.exportFullEvidence("turn_1"));
  assert.equal(exported.events[0].payload.result, "first exact result");
  assert.equal(exported.integrityConflicts[0].incoming.payload.result, "different exact result");
});

test("historical selection cannot be stolen and live following counts exact unseen events", () => {
  let state = Inspector.createPresentation({ liveTurnId: "turn_live" });
  state = Inspector.openTurn(state, "turn_history", "cevt_history");
  state = Inspector.observeEvent(state, event("live-1", 10, "status", { turnId: "turn_live" }));
  assert.equal(state.selectedTurnId, "turn_history");
  assert.equal(state.selectedEventId, "cevt_history");
  assert.equal(state.unseenEventCount, 1);

  state = Inspector.openLive(state, "turn_live");
  state = Inspector.observeEvent(state, event("live-2", 11, "status", { turnId: "turn_live" }));
  assert.equal(state.selectedEventId, "cevt_live-2");
  state = Inspector.pauseFollowing(state);
  state = Inspector.observeEvent(state, event("live-3", 12, "status", { turnId: "turn_live" }));
  state = Inspector.observeEvent(state, event("live-4", 13, "status", { turnId: "turn_live" }));
  assert.equal(state.selectedEventId, "cevt_live-2");
  assert.equal(state.unseenEventCount, 2);
  state = Inspector.jumpToLive(state);
  assert.equal(state.followsLive, true);
  assert.equal(state.unseenEventCount, 0);
});

test("unknown kinds remain generic, filters are exact, and compact export excludes evidence", () => {
  const unknown = event("future", 1, "future_trace", {
    provenance: "provider_future_reasoning",
    payload: { providerValue: "exact" },
  });
  assert.equal(Inspector.eventLabel(unknown), "Event — future_trace");
  assert.equal(Inspector.includesFilter(unknown, "all"), true);
  assert.equal(Inspector.includesFilter(unknown, "reasoning"), false);
  assert.equal(
    Inspector.eventLabel(event("unclassified", 2, "reasoning")),
    "Unclassified reasoning event",
  );
  const compact = Inspector.compactConversation(
    { title: "Jerry" },
    [{
      author: { kind: "owner" },
      createdAt: "2026-08-27T12:00:00Z",
      text: "hello",
      attachments: [{ name: "a.txt", contentType: "text/plain", byteCount: 3 }],
    }],
  );
  assert.match(compact, /^# Jerry/m);
  assert.match(compact, /Attachment: a\.txt/);
  assert.doesNotMatch(compact, /providerValue|future_trace/);
});

test("history boundaries advance only for ordered in-scope evidence and reset with an explicit gap", () => {
  const first = event("first", 4, "status");
  const second = event("second", 9, "receipt", { terminal: true });
  const page = {
    kind: "events",
    events: [first, second],
    throughSequence: 12,
    currentSequence: 12,
    retentionFloorSequence: 1,
    hasMore: false,
  };
  assert.equal(
    Inspector.advanceHistoryCursor(3, page, first.conversationId),
    12,
  );
  assert.throws(
    () => Inspector.advanceHistoryCursor(3, { ...page, events: [second, first] }, first.conversationId),
    /out of order/,
  );
  assert.throws(
    () => Inspector.advanceHistoryCursor(3, {
      ...page,
      events: [{ ...first, conversationId: "cnv_wrong" }],
    }, first.conversationId),
    /out of order or out of scope/,
  );
  assert.throws(
    () => Inspector.advanceHistoryCursor(3, { ...page, events: [], hasMore: true }, first.conversationId),
    /cannot advance/,
  );
  assert.deepEqual(
    Inspector.cursorReset({
      bootstrapRequired: true,
      requestedAfterSequence: 2,
      retentionFloorSequence: 7,
      currentSequence: 20,
      reason: "cursor_expired",
    }, 2),
    {
      reason: "cursor_expired",
      requestedAfterSequence: 2,
      retentionFloorSequence: 7,
      currentSequence: 20,
      resumeAfterSequence: 6,
    },
  );
});
