import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpecialistCompletionConsumer,
  type SpecialistCompletionConsumerOptions,
} from "../../../src/coordination/app/specialist-completion.js";
import { ResidentProtocolError, type JsonValue } from "../../../src/coordination/resident-protocol/index.js";
import type { MessageProjection } from "../../../src/coordination/messages/index.js";
import type { WorkRecord } from "../../../src/coordination/work/index.js";
import { LeaseError } from "../../../src/coordination/leases/index.js";

const suffix = "0198d95f-6c00-7000-8000-000000000881";
const parentWorkId = `wrk_${suffix}`;
const channelId = `chn_${suffix}`;
const conversationId = `cnv_${suffix}`;
const originMessageId = `msg_${suffix}`;
const principalId = `bot_${suffix}`;
const childWorkId = "aw_mf0abcd_1a2b";

const primaryMessage: MessageProjection = Object.freeze({
  id: `msg_${parentWorkId.slice(4)}`,
  channelId,
  conversationId,
  sequence: 8,
  author: Object.freeze({ principalId, kind: "bot", displayName: "Jerry" }),
  kind: "result",
  text: "I sent a specialist to finish this.",
  mentions: Object.freeze([]),
  attachments: Object.freeze([]),
  clientMessageId: null,
  replyToMessageId: originMessageId,
  tombstonesMessageId: null,
  provenance: Object.freeze({ roundId: null, workId: parentWorkId }),
  createdAt: "2026-09-03T12:00:02.000Z",
  visibility: "visible",
});

const parentWork: WorkRecord = Object.freeze({
  id: parentWorkId,
  principalId: "user_owner",
  targetPrincipalId: principalId,
  channelId,
  originMessageId,
  roundId: null,
  contextManifestId: `ctx_${suffix}`,
  kind: "resident_turn",
  idempotencyKeyDigest: "1".repeat(64),
  requestDigest: "2".repeat(64),
  state: "succeeded",
  currentAttemptId: `att_${suffix}`,
  nextFencingToken: 2,
  automaticOfferCount: 1,
  maxAutomaticOffers: 1,
  terminalReason: null,
  terminalReceiptDigest: "3".repeat(64),
  version: 4,
  createdAt: "2026-09-03T12:00:00.000Z",
  updatedAt: "2026-09-03T12:00:02.000Z",
  terminalAt: "2026-09-03T12:00:02.000Z",
});

function payload(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    parentWorkId,
    childWorkId,
    childKind: "subagent",
    childResultHandle: {
      type: "subagent_chat",
      chatId: `subagent:coordination:${channelId}:${parentWorkId}:1a2b`,
    },
    status: "completed",
    finishedAt: "2026-09-03T12:00:03.000Z",
    channelId,
    conversationId,
    originMessageId,
    attemptId: `att_${suffix}`,
    leaseId: `lse_${suffix}`,
    fencingToken: 1,
    targetPrincipalId: principalId,
    residentBinding: "jerry",
    residentInstanceId: "home23-jerry-harness",
    authorityReference: "resident:jerry",
    terminalEvidence: "[Sub-agent complete] specialist\n\nThe specialist found the clean answer.",
    terminalText: "The specialist found the clean answer.",
    artifacts: [],
    ...overrides,
  };
}

function fixture() {
  const sent: Parameters<SpecialistCompletionConsumerOptions["messages"]["sendMessage"]>[0][] = [];
  const committed = new Map<string, MessageProjection>();
  const recorded: MessageProjection[] = [];
  const terminalEvents: unknown[] = [];
  let released = 0;
  const validatedLeaseBindings: Record<string, unknown>[] = [];
  const options: SpecialistCompletionConsumerOptions = {
    work: { get: (workId) => workId === parentWorkId ? parentWork : null },
    leases: {
      assertCompleted: (binding) => {
        validatedLeaseBindings.push(binding);
        if (
          binding.attemptId !== `att_${suffix}` || binding.leaseId !== `lse_${suffix}` ||
          binding.fencingToken !== 1
        ) throw new LeaseError("stale_fence", "stale");
        return {
          work: parentWork,
          attempt: {
            id: binding.attemptId,
            holderPrincipalId: binding.holderPrincipalId,
            holderInstanceId: binding.holderInstanceId,
            authorityReference: "resident:jerry",
            fencingToken: binding.fencingToken,
          },
          lease: { id: binding.leaseId },
          receipt: {},
        };
      },
    },
    messages: {
      getMessage: async ({ messageId }) => messageId === primaryMessage.id
        ? primaryMessage
        : committed.get(messageId) ?? null,
      sendMessage: async (input) => {
        sent.push(input);
        const message: MessageProjection = Object.freeze({
          id: input.messageId,
          channelId: input.channelId,
          conversationId,
          sequence: 9,
          author: Object.freeze({
            principalId: input.authorPrincipalId,
            kind: "bot",
            displayName: "Jerry",
          }),
          kind: "result",
          text: input.text,
          mentions: Object.freeze([]),
          attachments: Object.freeze([]),
          clientMessageId: null,
          replyToMessageId: input.replyToMessageId,
          tombstonesMessageId: null,
          provenance: Object.freeze({ ...input.provenance }),
          createdAt: "2026-09-03T12:00:04.000Z",
          visibility: "visible",
        });
        committed.set(message.id, message);
        return {
          outcome: "committed" as const,
          message,
          receipt: { resourceVersion: 9, eventSequence: 19, requestId: `req_${suffix}`, correlationId: `cor_${suffix}` },
        };
      },
      listMessages: async () => ({ messages: Object.freeze([primaryMessage]) }),
    },
    communications: { append: (input) => { terminalEvents.push(input); } },
    directContext: {
      recover: async () => ({
        originMessageId,
        prepared: {
          channelId,
          conversationId,
          targetBotId: principalId,
          targetBotDisplayName: "Jerry",
          targetPrincipalId: principalId,
          residentBinding: "jerry",
          instruction: "Owner: question",
          historyBackfill: Object.freeze([]),
          attachments: Object.freeze([]),
          manifest: {} as never,
        },
      }),
    },
    resolveResident: (binding) => binding === "jerry" ? {
      serverInstanceId: "home23-jerry-harness",
      clientInstanceId: "home23-jerry-harness",
      keyVersion: 1,
      context: ({ principalId: actor, requestId, correlationId }) => ({
        principalId: actor,
        requestId,
        correlationId,
        identity: {
          kind: "resident",
          resident: {
            requestId,
            correlationId,
            credential: {
              residentSlug: "jerry",
              role: "resident",
              instanceId: "home23-jerry-harness",
              keyVersion: 1,
            },
          },
        },
      }),
    } : undefined,
    assertAuthority: () => undefined,
    recordMessage: async ({ message }) => { recorded.push(message); },
    beginWork: () => () => { released += 1; },
  };
  return {
    consume: createSpecialistCompletionConsumer(options), sent, recorded, terminalEvents,
    validatedLeaseBindings,
    released: () => released,
  };
}

