import type { CoordinationTurnOrigin } from "../../agent/types.js";
import { parseForegroundDetachmentRequest, type ForegroundDetachmentRequest } from "../../coordination-adapter/foreground-detachment-contract.js";
import { assertCoordinationId } from "../ids/index.js";

import {
  assertDigest,
  assertExactKeys,
  assertId,
  assertSafeReference,
  canonicalJson,
  canonicalTimestamp,
  sha256,
} from "./canonical.js";
import { WorkError } from "./errors.js";
import { assertM11Transition } from "./state-machines.js";
import type {
  ContextManifest,
  CancelQueuedWorkInput,
  CancelQueuedWorkResult,
  ContextManifestInput,
  CreateWorkInput,
  CreateWorkResult,
  CreateWorkServiceOptions,
  M11Database,
  QueuedCancellationReceipt,
  WorkRecord,
  WorkTurnSelection,
} from "./types.js";

interface WorkRow {
  id: string;
  principalId: string;
  targetPrincipalId: string;
  channelId: string;
  originMessageId: string | null;
  roundId: string | null;
  contextManifestId: string;
  kind: string;
  idempotencyKeyDigest: string;
  requestDigest: string;
  state: WorkRecord["state"];
  currentAttemptId: string | null;
  nextFencingToken: number;
  automaticOfferCount: number;
  maxAutomaticOffers: number;
  terminalReason: string | null;
  terminalReceiptDigest: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

interface ManifestRow {
  id: string;
  privacy: "channel_only";
  channelId: string;
  messageRefsJson: string;
  artifactRefsJson: string;
  messageCount: number;
  artifactCount: number;
  channelWatermark: number;
  eventWatermark: number;
  contextDigest: string;
  sourceDigest: string;
  createdAt: string;
}

interface QueuedCancellationReceiptRow {
  workId: string;
  attemptId: null;
  fencingToken: 0;
  status: "cancelled";
  sourceReference: string;
  resultDigest: null;
  artifactRefsJson: "[]";
  receiptDigest: string;
  createdAt: string;
}

const WORK_SELECT = `
SELECT id, principal_id AS principalId, target_principal_id AS targetPrincipalId,
       channel_id AS channelId, origin_message_id AS originMessageId,
       round_id AS roundId, context_manifest_id AS contextManifestId, kind,
       idempotency_key_digest AS idempotencyKeyDigest, request_digest AS requestDigest,
       state, current_attempt_id AS currentAttemptId,
       next_fencing_token AS nextFencingToken,
       automatic_offer_count AS automaticOfferCount,
       max_automatic_offers AS maxAutomaticOffers, terminal_reason AS terminalReason,
       terminal_receipt_digest AS terminalReceiptDigest, version,
       created_at AS createdAt, updated_at AS updatedAt, terminal_at AS terminalAt
FROM works`;

const MANIFEST_SELECT = `
SELECT id, privacy, channel_id AS channelId, message_refs_json AS messageRefsJson,
       artifact_refs_json AS artifactRefsJson, message_count AS messageCount,
       artifact_count AS artifactCount, channel_watermark AS channelWatermark,
       event_watermark AS eventWatermark, context_digest AS contextDigest,
       source_digest AS sourceDigest, created_at AS createdAt
FROM context_manifests`;

const QUEUED_CANCELLATION_RECEIPT_SELECT = `
SELECT work_id AS workId, attempt_id AS attemptId, fencing_token AS fencingToken,
       terminal_status AS status, source_reference AS sourceReference,
       result_digest AS resultDigest, artifact_refs_json AS artifactRefsJson,
       receipt_digest AS receiptDigest, created_at AS createdAt
FROM terminal_receipts`;

const TURN_SELECTION_SELECT = `
SELECT requested_model_alias AS modelAlias,
       requested_reasoning_effort AS reasoningEffort
FROM work_turn_selections`;

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function normalizeTurnSelection(value: WorkTurnSelection | undefined): WorkTurnSelection {
  if (value === undefined) {
    return Object.freeze({ modelAlias: null, reasoningEffort: null });
  }
  assertExactKeys(
    value,
    ["modelAlias", "reasoningEffort"],
    "invalid_request",
    "Work turn selection",
  );
  const modelAlias = value.modelAlias;
  if (
    modelAlias !== null &&
    (typeof modelAlias !== "string" || modelAlias.length < 1 || modelAlias.length > 256 ||
      /[\0\r\n]/u.test(modelAlias))
  ) {
    throw new WorkError("invalid_request", "requested model alias is invalid");
  }
  const reasoningEffort = value.reasoningEffort;
  if (
    reasoningEffort !== null &&
    (typeof reasoningEffort !== "string" || !REASONING_EFFORTS.has(reasoningEffort))
  ) {
    throw new WorkError("invalid_request", "requested reasoning effort is invalid");
  }
  return Object.freeze({ modelAlias, reasoningEffort });
}

function readTurnSelection(database: M11Database, workId: string): WorkTurnSelection {
  const selection = database.readOne<WorkTurnSelection>(
    `${TURN_SELECTION_SELECT} WHERE work_id = ?`,
    workId,
  );
  if (!selection) throw new Error("durable Work is missing its turn selection");
  return Object.freeze({ ...selection });
}

function normalizeInstructionMessageIds(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || new Set(value).size !== value.length) {
    throw new WorkError("invalid_request", "instruction Message references must be distinct and bounded");
  }
  return Object.freeze(value.map(id => assertId("message", id, "invalid_request")));
}

