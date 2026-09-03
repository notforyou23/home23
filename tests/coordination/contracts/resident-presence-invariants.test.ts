import assert from "node:assert/strict";
import test from "node:test";

import {
  loadCanonicalFixture,
  validateCanonicalFixture,
} from "../../../src/coordination/contracts/contract-pack.js";
import {
  RESIDENT_PRESENCE_PROJECTIONS,
  RESIDENT_PRESENCE_RESIDENTS,
  WORK_RESULT_IDEMPOTENCY_KEY_PREFIX,
  workResultIdempotencyKey,
} from "../../../src/coordination/contracts/resident-presence.js";
import { CONTRACT_SCOPE_REGISTRY } from "../../../src/coordination/schema/contract-registry.js";

const ADMISSION = "resident-presence-admission-while-work";
const ONE_RESULT = "resident-presence-one-result";
const CURSOR = "resident-presence-cursor-reconnect";
const PROJECTIONS = "resident-presence-projections";

const JERRY = "bot_0198d95f-6c00-7000-8000-000000000011";
const JERRY_CHANNEL = "chn_0198d95f-6c00-7000-8000-000000000021";
const JERRY_CONVERSATION = "cnv_0198d95f-6c00-7000-8000-000000000031";
const ORIGIN_MESSAGE = "msg_0198d95f-6c00-7000-8000-0000000000c1";
const ADMITTED_MESSAGE = "msg_0198d95f-6c00-7000-8000-0000000000c2";
const RESULT_MESSAGE = "msg_0198d95f-6c00-7000-8000-0000000000c4";
const WORK_ID = "wrk_0198d95f-6c00-7000-8000-0000000000d1";
const FOREGROUND_WORK_ID = "wrk_0198d95f-6c00-7000-8000-0000000000d5";
const OBSERVATION_ID = "obs_0198d95f-6c00-7000-8000-0000000000d9";
const RESULT_EVENT_ID = "evt_0198d95f-6c00-7000-8000-0000000000e4";

interface AdmissionFixture {
  residentBinding: string;
  parityResidentBindings: string[];
  channelId: string;
  conversationId: string;
  accountableResidentPrincipalId: string;
  activeWork: {
    id: string;
    originMessageId: string;
    targetPrincipalId: string;
    roundId: string | null;
    status: string;
    version: number;
  };
  attempt: { workId: string; fencingToken: number; status: string };
  lease: { fencingToken: number; status: string };
  originMessage: {
    id: string;
    kind: string;
    provenance: { roundId: string | null; workId: string | null };
  };
  admittedMessage: {
    id: string;
    kind: string;
    provenance: { roundId: string | null; workId: string | null };
  };
  workAfterAdmission: { id: string; status: string; version: number };
  foregroundWork: {
    id: string;
    originMessageId: string;
    targetPrincipalId: string;
    roundId: string | null;
    status: string;
    version: number;
  };
}

interface OneResultFixture {
  work: {
    id: string;
    originMessageId: string;
    targetPrincipalId: string;
    roundId: string | null;
    status: string;
    version: number;
  };
  resultMessage: {
    id: string;
    kind: string;
    replyToMessageId: string;
    provenance: { workId: string | null };
  };
  resultIdempotencyKey: string;
  replay: {
    idempotencyKey: string;
    outcome: string;
    messageId: string;
    duplicateConversationRow: boolean;
  };
  conversationResultCount: number;
  staleOfficeFence: {
    heldFencingToken: number;
    presentedFencingToken: number;
    decision: string;
  };
}

interface CursorFixture {
  resume: string;
  clientCursor: { throughSequence: number };
  events: Array<{ sequence: number; type: string }>;
  reconnect: {
    afterSequence: number;
    returnedSequences: number[];
    loss: boolean;
    duplication: boolean;
  };
  duplicate: { presentedSequence: number; decision: string };
  gap: { error: { code: string; details: { bootstrapRequired: boolean } } };
  staleOverwrite: string;
}

interface ProjectionFixture {
  conversation: { messages: Array<{ id: string; kind: string }>; excludes: string[] };
  activity: {
    entries: Array<{ key: string; workId: string; observationId: string | null }>;
    excludes: string[];
  };
  forensics: {
    canonicalEvents: Array<{ sequence: number; type: string }>;
    communicationEvents: Array<{ kind: string }>;
  };
  sharedAuthority: { workId: string; eventSequences: number[] };
}

