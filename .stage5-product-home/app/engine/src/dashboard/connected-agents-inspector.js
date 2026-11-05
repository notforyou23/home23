(function exposeConnectedAgentsInspector(root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.ConnectedAgentsInspector = value;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  const ATTENTION_STATUSES = new Set([
    "failed",
    "cancelled",
    "expired",
    "error",
    "orphaned",
  ]);
  const TERMINAL_STATUSES = new Set([
    "succeeded",
    "complete",
    "completed",
    ...ATTENTION_STATUSES,
  ]);
  const FILTER_KINDS = Object.freeze({
    reasoning: new Set(["reasoning"]),
    tools: new Set([
      "tool_call_started",
      "tool_call_progress",
      "tool_call_completed",
    ]),
    agents: new Set([
      "subagent_started",
      "subagent_progress",
      "subagent_completed",
      "worker_started",
      "worker_progress",
      "worker_completed",
    ]),
    progress: new Set([
      "status",
      "assistant_response_delta",
      "stop_requested",
      "retry_requested",
      "cancel_requested",
    ]),
    errors: new Set(["failure"]),
    artifacts: new Set(["artifact", "media"]),
    usage: new Set(["usage", "cache"]),
    receipts: new Set([
      "user_message_committed",
      "assistant_message_committed",
      "receipt",
    ]),
  });

  function sortedValue(value) {
    if (Array.isArray(value)) return value.map(sortedValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sortedValue(value[key])]),
      );
    }
    return value;
  }

  function exactJSON(value, compact = false) {
    return JSON.stringify(sortedValue(value), null, compact ? 0 : 2);
  }

  function stringValue(value) {
    return typeof value === "string" && value.length ? value : null;
  }

  function eventString(event, keys) {
    const locations = [event.payload, event.source, event];
    for (const values of locations) {
      if (!values || typeof values !== "object") continue;
      for (const key of keys) {
        const value = stringValue(values[key]);
        if (value) return value;
      }
    }
    return null;
  }

  function ordered(events) {
    return [...events].sort((left, right) => {
      const sequence = Number(left.eventSequence) - Number(right.eventSequence);
      return sequence || String(left.eventId).localeCompare(String(right.eventId));
    });
  }

  function reasoningLabel(event) {
    if (event.kind !== "reasoning") return null;
    switch (event.provenance) {
      case "provider_verbatim_reasoning":
        return "Provider reasoning — verbatim";
      case "provider_reasoning_summary":
        return "Provider reasoning summary";
      case "agent_authored_explanation":
        return "Agent-authored explanation";
      default:
        return "Unclassified reasoning event";
    }
  }

  function eventLabel(event) {
    const reasoning = reasoningLabel(event);
    if (reasoning) return reasoning;
    return (
      {
        user_message_committed: "User message committed",
        assistant_response_delta: "Assistant response",
        assistant_message_committed: "Assistant message committed",
        tool_call_started: "Tool call started",
        tool_call_progress: "Tool call progress",
        tool_call_completed: "Tool call completed",
        subagent_started: "Agent started",
        subagent_progress: "Agent progress",
        subagent_completed: "Agent completed",
        worker_started: "Worker started",
        worker_progress: "Worker progress",
        worker_completed: "Worker completed",
        status: "Progress",
        usage: "Usage",
        cache: "Usage and cache",
        media: "Media",
        artifact: "Artifact",
        failure: "Error",
        receipt: "Receipt",
        stop_requested: "Stop requested",
        retry_requested: "Retry requested",
        cancel_requested: "Cancel requested",
      }[event.kind] || `Event — ${event.kind}`
    );
  }

  function eventSummary(event) {
    for (const key of ["text", "status", "message", "tool", "task", "delta", "preview"]) {
      const value = stringValue(event.payload?.[key]);
      if (value) return value;
    }
    return stringValue(event.source?.sourceEventType);
  }

  function eventDepth(event, events) {
    const byID = new Map(events.map((candidate) => [candidate.eventId, candidate]));
    const seen = new Set();
    let parent = event.parentEventId;
    let depth = 0;
    while (parent && !seen.has(parent) && byID.has(parent) && depth < 12) {
      seen.add(parent);
      depth += 1;
      parent = byID.get(parent).parentEventId;
    }
    return depth;
  }

  function includesFilter(event, filter) {
    return filter === "all" || Boolean(FILTER_KINDS[filter]?.has(event.kind));
  }

  function selectionReceipt(turn) {
    const receipt = {
      actor: "Unknown actor",
      attemptId: null,
      requestedProvider: null,
      requestedModel: null,
      requestedEffort: null,
      resolvedProvider: null,
      resolvedModel: null,
      resolvedEffort: null,
      actualProvider: null,
      actualModel: null,
      actualEffort: null,
    };
    for (const event of turn.events) {
      receipt.actor = stringValue(event.actor?.displayName) || receipt.actor;
      receipt.attemptId = stringValue(event.attemptId) || receipt.attemptId;
      receipt.requestedProvider =
        eventString(event, ["requestedProvider", "providerRequested"]) ||
        receipt.requestedProvider;
      receipt.requestedModel =
        eventString(event, [
          "requestedModel",
          "modelRequested",
          "requestedModelAlias",
        ]) || receipt.requestedModel;
      receipt.requestedEffort =
        eventString(event, [
          "requestedEffort",
          "reasoningEffortRequested",
        ]) || receipt.requestedEffort;
      receipt.resolvedProvider =
        eventString(event, ["resolvedProvider", "providerResolved"]) ||
        receipt.resolvedProvider;
      receipt.resolvedModel =
        eventString(event, ["resolvedModel", "modelResolved"]) ||
        receipt.resolvedModel;
      receipt.resolvedEffort =
        eventString(event, ["resolvedEffort", "reasoningEffortResolved"]) ||
        receipt.resolvedEffort;
      receipt.actualProvider =
        eventString(event, ["actualProvider", "providerActual"]) ||
        stringValue(event.source?.provider) ||
        receipt.actualProvider;
      receipt.actualModel =
        eventString(event, ["actualModel", "modelActual"]) ||
        stringValue(event.source?.model) ||
        receipt.actualModel;
      receipt.actualEffort =
        eventString(event, [
          "actualEffort",
          "reasoningEffortActual",
          "reasoningEffort",
        ]) || receipt.actualEffort;
    }
    return Object.freeze(receipt);
  }

  function quickGlance(events, conflicts = []) {
    const tools = new Set();
    let reasoningEventCount = 0;
    let agentAndWorkerCount = 0;
    let artifactAndMediaCount = 0;
    let hasAttention = false;
    let status = null;
    let model = null;
    let effort = null;
    for (const event of events) {
      model = stringValue(event.source?.model) || model;
      if (event.kind === "reasoning") reasoningEventCount += 1;
      if (event.kind === "tool_call_started") {
        tools.add(stringValue(event.payload?.toolCallId) || event.eventId);
      }
      if (["subagent_started", "worker_started"].includes(event.kind)) {
        agentAndWorkerCount += 1;
      }
      if (["artifact", "media"].includes(event.kind)) artifactAndMediaCount += 1;
      if (event.kind === "failure") hasAttention = true;
      if (["status", "receipt", "failure"].includes(event.kind)) {
        status = stringValue(event.payload?.status) || status;
      }
      const emittedStatus = stringValue(event.payload?.status);
      if (emittedStatus && ATTENTION_STATUSES.has(emittedStatus)) hasAttention = true;
      effort =
        stringValue(event.payload?.actualEffort) ||
        stringValue(event.payload?.resolvedEffort) ||
        stringValue(event.payload?.requestedEffort) ||
        stringValue(event.source?.reasoningEffort) ||
        effort;
    }
    if (conflicts.length) hasAttention = true;
    return Object.freeze({
      status,
      model,
      effort,
      eventCount: events.length,
      reasoningEventCount,
      toolCallCount: tools.size,
      agentAndWorkerCount,
      artifactAndMediaCount,
      hasAttention,
      latestEventSequence: events.at(-1)?.eventSequence ?? null,
    });
  }

  function terminalTurn(events, glance) {
    if (glance.status && TERMINAL_STATUSES.has(glance.status)) return true;
    return events.some(
      (event) =>
        event.terminal === true && ["receipt", "failure"].includes(event.kind),
    );
  }

  class EvidenceStore {
    constructor() {
      this.eventsByID = new Map();
      this.integrityConflicts = [];
    }

    ingest(event) {
      if (!event || typeof event !== "object" || !stringValue(event.eventId)) {
        throw new TypeError("communication event requires an eventId");
      }
      if (!Number.isSafeInteger(event.eventSequence) || event.eventSequence < 1) {
        throw new TypeError("communication event requires a positive safe sequence");
      }
      const existing = this.eventsByID.get(event.eventId);
      if (existing) {
        if (exactJSON(existing, true) === exactJSON(event, true)) return "duplicate";
        this.integrityConflicts.push(Object.freeze({ existing, incoming: event }));
        return "conflicting_duplicate";
      }
      this.eventsByID.set(event.eventId, event);
      return "inserted";
    }

    clear() {
      this.eventsByID.clear();
      this.integrityConflicts.length = 0;
    }

    allEvents() {
      return ordered(this.eventsByID.values());
    }

    eventsForTurn(turnId) {
      return ordered(
        [...this.eventsByID.values()].filter((event) => event.turnId === turnId),
      );
    }

    turns() {
      const grouped = new Map();
      for (const event of this.allEvents()) {
        const turnId = stringValue(event.turnId?.trim?.());
        if (!turnId) continue;
        if (!grouped.has(turnId)) grouped.set(turnId, []);
        grouped.get(turnId).push(event);
      }
      return [...grouped.entries()]
        .map(([turnId, events]) => {
          const conflicts = this.integrityConflicts.filter(
            (conflict) =>
              conflict.existing.turnId === turnId || conflict.incoming.turnId === turnId,
          );
          const glance = quickGlance(events, conflicts);
          return Object.freeze({
            turnId,
            events: Object.freeze(events),
            messageIds: Object.freeze([
              ...new Set(events.map((event) => event.messageId).filter(Boolean)),
            ]),
            workIds: Object.freeze([
              ...new Set(events.map((event) => event.workId).filter(Boolean)),
            ]),
            quickGlance: glance,
            firstSequence: events[0].eventSequence,
            terminalEvent:
              [...events]
                .reverse()
                .find((event) => ["receipt", "failure"].includes(event.kind)) || null,
            terminal: terminalTurn(events, glance),
          });
        })
        .sort(
          (left, right) =>
            left.firstSequence - right.firstSequence ||
            left.turnId.localeCompare(right.turnId),
        );
    }

    turn(turnId) {
      return this.turns().find((turn) => turn.turnId === turnId) || null;
    }

    liveTurn() {
      return [...this.turns()].reverse().find((turn) => !turn.terminal) || null;
    }

    exportFullEvidence(turnId) {
      const events = this.eventsForTurn(turnId);
      const integrityConflicts = this.integrityConflicts.filter(
        (conflict) =>
          conflict.existing.turnId === turnId || conflict.incoming.turnId === turnId,
      );
      return exactJSON({ events, integrityConflicts });
    }
  }

  function createPresentation(input = {}) {
    return Object.freeze({
      mode: input.mode || "quick_glance",
      selectedTurnId: input.selectedTurnId || null,
      selectedEventId: input.selectedEventId || null,
      liveTurnId: input.liveTurnId || null,
      followsLive: input.followsLive === true,
      unseenEventCount: Math.max(0, input.unseenEventCount || 0),
      lastViewedEventSequence: input.lastViewedEventSequence || null,
    });
  }

  function openTurn(state, turnId, eventId = null) {
    return createPresentation({
      ...state,
      mode: "selected_turn_detail",
      selectedTurnId: turnId,
      selectedEventId: eventId,
      followsLive: false,
      unseenEventCount: 0,
    });
  }

  function openLive(state, turnId) {
    return createPresentation({
      ...state,
      mode: "live_control_room",
      liveTurnId: turnId,
      selectedTurnId: turnId,
      selectedEventId: null,
      followsLive: true,
      unseenEventCount: 0,
    });
  }

  function minimize(state) {
    return createPresentation({ ...state, mode: "quick_glance", followsLive: false });
  }

  function setLiveTurn(state, turnId) {
    const next = { ...state, liveTurnId: turnId || null };
    if (state.mode !== "live_control_room" || !state.followsLive) {
      return createPresentation(next);
    }
    if (!turnId) return createPresentation({ ...next, followsLive: false });
    if (state.selectedTurnId !== turnId) {
      return createPresentation({
        ...next,
        selectedTurnId: turnId,
        selectedEventId: null,
        unseenEventCount: 0,
      });
    }
    return createPresentation(next);
  }

  function pauseFollowing(state) {
    return createPresentation({ ...state, followsLive: false });
  }

  function jumpToLive(state) {
    if (!state.liveTurnId) return state;
    return openLive(state, state.liveTurnId);
  }

  function observeEvent(state, event) {
    if (
      state.mode === "live_control_room" &&
      state.followsLive &&
      state.selectedTurnId === event.turnId
    ) {
      return createPresentation({
        ...state,
        selectedEventId: event.eventId,
        lastViewedEventSequence: event.eventSequence,
        unseenEventCount: 0,
      });
    }
    if (
      state.selectedTurnId === event.turnId ||
      state.liveTurnId === event.turnId
    ) {
      return createPresentation({
        ...state,
        unseenEventCount: state.unseenEventCount + 1,
      });
    }
    return state;
  }

  function markViewedThrough(state, sequence) {
    return createPresentation({
      ...state,
      lastViewedEventSequence: sequence,
      unseenEventCount: 0,
    });
  }

  function compactConversation(channel, messages) {
    const lines = [`# ${channel?.title || "Conversation"}`, ""];
    for (const message of messages || []) {
      const actor = message.author?.kind === "owner"
        ? "You"
        : message.author?.displayName || "Bot";
      lines.push(`## ${actor} — ${message.createdAt || "time unavailable"}`);
      lines.push("");
      lines.push(message.text || "");
      for (const attachment of message.attachments || []) {
        lines.push(
          `- Attachment: ${attachment.name || "Attachment"} (${attachment.contentType || "unknown type"}, ${attachment.byteCount ?? "unknown"} bytes)`,
        );
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  function cursorReset(details, requestedAfterSequence) {
    if (!details || details.bootstrapRequired !== true) {
      throw new TypeError("communication cursor reset requires bootstrap details");
    }
    const requested = details.requestedAfterSequence ?? requestedAfterSequence;
    const floor = details.retentionFloorSequence;
    const current = details.currentSequence;
    if (
      !Number.isSafeInteger(requested) || requested < 0 ||
      !Number.isSafeInteger(floor) || floor < 1 ||
      !Number.isSafeInteger(current) || current < 0 ||
      floor > current + 1
    ) {
      throw new TypeError("communication cursor reset boundaries are invalid");
    }
    return Object.freeze({
      reason: stringValue(details.reason) || "cursor_expired",
      requestedAfterSequence: requested,
      retentionFloorSequence: floor,
      currentSequence: current,
      resumeAfterSequence: Math.max(0, floor - 1),
    });
  }

  function advanceHistoryCursor(currentCursor, page, conversationId) {
    if (!Number.isSafeInteger(currentCursor) || currentCursor < 0) {
      throw new TypeError("current communication cursor is invalid");
    }
    if (!page || page.kind !== "events" || !Array.isArray(page.events)) {
      throw new TypeError("communication evidence page is invalid");
    }
    if (
      !Number.isSafeInteger(page.throughSequence) ||
      page.throughSequence < currentCursor ||
      !Number.isSafeInteger(page.currentSequence) ||
      page.currentSequence < page.throughSequence ||
      typeof page.hasMore !== "boolean"
    ) {
      throw new TypeError("communication evidence cursor boundary is invalid");
    }
    let prior = currentCursor;
    for (const event of page.events) {
      if (
        !Number.isSafeInteger(event?.eventSequence) ||
        event.eventSequence <= prior ||
        event.eventSequence > page.throughSequence ||
        (conversationId && event.conversationId !== conversationId)
      ) {
        throw new TypeError("communication evidence page is out of order or out of scope");
      }
      prior = event.eventSequence;
    }
    if (page.hasMore && page.events.length === 0) {
      throw new TypeError("communication evidence page cannot advance");
    }
    return page.throughSequence;
  }

  return Object.freeze({
    EvidenceStore,
    advanceHistoryCursor,
    compactConversation,
    createPresentation,
    cursorReset,
    eventDepth,
    eventLabel,
    eventSummary,
    exactJSON,
    includesFilter,
    jumpToLive,
    markViewedThrough,
    minimize,
    observeEvent,
    openLive,
    openTurn,
    pauseFollowing,
    reasoningLabel,
    selectionReceipt,
    setLiveTurn,
  });
});