function workRequestDigest(input: Pick<CreateWorkInput,
  "principalId" | "targetPrincipalId" | "channelId" | "originMessageId" | "roundId" | "kind" | "maxAutomaticOffers"> & {
  manifest: ReturnType<typeof normalizeManifest>;
  turnSelection: WorkTurnSelection;
  presentation: CreateWorkInput["presentation"] | null;
  plannedInvocation: ForegroundDetachmentRequest | null;
  instructionMessageIds?: readonly string[];
}): string {
  const { turnSelection, presentation, plannedInvocation, instructionMessageIds, ...base } = input;
  const digestInput: Record<string, unknown> = { ...base };
  // Omitted extensions retain the exact digest used by pre-extension callers.
  if (turnSelection.modelAlias !== null || turnSelection.reasoningEffort !== null) digestInput.turnSelection = turnSelection;
  if (presentation !== null) digestInput.presentation = presentation;
  if (plannedInvocation !== null) digestInput.plannedInvocation = plannedInvocation;
  if (instructionMessageIds !== undefined) digestInput.instructionMessageIds = instructionMessageIds;
  return sha256(canonicalJson(digestInput));
}

function readPlannedInvocation(database: M11Database, workId: string): ForegroundDetachmentRequest | null {
  const row = database.readOne<{ assignmentJson: string }>(
    "SELECT assignment_json AS assignmentJson FROM work_planned_invocations WHERE work_id = ?", workId);
  return row ? parseForegroundDetachmentRequest(JSON.parse(row.assignmentJson)) : null;
}

/** Read the immutable instruction partition, binding event metadata to the durable Work digest. */
export function readWorkInstructionMessageIds(database: M11Database, work: WorkRecord): readonly string[] | undefined {
  const event = database.readOne<{ payloadJson: string; payloadDigest: string }>(
    `SELECT payload_json AS payloadJson, payload_digest AS payloadDigest FROM events
     WHERE aggregate_kind='work' AND aggregate_id=? AND aggregate_version=1 AND type='turn.updated'`, work.id);
  let ids: readonly string[] | undefined;
  if (event) {
    if (sha256(event.payloadJson) !== event.payloadDigest) throw new WorkError("invalid_request", "Work creation evidence digest differs");
    const payload = JSON.parse(event.payloadJson);
    if (payload.workId !== work.id || payload.requestDigest !== work.requestDigest ||
        payload.contextManifestId !== work.contextManifestId || payload.targetPrincipalId !== work.targetPrincipalId) {
      throw new WorkError("invalid_request", "Work creation evidence binding differs");
    }
    ids = normalizeInstructionMessageIds(payload.instructionMessageIds);
  }
  const row = database.readOne<ManifestRow>(`${MANIFEST_SELECT} WHERE id=?`, work.contextManifestId);
  if (!row) throw new WorkError("invalid_manifest", "Work context manifest is unavailable");
  const { id: _id, createdAt: _createdAt, ...manifest } = freezeManifest(row);
  const presentation = database.readOne<{ title: string; summary: string }>(
    "SELECT title, summary FROM work_thread_presentations WHERE work_id=?", work.id) ?? null;
  const digest = workRequestDigest({ principalId: work.principalId, targetPrincipalId: work.targetPrincipalId,
    channelId: work.channelId, originMessageId: work.originMessageId, roundId: work.roundId,
    kind: work.kind, maxAutomaticOffers: work.maxAutomaticOffers, manifest,
    turnSelection: readTurnSelection(database, work.id), presentation,
    plannedInvocation: readPlannedInvocation(database, work.id),
    ...(ids === undefined ? {} : { instructionMessageIds: ids }) });
  if (digest !== work.requestDigest) throw new WorkError("invalid_request", "Work instruction evidence differs from its request digest");
  return ids;
}

/** A planned child may inherit owner context only through its exact immutable parent snapshot. */
export function readInheritedWorkInstructionMessageIds(database: M11Database, work: WorkRecord): readonly string[] | undefined {
  let current = work;
  const visited = new Set<string>();
  for (let depth = 0; depth < 64; depth += 1) {
    if (visited.has(current.id)) throw new WorkError("invalid_request", "Work instruction lineage cycles");
    visited.add(current.id);
    const ids = readWorkInstructionMessageIds(database, current);
    if (ids !== undefined) return ids;
    if (current.kind !== "resident_work_thread") return undefined;
    const planned = readPlannedInvocation(database, current.id);
    if (!planned) return undefined;
    const parent = database.readOne<WorkRow>(`${WORK_SELECT} WHERE id=?`, planned.parentOrigin.workId);
    if (!parent || parent.channelId !== current.channelId || parent.principalId !== current.principalId ||
        parent.targetPrincipalId !== current.targetPrincipalId || parent.originMessageId !== current.originMessageId ||
        parent.roundId !== current.roundId || planned.parentOrigin.channelId !== current.channelId ||
        planned.parentOrigin.originMessageId !== current.originMessageId || planned.parentOrigin.roundId !== current.roundId ||
        planned.parentOrigin.holderPrincipalId !== current.targetPrincipalId) {
      throw new WorkError("invalid_request", "Work instruction parent binding differs");
    }
    const snapshot = (manifestId: string) => {
      const row = database.readOne<ManifestRow>(`${MANIFEST_SELECT} WHERE id=?`, manifestId);
      if (!row) throw new WorkError("invalid_manifest", "Work instruction parent snapshot is unavailable");
      const { id: _id, createdAt: _createdAt, ...manifest } = freezeManifest(row);
      return canonicalJson(manifest);
    };
    if (snapshot(parent.contextManifestId) !== snapshot(current.contextManifestId)) {
      throw new WorkError("invalid_manifest", "Work instruction parent snapshot differs");
    }
    current = freezeWork(parent);
  }
  throw new WorkError("invalid_request", "Work instruction lineage is unbounded");
}