test("a user Message is accepted while resident Work stays running", () => {
  assert.equal(validateCanonicalFixture(ADMISSION).valid, true);
  const fixture = loadCanonicalFixture(ADMISSION) as AdmissionFixture;

  assert.equal(fixture.residentBinding, "jerry");
  assert.deepEqual(fixture.parityResidentBindings, [...RESIDENT_PRESENCE_RESIDENTS]);
  assert.equal(fixture.channelId, JERRY_CHANNEL);
  assert.equal(fixture.conversationId, JERRY_CONVERSATION);
  assert.equal(fixture.accountableResidentPrincipalId, JERRY);

  assert.equal(fixture.originMessage.id, ORIGIN_MESSAGE);
  assert.equal(fixture.originMessage.kind, "text");
  assert.equal(fixture.originMessage.provenance.workId, null);
  assert.equal(fixture.originMessage.provenance.roundId, null);

  assert.equal(fixture.activeWork.id, WORK_ID);
  assert.equal(fixture.activeWork.originMessageId, ORIGIN_MESSAGE);
  assert.equal(fixture.activeWork.targetPrincipalId, JERRY);
  assert.equal(fixture.activeWork.roundId, null);
  assert.equal(fixture.activeWork.status, "running");
  assert.equal(fixture.attempt.workId, WORK_ID);
  assert.equal(fixture.attempt.status, "running");
  assert.ok(fixture.attempt.fencingToken >= 1);
  assert.equal(fixture.lease.status, "active");
  assert.equal(fixture.lease.fencingToken, fixture.attempt.fencingToken);

  assert.equal(fixture.admittedMessage.id, ADMITTED_MESSAGE);
  assert.equal(fixture.admittedMessage.kind, "text");
  assert.equal(fixture.admittedMessage.provenance.workId, null);
  assert.equal(fixture.admittedMessage.provenance.roundId, null);
  assert.notEqual(fixture.admittedMessage.id, fixture.originMessage.id);

  assert.equal(fixture.workAfterAdmission.id, WORK_ID);
  assert.equal(fixture.workAfterAdmission.status, "running");
  assert.equal(fixture.workAfterAdmission.version, fixture.activeWork.version);

  assert.equal(fixture.foregroundWork.id, FOREGROUND_WORK_ID);
  assert.equal(fixture.foregroundWork.originMessageId, ADMITTED_MESSAGE);
  assert.equal(fixture.foregroundWork.targetPrincipalId, JERRY);
  assert.equal(fixture.foregroundWork.roundId, null);
  assert.notEqual(fixture.foregroundWork.id, fixture.activeWork.id);
});

test("one terminal Work result is presented once under work-result idempotency", () => {
  assert.equal(validateCanonicalFixture(ONE_RESULT).valid, true);
  const fixture = loadCanonicalFixture(ONE_RESULT) as OneResultFixture;
  const expectedKey = workResultIdempotencyKey(WORK_ID);

  assert.equal(WORK_RESULT_IDEMPOTENCY_KEY_PREFIX, "work-result:");
  assert.equal(expectedKey, `work-result:${WORK_ID}`);
  assert.equal(fixture.work.id, WORK_ID);
  assert.equal(fixture.work.originMessageId, ORIGIN_MESSAGE);
  assert.equal(fixture.work.targetPrincipalId, JERRY);
  assert.equal(fixture.work.roundId, null);
  assert.equal(fixture.work.status, "succeeded");

  assert.equal(fixture.resultMessage.id, RESULT_MESSAGE);
  assert.equal(fixture.resultMessage.kind, "result");
  assert.equal(fixture.resultMessage.replyToMessageId, ORIGIN_MESSAGE);
  assert.equal(fixture.resultMessage.provenance.workId, WORK_ID);

  assert.equal(fixture.resultIdempotencyKey, expectedKey);
  assert.equal(fixture.replay.idempotencyKey, expectedKey);
  assert.equal(fixture.replay.outcome, "replayed");
  assert.equal(fixture.replay.messageId, RESULT_MESSAGE);
  assert.equal(fixture.replay.duplicateConversationRow, false);
  assert.equal(fixture.conversationResultCount, 1);

  assert.ok(fixture.staleOfficeFence.presentedFencingToken < fixture.staleOfficeFence.heldFencingToken);
  assert.equal(fixture.staleOfficeFence.decision, "stale_fence");
});