const request = {
  signal: new AbortController().signal,
  credential: {
    residentSlug: "jerry",
    role: "resident" as const,
    instanceId: "home23-jerry-harness",
    keyVersion: 1,
  },
  requestId: `req_${suffix}`,
  correlationId: `cor_${suffix}`,
};

test("specialist completion rejects a signed resident that spoofs another destination", async () => {
  const state = fixture();
  await assert.rejects(
    state.consume(payload(), {
      ...request,
      credential: { ...request.credential, residentSlug: "forrest" },
    }),
    (error: unknown) => error instanceof ResidentProtocolError && error.code === "fence_invalid",
  );
  assert.equal(state.sent.length, 0);
  assert.equal(state.recorded.length, 0);
  assert.equal(state.released(), 1);
});

test("specialist completion rejects the stale spawning Attempt", async () => {
  const state = fixture();
  await assert.rejects(
    state.consume(payload({ fencingToken: 2 }), request),
    (error: unknown) => error instanceof ResidentProtocolError && error.code === "fence_invalid",
  );
  assert.equal(state.sent.length, 0);
  assert.equal(state.terminalEvents.length, 0);
});

test("specialist completion validates the exact Core Lease binding shape", async () => {
  const state = fixture();
  await state.consume(payload(), request);
  assert.deepEqual(
    Object.keys(state.validatedLeaseBindings[0]!).sort(),
    [
      "attemptId", "correlationId", "fencingToken", "holderInstanceId",
      "holderPrincipalId", "leaseId", "requestId", "workId",
    ],
  );
});

test("failed specialist completion records Inspector evidence without a Message", async () => {
  const state = fixture();
  const result = await state.consume(payload({
    status: "failed",
    terminalEvidence: "[Sub-agent failed] specialist\n\nError: provider unavailable",
    terminalText: null,
  }), request) as Record<string, JsonValue>;
  assert.equal(result.messageId, null);
  assert.equal(state.sent.length, 0);
  assert.equal(state.recorded.length, 0);
  assert.equal(state.terminalEvents.length, 1);
  const terminal = state.terminalEvents[0] as {
    event: { kind: string; messageId: null; payload: { status: string; terminalEvidence: string } };
  };
  assert.equal(terminal.event.kind, "failure");
  assert.equal(terminal.event.messageId, null);
  assert.equal(terminal.event.payload.status, "failed");
  assert.match(terminal.event.payload.terminalEvidence, /provider unavailable/);
});

test("specialist completion retries the same canonical Message idempotently", async () => {
  const state = fixture();
  const first = await state.consume(payload(), request) as Record<string, JsonValue>;
  const replay = await state.consume(payload(), request) as Record<string, JsonValue>;

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0]!.idempotencyKey, `specialist-result:${parentWorkId}:${childWorkId}`);
  assert.deepEqual(state.sent[0]!.provenance, { roundId: null, workId: parentWorkId });
  assert.equal(state.sent[0]!.replyToMessageId, originMessageId);
  assert.equal(state.sent[0]!.text, "The specialist found the clean answer.");
  assert.equal(state.recorded.length, 2);
  assert.equal(state.terminalEvents.length, 2);
  const terminalEvents = state.terminalEvents as { event: { eventId: string } }[];
  assert.equal(terminalEvents[0]!.event.eventId, terminalEvents[1]!.event.eventId);
  assert.equal(state.released(), 2);
});