function freezeWork(row: WorkRow): WorkRecord {
  return Object.freeze({ ...row });
}

function freezeManifest(row: ManifestRow): ContextManifest {
  return Object.freeze({
    id: row.id,
    privacy: row.privacy,
    channelId: row.channelId,
    messageIds: Object.freeze(JSON.parse(row.messageRefsJson) as string[]),
    artifactIds: Object.freeze(JSON.parse(row.artifactRefsJson) as string[]),
    messageCount: row.messageCount,
    artifactCount: row.artifactCount,
    channelWatermark: row.channelWatermark,
    eventWatermark: row.eventWatermark,
    contextDigest: row.contextDigest,
    sourceDigest: row.sourceDigest,
    createdAt: row.createdAt,
  });
}

function freezeQueuedCancellationReceipt(
  row: QueuedCancellationReceiptRow,
): QueuedCancellationReceipt {
  if (
    row.attemptId !== null || row.fencingToken !== 0 || row.status !== "cancelled" ||
    row.resultDigest !== null || row.artifactRefsJson !== "[]"
  ) {
    throw new Error("queued cancellation receipt has execution-bound fields");
  }
  return Object.freeze({
    workId: row.workId,
    attemptId: null,
    fencingToken: 0,
    status: "cancelled",
    sourceReference: row.sourceReference,
    resultDigest: null,
    artifactIds: Object.freeze([]) as readonly [],
    receiptDigest: row.receiptDigest,
    createdAt: row.createdAt,
  });
}

function normalizeManifest(value: ContextManifestInput): Omit<ContextManifest, "id" | "createdAt"> {
  assertExactKeys(
    value,
    ["privacy", "channelId", "messageIds", "artifactIds", "counts", "watermarks", "digests"],
    "invalid_manifest",
    "context manifest",
  );
  if (value.privacy !== "channel_only") {
    throw new WorkError("invalid_manifest", "only channel_only context is accepted");
  }
  const channelId = assertId("channel", value.channelId, "invalid_manifest");
  if (!Array.isArray(value.messageIds) || !Array.isArray(value.artifactIds)) {
    throw new WorkError("invalid_manifest", "manifest references must be arrays");
  }
  const messageIds = value.messageIds.map((id) => assertId("message", id, "invalid_manifest"));
  const artifactIds = value.artifactIds.map((id) => assertId("artifact", id, "invalid_manifest"));
  if (
    messageIds.length > 512 || artifactIds.length > 32 ||
    new Set(messageIds).size !== messageIds.length ||
    new Set(artifactIds).size !== artifactIds.length
  ) {
    throw new WorkError("invalid_manifest", "manifest references are duplicated or unbounded");
  }
  assertExactKeys(value.counts, ["messages", "artifacts"], "invalid_manifest", "manifest counts");
  assertExactKeys(
    value.watermarks,
    ["channelSequence", "eventSequence"],
    "invalid_manifest",
    "manifest watermarks",
  );
  assertExactKeys(value.digests, ["context", "source"], "invalid_manifest", "manifest digests");
  if (
    !Number.isSafeInteger(value.counts.messages) ||
    !Number.isSafeInteger(value.counts.artifacts) ||
    value.counts.messages !== messageIds.length ||
    value.counts.artifacts !== artifactIds.length
  ) {
    throw new WorkError("invalid_manifest", "manifest counts do not match references");
  }
  if (
    !Number.isSafeInteger(value.watermarks.channelSequence) ||
    value.watermarks.channelSequence < 0 ||
    !Number.isSafeInteger(value.watermarks.eventSequence) ||
    value.watermarks.eventSequence < 0
  ) {
    throw new WorkError("invalid_manifest", "manifest watermarks must be nonnegative integers");
  }
  return {
    privacy: "channel_only",
    channelId,
    messageIds: Object.freeze([...messageIds].sort()),
    artifactIds: Object.freeze([...artifactIds].sort()),
    messageCount: messageIds.length,
    artifactCount: artifactIds.length,
    channelWatermark: value.watermarks.channelSequence,
    eventWatermark: value.watermarks.eventSequence,
    contextDigest: assertDigest(value.digests.context, "invalid_manifest", "context digest"),
    sourceDigest: assertDigest(value.digests.source, "invalid_manifest", "source digest"),
  };
}

function readResult(database: M11Database, work: WorkRecord, replayed: boolean): CreateWorkResult {
  const manifest = database.readOne<ManifestRow>(
    `${MANIFEST_SELECT} WHERE id = ?`,
    work.contextManifestId,
  );
  const outbox = database.readOne<{ id: string }>(
    "SELECT id FROM outbox WHERE kind = 'work.wake' AND aggregate_id = ?",
    work.id,
  );
  if (!manifest || !outbox) throw new Error("durable Work is missing its manifest or wake intent");
  return Object.freeze({
    work,
    manifest: freezeManifest(manifest),
    wakeOutboxId: outbox.id,
    replayed,
  });
}