test("clients reconnect from a cursor without loss, duplication, or stale overwrite", () => {
  assert.equal(validateCanonicalFixture(CURSOR).valid, true);
  const fixture = loadCanonicalFixture(CURSOR) as CursorFixture;

  assert.equal(fixture.resume, "strictly_after");
  assert.equal(fixture.staleOverwrite, "prohibited");
  assert.equal(fixture.reconnect.afterSequence, fixture.clientCursor.throughSequence);
  assert.equal(fixture.reconnect.loss, false);
  assert.equal(fixture.reconnect.duplication, false);
  assert.deepEqual(
    fixture.reconnect.returnedSequences,
    fixture.events
      .filter((event) => event.sequence > fixture.clientCursor.throughSequence)
      .map((event) => event.sequence),
  );
  assert.ok(fixture.duplicate.presentedSequence <= fixture.clientCursor.throughSequence);
  assert.equal(fixture.duplicate.decision, "duplicate");
  assert.equal(fixture.gap.error.code, "cursor_expired");
  assert.equal(fixture.gap.error.details.bootstrapRequired, true);
});

test("Conversation, Activity, and Forensics stay separate projections", () => {
  assert.equal(validateCanonicalFixture(PROJECTIONS).valid, true);
  const fixture = loadCanonicalFixture(PROJECTIONS) as ProjectionFixture;

  assert.deepEqual(RESIDENT_PRESENCE_PROJECTIONS, [
    "conversation",
    "activity",
    "forensics",
  ]);
  assert.ok(fixture.conversation.messages.some((message) => message.id === ADMITTED_MESSAGE));
  assert.ok(fixture.conversation.messages.some((message) => message.id === RESULT_MESSAGE && message.kind === "result"));
  assert.deepEqual(fixture.conversation.excludes, [
    "attempt",
    "lease",
    "workObservation",
    "communicationEvidence",
  ]);
  assert.ok(fixture.activity.entries.every((entry) => entry.workId === WORK_ID));
  assert.deepEqual(fixture.activity.entries.map((entry) => entry.key), [
    `work:${OBSERVATION_ID}:progress`,
    `event:${RESULT_EVENT_ID}:completion`,
  ]);
  assert.equal(fixture.activity.entries[0]?.observationId, OBSERVATION_ID);
  assert.equal(fixture.activity.entries[1]?.observationId, null);
  assert.deepEqual(fixture.activity.excludes, ["messageBodiesAsAuthority"]);
  const calendarAnswer = fixture.conversation.messages.find((message) => message.id === "msg_0198d95f-6c00-7000-8000-0000000000c3");
  assert.equal(
    (calendarAnswer as { provenance?: { workId?: string } } | undefined)?.provenance?.workId,
    FOREGROUND_WORK_ID,
  );
  assert.ok(fixture.forensics.canonicalEvents.length >= 1);
  assert.ok(fixture.forensics.communicationEvents.some((event) => event.kind === "user_message_committed"));
  assert.ok(fixture.forensics.communicationEvents.some((event) => event.kind === "assistant_message_committed"));
  assert.equal(fixture.sharedAuthority.workId, WORK_ID);
  assert.ok(fixture.sharedAuthority.eventSequences.length >= 1);
});

test("registry scope names the same resident-presence invariants for Jerry and Forrest", () => {
  const scope = CONTRACT_SCOPE_REGISTRY as {
    residentPresence?: {
      messageAdmission: string;
      workOwnership: string;
      residents: string[];
      projections: string[];
      terminalResult: { kind: string; idempotencyKey: string };
    };
  };
  assert.deepEqual(scope.residentPresence?.residents, [...RESIDENT_PRESENCE_RESIDENTS]);
  assert.equal(scope.residentPresence?.messageAdmission, "independent_of_active_work");
  assert.equal(scope.residentPresence?.workOwnership, "never_blocks_conversational_admission");
  assert.deepEqual(scope.residentPresence?.projections, [...RESIDENT_PRESENCE_PROJECTIONS]);
  assert.equal(scope.residentPresence?.terminalResult.kind, "result");
  assert.equal(scope.residentPresence?.terminalResult.idempotencyKey, "work-result:${workId}");
});