function readQueuedCancellationResult(
  database: M11Database,
  work: WorkRecord,
  replayed: boolean,
): CancelQueuedWorkResult {
  const row = database.readOne<QueuedCancellationReceiptRow>(
    `${QUEUED_CANCELLATION_RECEIPT_SELECT} WHERE work_id = ?`,
    work.id,
  );
  const outbox = database.readOne<{ id: string }>(
    "SELECT id FROM outbox WHERE kind = 'work.terminal' AND aggregate_id = ?",
    work.id,
  );
  if (!row || !outbox) throw new Error("queued cancellation is missing its receipt or terminal intent");
  return Object.freeze({
    work,
    receipt: freezeQueuedCancellationReceipt(row),
    terminalOutboxId: outbox.id,
    replayed,
  });
}

function assertNewWorkEligibility(database: Pick<M11Database, "readOne">, input: CreateWorkInput, manifest: ReturnType<typeof normalizeManifest>): void {
  const channel = database.readOne<{ lifecycle: string }>(
    "SELECT lifecycle FROM channels WHERE id = ?",
    input.channelId,
  );
  if (!channel || channel.lifecycle !== "active") throw new WorkError("ineligible", "Channel is not active");
  const target = database.readOne<{ count: number }>(
    `SELECT count(*) AS count
     FROM bots b JOIN channel_members m ON m.principal_id = b.id
     WHERE b.id = ? AND b.lifecycle = 'active' AND b.continuing_identity = 1
       AND b.durable_mailbox = 1 AND m.channel_id = ? AND m.active = 1`,
    input.targetPrincipalId,
    input.channelId,
  );
  if (target?.count !== 1) throw new WorkError("ineligible", "target is not a persistent Channel Bot");
  const actor = database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM channel_members WHERE channel_id = ? AND principal_id = ? AND active = 1",
    input.channelId,
    input.principalId,
  );
  if (actor?.count !== 1) throw new WorkError("ineligible", "principal is not an active Channel member");
  for (const messageId of manifest.messageIds) {
    const message = database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM messages WHERE id = ? AND channel_id = ?",
      messageId,
      input.channelId,
    );
    if (message?.count !== 1) throw new WorkError("invalid_manifest", "message reference is outside the Channel");
  }
  if (input.originMessageId !== null && !manifest.messageIds.includes(input.originMessageId)) {
    throw new WorkError("invalid_manifest", "origin Message must be present in the context manifest");
  }
  if (input.instructionMessageIds !== undefined) {
    if (input.principalId !== "user_owner" || input.roundId !== null ||
        !["resident_turn", "bot_turn"].includes(input.kind) || input.instructionMessageIds.at(-1) !== input.originMessageId) {
      throw new WorkError("invalid_request", "instruction Message references require an owner direct turn ending at its origin");
    }
    let priorSequence = 0;
    for (const id of input.instructionMessageIds) {
      const message = database.readOne<{ sequence: number }>(
        `SELECT m.channel_sequence AS sequence FROM messages m
         WHERE m.id=? AND m.channel_id=? AND m.author_principal_id=? AND m.author_kind='owner'
           AND m.kind='text' AND m.body_text IS NOT NULL AND length(trim(m.body_text))>0
           AND m.stored_visibility='visible'
           AND NOT EXISTS(SELECT 1 FROM messages t WHERE t.tombstones_message_id=m.id)
           AND NOT EXISTS(SELECT 1 FROM message_artifacts a WHERE a.message_id=m.id)`,
        id, input.channelId, input.principalId);
      if (!message || !manifest.messageIds.includes(id) || message.sequence <= priorSequence || message.sequence > manifest.channelWatermark) {
        throw new WorkError("invalid_manifest", "instruction Message references are not ordered visible owner speech in this snapshot");
      }
      priorSequence = message.sequence;
    }
    if (priorSequence !== manifest.channelWatermark) throw new WorkError("invalid_manifest", "instruction origin must end the snapshot");
  }
  if (input.roundId !== null) {
    const round = database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM rounds WHERE id = ? AND channel_id = ?",
      input.roundId,
      input.channelId,
    );
    if (round?.count !== 1) throw new WorkError("ineligible", "Round is outside the Channel");
  }
}

export function createWorkService(options: CreateWorkServiceOptions) {
  const now = options.now ?? (() => new Date());

  return Object.freeze({
    create(input: CreateWorkInput): CreateWorkResult {
      const requestKeys = [
        "principalId", "targetPrincipalId", "channelId", "originMessageId",
        "roundId", "kind", "idempotencyKey", "manifest", "maxAutomaticOffers",
        "requestId", "correlationId",
        ...(Object.prototype.hasOwnProperty.call(input, "turnSelection") ? ["turnSelection"] : []),
        ...(Object.prototype.hasOwnProperty.call(input, "instructionMessageIds") ? ["instructionMessageIds"] : []),
        ...(Object.prototype.hasOwnProperty.call(input, "presentation") ? ["presentation"] : []),
        ...(Object.prototype.hasOwnProperty.call(input, "plannedInvocation") ? ["plannedInvocation"] : []),
      ];
      assertExactKeys(
        input,
        requestKeys,
        "invalid_request",
        "Work creation request",
      );
      const principalId = assertId("principal", input.principalId, "invalid_request");
      const targetPrincipalId = assertId("principal", input.targetPrincipalId, "invalid_request");
      const channelId = assertId("channel", input.channelId, "invalid_request");
      const originMessageId = input.originMessageId === null
        ? null
        : assertId("message", input.originMessageId, "invalid_request");
      const roundId = input.roundId === null
        ? null
        : assertId("round", input.roundId, "invalid_request");
      const requestId = assertId("request", input.requestId, "invalid_request");
      const correlationId = assertId("correlation", input.correlationId, "invalid_request");
      if (typeof input.kind !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.kind)) {
        throw new WorkError("invalid_request", "Work kind must be a bounded identifier");
      }
      if (
        typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.length < 16 ||
        input.idempotencyKey.length > 128 ||
        !/^[\x20-\x7e]+$/.test(input.idempotencyKey)
      ) {
        throw new WorkError("invalid_request", "invalid Work idempotency key");
      }
      if (
        !Number.isSafeInteger(input.maxAutomaticOffers) ||
        input.maxAutomaticOffers < 1 ||
        input.maxAutomaticOffers > 16
      ) {
        throw new WorkError("invalid_request", "automatic offer budget must be between 1 and 16");
      }
      const manifest = normalizeManifest(input.manifest);
      const turnSelection = normalizeTurnSelection(input.turnSelection);
      const instructionMessageIds = normalizeInstructionMessageIds(input.instructionMessageIds);
      const presentation = input.presentation === undefined ? null : (() => {
        assertExactKeys(input.presentation!, ["title", "summary"], "invalid_request", "Work presentation");
        const { title, summary } = input.presentation!;
        if (typeof title !== "string" || title.length < 1 || title.length > 88 || /[\u0000\r\n]/u.test(title)) {
          throw new WorkError("invalid_request", "Work presentation title must be one bounded line");
        }
        if (typeof summary !== "string" || summary.length < 1 || summary.length > 280 || /\u0000/u.test(summary)) {
          throw new WorkError("invalid_request", "Work presentation summary must be bounded text");
        }
        return Object.freeze({ title, summary });
      })();
      if (manifest.channelId !== channelId) {
        throw new WorkError("invalid_manifest", "manifest Channel differs from Work Channel");
      }
      const idempotencyKeyDigest = sha256(input.idempotencyKey);
      const plannedInvocation = input.plannedInvocation === undefined ? null : parseForegroundDetachmentRequest(input.plannedInvocation);
      if (plannedInvocation !== null) {
        if (input.kind !== 'resident_work_thread') throw new WorkError('invalid_request', 'planned invocation requires Working Thread');
      }
      const requestDigest = workRequestDigest({ principalId, targetPrincipalId, channelId, originMessageId,
        roundId, kind: input.kind, manifest, maxAutomaticOffers: input.maxAutomaticOffers,
        turnSelection, presentation, plannedInvocation,
        ...(instructionMessageIds === undefined ? {} : { instructionMessageIds }) });
      const existing = options.database.readOne<WorkRow>(
        `${WORK_SELECT} WHERE principal_id = ? AND idempotency_key_digest = ?`,
        principalId,
        idempotencyKeyDigest,
      );
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw new WorkError("idempotency_conflict", "Work idempotency key has a different request digest");
        }
        return readResult(options.database, freezeWork(existing), true);
      }

      assertNewWorkEligibility(options.database, input, manifest);
      const createdAt = canonicalTimestamp(now());
      const manifestId = options.generateId("contextManifest");
      const workId = options.generateId("work");
      const outboxId = options.generateId("outbox");
      const deliveryId = options.generateId("delivery");
      assertCoordinationId("contextManifest", manifestId);
      assertCoordinationId("work", workId);
      assertCoordinationId("outbox", outboxId);
      assertCoordinationId("delivery", deliveryId);
      const destinationReference = `resident:${targetPrincipalId}`;
      const payload = {
        workId,
        state: "queued",
        targetPrincipalId,
        contextManifestId: manifestId,
        contextDigest: manifest.contextDigest,
        messageCount: manifest.messageCount,
        artifactCount: manifest.artifactCount,
        channelWatermark: manifest.channelWatermark,
        eventWatermark: manifest.eventWatermark,
      };
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const endpointIdempotencyKey = sha256(canonicalJson({
        destinationReference,
        kind: "work.wake",
        workId,
      }));

      const committed = options.database.mutateWithEvent((transaction) => {
        // Recheck the speech binding under the same transaction as the Work and its event.
        if (instructionMessageIds !== undefined) {
          assertNewWorkEligibility(transaction, { ...input, instructionMessageIds }, manifest);
        }
        transaction.run(
          `INSERT INTO context_manifests (
            id, privacy, channel_id, message_refs_json, artifact_refs_json,
            message_count, artifact_count, channel_watermark, event_watermark,
            context_digest, source_digest, created_at
          ) VALUES (?, 'channel_only', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          manifestId,
          channelId,
          canonicalJson(manifest.messageIds),
          canonicalJson(manifest.artifactIds),
          manifest.messageCount,
          manifest.artifactCount,
          manifest.channelWatermark,
          manifest.eventWatermark,
          manifest.contextDigest,
          manifest.sourceDigest,
          createdAt,
        );
        transaction.run(
          `INSERT INTO works (
            id, principal_id, target_principal_id, channel_id, origin_message_id,
            round_id, context_manifest_id, kind, idempotency_key_digest,
            request_digest, state, current_attempt_id, next_fencing_token,
            automatic_offer_count, max_automatic_offers, terminal_reason,
            terminal_receipt_digest, version, created_at, updated_at, terminal_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 1, 0, ?,
                    NULL, NULL, 1, ?, ?, NULL)`,
          workId,
          principalId,
          targetPrincipalId,
          channelId,
          originMessageId,
          roundId,
          manifestId,
          input.kind,
          idempotencyKeyDigest,
          requestDigest,
          input.maxAutomaticOffers,
          createdAt,
          createdAt,
        );
        transaction.run(
          `INSERT INTO work_turn_selections (
            work_id, requested_model_alias, requested_reasoning_effort
          ) VALUES (?, ?, ?)`,
          workId,
          turnSelection.modelAlias,
          turnSelection.reasoningEffort,
        );
        if (plannedInvocation !== null) {
          const parent = plannedInvocation.parentOrigin;
          transaction.run(
            `INSERT INTO work_planned_invocations (work_id, parent_work_id, parent_attempt_id,
              parent_lease_id, parent_fencing_token, resident_slug, invocation_id, assignment_json,
              request_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            workId, parent.workId, parent.attemptId, parent.leaseId, parent.fencingToken,
            plannedInvocation.residentSlug, plannedInvocation.invocationId,
            canonicalJson(plannedInvocation), requestDigest, createdAt,
          );
        }
        if (presentation !== null) {
          transaction.run(
            `INSERT INTO work_thread_presentations (work_id, title, summary)
             VALUES (?, ?, ?)`,
            workId,
            presentation.title,
            presentation.summary,
          );
        }
        transaction.run(
          `INSERT INTO outbox (
            id, kind, aggregate_kind, aggregate_id, destination_reference,
            payload_json, payload_digest, endpoint_idempotency_key, state,
            attempt_count, max_attempts, not_before, claimed_by,
            claim_expires_at, last_error_code, version, created_at, updated_at,
            delivered_at
          ) VALUES (?, 'work.wake', 'work', ?, ?, ?, ?, ?, 'pending', 0, 4,
                    ?, NULL, NULL, NULL, 1, ?, ?, NULL)`,
          outboxId,
          workId,
          destinationReference,
          payloadJson,
          payloadDigest,
          endpointIdempotencyKey,
          createdAt,
          createdAt,
          createdAt,
        );
        transaction.run(
          `INSERT INTO deliveries (
            id, outbox_id, state, endpoint_idempotency_key, attempt_count,
            final_disposition, version, created_at, updated_at, terminal_at
          ) VALUES (?, ?, 'pending', ?, 0, NULL, 1, ?, ?, NULL)`,
          deliveryId,
          outboxId,
          endpointIdempotencyKey,
          createdAt,
          createdAt,
        );
        const work: WorkRecord = Object.freeze({
          id: workId,
          principalId,
          targetPrincipalId,
          channelId,
          originMessageId,
          roundId,
          contextManifestId: manifestId,
          kind: input.kind,
          idempotencyKeyDigest,
          requestDigest,
          state: "queued",
          currentAttemptId: null,
          nextFencingToken: 1,
          automaticOfferCount: 0,
          maxAutomaticOffers: input.maxAutomaticOffers,
          terminalReason: null,
          terminalReceiptDigest: null,
          version: 1,
          createdAt,
          updatedAt: createdAt,
          terminalAt: null,
        });
        const storedManifest: ContextManifest = Object.freeze({
          id: manifestId,
          ...manifest,
          createdAt,
        });
        return {
          value: Object.freeze({ work, manifest: storedManifest, wakeOutboxId: outboxId, replayed: false }),
          events: [
            {
              type: "turn.updated",
              aggregateKind: "work",
              aggregateId: workId,
              aggregateVersion: 1,
              channelId,
              actorPrincipalId: principalId,
              requestId,
              correlationId,
              payload: {
                workId,
                state: "queued",
                contextManifestId: manifestId,
                requestDigest,
                targetPrincipalId,
                automaticOfferCount: 0,
                maxAutomaticOffers: input.maxAutomaticOffers,
                ...(instructionMessageIds === undefined ? {} : { instructionMessageIds: [...instructionMessageIds] }),
              },
              createdAt,
            },
            {
              type: "activity.updated",
              aggregateKind: "outbox",
              aggregateId: outboxId,
              aggregateVersion: 1,
              channelId,
              actorPrincipalId: principalId,
              requestId,
              correlationId,
              payload: {
                outboxId,
                deliveryId,
                workId,
                state: "pending",
                payloadDigest,
                endpointIdempotencyKey,
              },
              createdAt,
            },
          ],
        };
      });
      return committed.value;
    },

    cancelQueued(input: CancelQueuedWorkInput): CancelQueuedWorkResult {
      assertExactKeys(
        input,
        [
          "workId", "actorPrincipalId", "reasonCode", "sourceReference",
          "timestamp", "requestId", "correlationId",
        ],
        "invalid_request",
        "queued Work cancellation",
      );
      const workId = assertId("work", input.workId, "invalid_request");
      const actorPrincipalId = assertId("principal", input.actorPrincipalId, "invalid_request");
      const requestId = assertId("request", input.requestId, "invalid_request");
      const correlationId = assertId("correlation", input.correlationId, "invalid_request");
      if (typeof input.reasonCode !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.reasonCode)) {
        throw new WorkError("invalid_request", "queued cancellation reason must be a bounded identifier");
      }
      const sourceReference = assertSafeReference(
        input.sourceReference,
        "invalid_request",
        "queued cancellation source reference",
      );
      const parsedTimestamp = new Date(input.timestamp);
      if (
        Number.isNaN(parsedTimestamp.valueOf()) ||
        canonicalTimestamp(parsedTimestamp) !== input.timestamp
      ) {
        throw new WorkError("invalid_request", "queued cancellation timestamp must be canonical UTC milliseconds");
      }
      const workRow = options.database.readOne<WorkRow>(`${WORK_SELECT} WHERE id = ?`, workId);
      if (!workRow) throw new WorkError("not_found", "Work was not found");
      const work = freezeWork(workRow);
      if (actorPrincipalId !== work.principalId && !options.database.readOne('SELECT id FROM channels WHERE id = ? AND owner_principal_id = ?',work.channelId,actorPrincipalId)) {
        throw new WorkError("ineligible", "only the initiating principal may cancel queued Work");
      }
      const receiptDigest = sha256(canonicalJson({
        workId,
        attemptId: null,
        fencingToken: 0,
        status: "cancelled",
        sourceReference,
        resultDigest: null,
        artifactIds: [],
        reasonCode: input.reasonCode,
        createdAt: input.timestamp,
      }));
      const existing = options.database.readOne<QueuedCancellationReceiptRow>(
        `${QUEUED_CANCELLATION_RECEIPT_SELECT} WHERE work_id = ?`,
        workId,
      );
      if (existing) {
        if (
          existing.receiptDigest !== receiptDigest ||
          work.terminalReason !== input.reasonCode
        ) {
          throw new WorkError("terminal_conflict", "queued cancellation conflicts with immutable history");
        }
        return readQueuedCancellationResult(options.database, work, true);
      }
      if (work.state !== "queued" || work.currentAttemptId !== null) {
        throw new WorkError("illegal_state", "only queued Work without a live Attempt may cancel without a fence");
      }
      assertM11Transition("work", "queued", "cancelled");
      const outboxId = options.generateId("outbox");
      const deliveryId = options.generateId("delivery");
      assertCoordinationId("outbox", outboxId);
      assertCoordinationId("delivery", deliveryId);
      const destinationReference = `channel:${work.channelId}`;
      const payload = {
        workId,
        state: "cancelled",
        sourceReference,
        receiptDigest,
        fencingToken: 0,
        reasonCode: input.reasonCode,
      };
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const endpointIdempotencyKey = sha256(canonicalJson({
        destinationReference,
        kind: "work.terminal",
        receiptDigest,
        workId,
      }));
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          `INSERT INTO terminal_receipts (
            work_id, attempt_id, fencing_token, terminal_status, source_reference,
            result_digest, artifact_refs_json, receipt_digest, created_at
          ) VALUES (?, NULL, 0, 'cancelled', ?, NULL, '[]', ?, ?)`,
          workId,
          sourceReference,
          receiptDigest,
          input.timestamp,
        );
        transaction.run(
          `UPDATE works SET state = 'cancelled', terminal_reason = ?,
             terminal_receipt_digest = ?, terminal_at = ?, updated_at = ?,
             version = version + 1 WHERE id = ?`,
          input.reasonCode,
          receiptDigest,
          input.timestamp,
          input.timestamp,
          workId,
        );
        transaction.run(
          `INSERT INTO outbox (
            id, kind, aggregate_kind, aggregate_id, destination_reference,
            payload_json, payload_digest, endpoint_idempotency_key, state,
            attempt_count, max_attempts, not_before, claimed_by,
            claim_expires_at, last_error_code, version, created_at, updated_at,
            delivered_at
          ) VALUES (?, 'work.terminal', 'work', ?, ?, ?, ?, ?, 'pending', 0, 4,
                    ?, NULL, NULL, NULL, 1, ?, ?, NULL)`,
          outboxId,
          workId,
          destinationReference,
          payloadJson,
          payloadDigest,
          endpointIdempotencyKey,
          input.timestamp,
          input.timestamp,
          input.timestamp,
        );
        transaction.run(
          `INSERT INTO deliveries (
            id, outbox_id, state, endpoint_idempotency_key, attempt_count,
            final_disposition, version, created_at, updated_at, terminal_at
          ) VALUES (?, ?, 'pending', ?, 0, NULL, 1, ?, ?, NULL)`,
          deliveryId,
          outboxId,
          endpointIdempotencyKey,
          input.timestamp,
          input.timestamp,
        );
        return {
          value: undefined,
          events: [
            {
              type: "turn.updated",
              aggregateKind: "work",
              aggregateId: workId,
              aggregateVersion: work.version + 1,
              channelId: work.channelId,
              actorPrincipalId,
              requestId,
              correlationId,
              payload: {
                workId,
                state: "cancelled",
                attemptId: null,
                fencingToken: 0,
                receiptDigest,
                reasonCode: input.reasonCode,
              },
              createdAt: input.timestamp,
            },
            {
              type: "activity.updated",
              aggregateKind: "outbox",
              aggregateId: outboxId,
              aggregateVersion: 1,
              channelId: work.channelId,
              actorPrincipalId,
              requestId,
              correlationId,
              payload: {
                outboxId,
                deliveryId,
                workId,
                state: "pending",
                payloadDigest,
                endpointIdempotencyKey,
                receiptDigest,
              },
              createdAt: input.timestamp,
            },
          ],
        };
      });
      const cancelledRow = options.database.readOne<WorkRow>(`${WORK_SELECT} WHERE id = ?`, workId);
      if (!cancelledRow) throw new Error("queued cancellation lost its Work row");
      return readQueuedCancellationResult(options.database, freezeWork(cancelledRow), false);
    },

    get(workId: string): WorkRecord | null {
      assertCoordinationId("work", workId);
      const row = options.database.readOne<WorkRow>(`${WORK_SELECT} WHERE id = ?`, workId);
      return row ? freezeWork(row) : null;
    },

    getPlannedInvocation(workId: string): ForegroundDetachmentRequest | null {
      assertId('work', workId, 'invalid_request');
      return readPlannedInvocation(options.database, workId);
    },

    getInstructionMessageIds(workId: string): readonly string[] | undefined {
      assertId("work", workId, "invalid_request");
      const row = options.database.readOne<WorkRow>(`${WORK_SELECT} WHERE id=?`, workId);
      if (!row) throw new WorkError("not_found", "Work is unavailable");
      return readWorkInstructionMessageIds(options.database, freezeWork(row));
    },

    getInvocationExecution(workId: string): { workId: string; attemptId: string; leaseId: string; fencingToken: number; invocationId: string; startedAt: string } | null {
      return options.database.readOne<{ workId: string; attemptId: string; leaseId: string; fencingToken: number; invocationId: string; startedAt: string }>(
        `SELECT work_id AS workId, attempt_id AS attemptId, lease_id AS leaseId,
          fencing_token AS fencingToken, invocation_id AS invocationId, started_at AS startedAt
          FROM work_invocation_starts WHERE work_id = ?`, workId) ?? null;
    },

    markInvocationStarted(input: { origin: CoordinationTurnOrigin; invocationId: string; requestId: string; correlationId: string }): { started: boolean } {
      const origin = input.origin;
      const timestamp = canonicalTimestamp(now());
      if (options.database.readOne('SELECT work_id FROM work_invocation_starts WHERE work_id = ?', origin.workId)) return { started: false };
      return options.database.mutateWithEvent((transaction) => {
        const valid = transaction.readOne<{ id: string }>(
          `SELECT w.id FROM works w JOIN attempts a ON a.id = w.current_attempt_id
           JOIN leases l ON l.attempt_id = a.id JOIN work_planned_invocations p ON p.work_id = w.id
           WHERE w.id = ? AND a.id = ? AND l.id = ? AND a.fencing_token = ?
             AND a.holder_principal_id = ? AND a.holder_instance_id = ? AND a.authority_reference = ?
             AND w.state = 'running' AND a.state = 'running' AND l.state = 'active'
             AND l.expires_at > ? AND p.invocation_id = ?`,
          origin.workId, origin.attemptId, origin.leaseId, origin.fencingToken,
          origin.holderPrincipalId, origin.holderInstanceId, origin.authorityReference, timestamp, input.invocationId);
        if (!valid) throw new WorkError('ineligible', 'invocation start has stale or mismatched authority');
        transaction.run(`INSERT INTO work_invocation_starts (work_id, attempt_id, lease_id, fencing_token, invocation_id, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
          origin.workId, origin.attemptId, origin.leaseId, origin.fencingToken, input.invocationId, timestamp);
        return { value: { started: true }, events: [{
          type: 'activity.updated', aggregateKind: 'work_invocation', aggregateId: origin.workId, aggregateVersion: 1,
          channelId: origin.channelId, actorPrincipalId: origin.holderPrincipalId,
          requestId: input.requestId, correlationId: input.correlationId,
          payload: { workId: origin.workId, invocationId: input.invocationId, executionState: 'started', recoveryPolicy: 'interrupt_after_start' }, createdAt: timestamp,
        }] };
      }).value;
    },

    getTurnSelection(workId: string): WorkTurnSelection {
      assertId("work", workId, "invalid_request");
      return readTurnSelection(options.database, workId);
    },

    listResidentRecoverable(kind: string, limit = 100): readonly WorkRecord[] {
      if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(kind)) {
        throw new WorkError("invalid_request", "Work kind must be a bounded identifier");
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new WorkError("invalid_request", "recoverable Work limit must be between 1 and 100");
      }
      return Object.freeze(options.database.readAll<WorkRow>(
        `${WORK_SELECT} WHERE kind = ? AND (
           (state = 'queued' AND current_attempt_id IS NULL) OR
           state IN ('leased', 'running', 'cancelling')
         )
         ORDER BY created_at ASC, id ASC LIMIT ?`,
        kind,
        limit,
      ).map(freezeWork));
    },

    listSucceededMissingResult(kind: string, limit = 100): readonly WorkRecord[] {
      if (typeof kind !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(kind)) {
        throw new WorkError("invalid_request", "Work kind must be a bounded identifier");
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new WorkError("invalid_request", "missing result Work limit must be between 1 and 100");
      }
      return Object.freeze(options.database.readAll<WorkRow>(
        `${WORK_SELECT} WHERE state = 'succeeded' AND kind = ?
         AND NOT EXISTS (
           SELECT 1 FROM messages result
           WHERE result.work_id = works.id AND result.kind = 'result'
         )
         ORDER BY created_at ASC, id ASC LIMIT ?`,
        kind,
        limit,
      ).map(freezeWork));
    },
  });
}
