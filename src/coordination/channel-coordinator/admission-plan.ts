import { createHash } from "node:crypto";

import {
  canonicalCoordinationJson,
  type JsonValue,
} from "../db/index.js";
import { validateCoordinationId } from "../ids/index.js";
import { RECOVERY_REFUSAL_LIMIT, type M11Database } from "../work/index.js";
import type {
  CoordinatorAdmissionPlan,
  CoordinatorAdmissionTarget,
} from "./types.js";

type JsonObject = { [key: string]: JsonValue };

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

/** Durable admission evidence this module could not read or trust. Recovery
 * refuses such a Round for good: no later start reads the same bytes differently. */
export class CoordinatorAdmissionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorAdmissionPlanError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoordinatorAdmissionPlanError(`durable Channel admission ${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new CoordinatorAdmissionPlanError(`durable Channel admission ${label} is invalid`);
  }
  return value;
}

function id(
  kind: "channel" | "conversation" | "message" | "event" | "principal" | "bot" | "artifact",
  value: unknown,
  label: string,
): string {
  const candidate = string(value, label);
  if (!validateCoordinationId(kind, candidate)) {
    throw new CoordinatorAdmissionPlanError(`durable Channel admission ${label} has an invalid ID`);
  }
  return candidate;
}

function ids(
  kind: "message" | "artifact" | "principal" | "bot",
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new CoordinatorAdmissionPlanError(`durable Channel admission ${label} is not bounded`);
  }
  const values = value.map((candidate) => id(kind, candidate, label));
  if (new Set(values).size !== values.length) {
    throw new CoordinatorAdmissionPlanError(`durable Channel admission ${label} is duplicated`);
  }
  return Object.freeze(values);
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CoordinatorAdmissionPlanError(`durable Channel admission ${label} is invalid`);
  }
  return value as number;
}

function parseTarget(value: unknown): CoordinatorAdmissionTarget {
  const row = object(value, "target");
  const targetBotId = id("bot", row.targetBotId, "target Bot");
  const targetPrincipalId = id("principal", row.targetPrincipalId, "target principal");
  if (targetBotId !== targetPrincipalId) {
    throw new CoordinatorAdmissionPlanError("durable Channel admission target identity is not exact");
  }
  const selected = row.turnSelection === undefined ? undefined : object(row.turnSelection, "target selection");
  if (selected && ((selected.modelAlias !== null && (typeof selected.modelAlias !== "string" || !selected.modelAlias.length || selected.modelAlias.length > 256 || /[\0\r\n]/u.test(selected.modelAlias))) || (selected.reasoningEffort !== null && (typeof selected.reasoningEffort !== "string" || !REASONING_EFFORTS.has(selected.reasoningEffort))))) throw new CoordinatorAdmissionPlanError("Invalid target turn selection");
  return Object.freeze({
    ...(selected ? { turnSelection: { modelAlias: selected.modelAlias as string | null, reasoningEffort: selected.reasoningEffort as CoordinatorAdmissionPlan["turnSelection"]["reasoningEffort"] } } : {}),
    targetBotId,
    targetPrincipalId,
    targetBotDisplayName: string(row.targetBotDisplayName, "target display name", 160),
    residentBinding: string(row.residentBinding, "resident binding", 128),
  });
}

export function parseCoordinatorAdmissionPlan(value: unknown): CoordinatorAdmissionPlan {
  const row = object(value, "plan");
  if (row.version !== 1) throw new CoordinatorAdmissionPlanError("durable Channel admission version is unsupported");
  const channelId = id("channel", row.channelId, "Channel");
  const originMessageId = id("message", row.originMessageId, "origin Message");
  const visibleParticipantIds = ids("bot", row.visibleParticipantIds, "visible participants", 64);
  if (!Array.isArray(row.selectedTargets) || row.selectedTargets.length < 1 || row.selectedTargets.length > 8) {
    throw new CoordinatorAdmissionPlanError("durable Channel admission targets are not bounded");
  }
  const selectedTargets = Object.freeze(row.selectedTargets.map(parseTarget));
  if (
    new Set(selectedTargets.map((target) => target.targetBotId)).size !== selectedTargets.length ||
    selectedTargets.some((target) => !visibleParticipantIds.includes(target.targetBotId))
  ) {
    throw new CoordinatorAdmissionPlanError("durable Channel admission target plan is inconsistent");
  }
  if (row.responseOrder !== "parallel" && row.responseOrder !== "sequential") {
    throw new CoordinatorAdmissionPlanError("durable Channel admission response order is invalid");
  }

  const manifestRow = object(row.manifest, "manifest");
  const messageIds = ids("message", manifestRow.messageIds, "manifest Messages", 512);
  const artifactIds = ids("artifact", manifestRow.artifactIds, "manifest artifacts", 32);
  const counts = object(manifestRow.counts, "manifest counts");
  const watermarks = object(manifestRow.watermarks, "manifest watermarks");
  const digests = object(manifestRow.digests, "manifest digests");
  const contextDigest = string(digests.context, "context digest", 64);
  const sourceDigest = string(digests.source, "source digest", 64);
  if (
    manifestRow.privacy !== "channel_only" || manifestRow.channelId !== channelId ||
    !messageIds.includes(originMessageId) ||
    integer(counts.messages, "Message count") !== messageIds.length ||
    integer(counts.artifacts, "artifact count") !== artifactIds.length ||
    !/^[0-9a-f]{64}$/u.test(contextDigest) || !/^[0-9a-f]{64}$/u.test(sourceDigest)
  ) {
    throw new CoordinatorAdmissionPlanError("durable Channel admission manifest is inconsistent");
  }

  const selection = object(row.turnSelection, "turn selection");
  const modelAlias = selection.modelAlias;
  const reasoningEffort = selection.reasoningEffort;
  if (
    modelAlias !== null &&
    (typeof modelAlias !== "string" || modelAlias.length < 1 || modelAlias.length > 256 || /[\0\r\n]/u.test(modelAlias))
  ) {
    throw new CoordinatorAdmissionPlanError("durable Channel admission model selection is invalid");
  }
  if (
    reasoningEffort !== null &&
    (typeof reasoningEffort !== "string" || !REASONING_EFFORTS.has(reasoningEffort))
  ) {
    throw new CoordinatorAdmissionPlanError("durable Channel admission effort selection is invalid");
  }

  return Object.freeze({
    version: 1 as const,
    channelId,
    conversationId: id("conversation", row.conversationId, "conversation"),
    originMessageId,
    originEventId: id("event", row.originEventId, "origin event"),
    actorPrincipalId: id("principal", row.actorPrincipalId, "actor principal"),
    visibleParticipantIds,
    selectedTargets,
    responseOrder: row.responseOrder,
    standingReference: string(row.standingReference, "standing reference", 256),
    manifest: Object.freeze({
      privacy: "channel_only" as const,
      channelId,
      messageIds,
      artifactIds,
      counts: Object.freeze({ messages: messageIds.length, artifacts: artifactIds.length }),
      watermarks: Object.freeze({
        channelSequence: integer(watermarks.channelSequence, "Channel watermark"),
        eventSequence: integer(watermarks.eventSequence, "event watermark"),
      }),
      digests: Object.freeze({ context: contextDigest, source: sourceDigest }),
    }),
    turnSelection: Object.freeze({
      modelAlias: modelAlias as string | null,
      reasoningEffort: reasoningEffort as CoordinatorAdmissionPlan["turnSelection"]["reasoningEffort"],
    }),
  });
}

export function coordinatorAdmissionPlanJson(plan: CoordinatorAdmissionPlan): JsonObject {
  const parsed = parseCoordinatorAdmissionPlan(plan);
  return {
    version: 1,
    channelId: parsed.channelId,
    conversationId: parsed.conversationId,
    originMessageId: parsed.originMessageId,
    originEventId: parsed.originEventId,
    actorPrincipalId: parsed.actorPrincipalId,
    visibleParticipantIds: [...parsed.visibleParticipantIds],
    selectedTargets: parsed.selectedTargets.map(({ turnSelection, ...target }) => ({ ...target, ...(turnSelection ? { turnSelection: { ...turnSelection } } : {}) })),
    responseOrder: parsed.responseOrder,
    standingReference: parsed.standingReference,
    manifest: {
      privacy: parsed.manifest.privacy,
      channelId: parsed.manifest.channelId,
      messageIds: [...parsed.manifest.messageIds],
      artifactIds: [...parsed.manifest.artifactIds],
      counts: { ...parsed.manifest.counts },
      watermarks: { ...parsed.manifest.watermarks },
      digests: { ...parsed.manifest.digests },
    },
    turnSelection: { ...parsed.turnSelection },
  };
}

export function sameCoordinatorAdmissionPlan(
  left: CoordinatorAdmissionPlan,
  right: CoordinatorAdmissionPlan,
): boolean {
  return canonicalCoordinationJson(coordinatorAdmissionPlanJson(left)) ===
    canonicalCoordinationJson(coordinatorAdmissionPlanJson(right));
}

interface AdmissionEventRow {
  payloadJson: string;
  payloadDigest: string;
}

function planFromEvent(row: AdmissionEventRow): CoordinatorAdmissionPlan {
  const digest = createHash("sha256").update(row.payloadJson, "utf8").digest("hex");
  if (digest !== row.payloadDigest) throw new CoordinatorAdmissionPlanError("durable Channel admission event digest differs");
  const payload = object(JSON.parse(row.payloadJson), "event payload");
  return parseCoordinatorAdmissionPlan(payload.admissionPlan);
}

export function readCoordinatorAdmissionPlan(
  database: M11Database,
  roundId: string,
): CoordinatorAdmissionPlan {
  const row = database.readOne<AdmissionEventRow>(
    `SELECT payload_json AS payloadJson, payload_digest AS payloadDigest
     FROM events WHERE aggregate_kind = 'round' AND aggregate_id = ?
       AND aggregate_version = 1 AND type = 'turn.updated'`,
    roundId,
  );
  if (!row) throw new CoordinatorAdmissionPlanError("Round is missing its immutable Channel admission event");
  return planFromEvent(row);
}

export function findCoordinatorAdmissionRoundIds(
  database: M11Database,
  input: { channelId: string; originMessageId: string },
): readonly string[] {
  const rows = database.readAll<AdmissionEventRow & { roundId: string }>(
    `SELECT r.id AS roundId, e.payload_json AS payloadJson,
            e.payload_digest AS payloadDigest
     FROM rounds r JOIN events e
       ON e.aggregate_kind = 'round' AND e.aggregate_id = r.id
      AND e.aggregate_version = 1 AND e.type = 'turn.updated'
     WHERE r.channel_id = ?
       AND json_type(e.payload_json, '$.admissionPlan') = 'object'
       AND json_extract(e.payload_json, '$.admissionPlan.originMessageId') = ?
     ORDER BY r.created_at, r.id`,
    input.channelId,
    input.originMessageId,
  );
  return Object.freeze(rows.flatMap((row) => {
    const plan = planFromEvent(row);
    return plan.originMessageId === input.originMessageId ? [row.roundId] : [];
  }));
}

/** A refused Round recovery is durable evidence on the Round, not a state
 * change: the Round stays open, coordinating or waiting because only its
 * coordinator may move it. The events journal already keeps per-Round
 * evidence, so a refusal is one gap-free event per Round; a permanent one
 * keeps the Round out of the recovery list at every later start. */
const ROUND_RECOVERY_REFUSAL_AGGREGATE = "round_recovery_refusal";
const NOT_PERMANENTLY_REFUSED_ROUND_SQL = `NOT EXISTS (
  SELECT 1 FROM events refusal
  WHERE refusal.aggregate_kind = '${ROUND_RECOVERY_REFUSAL_AGGREGATE}'
    AND refusal.aggregate_id = r.id
    AND json_extract(refusal.payload_json, '$.permanent') = 1
)`;

export interface RecordRoundRecoveryRefusalInput {
  roundId: string;
  /** Bounded identifier naming why recovery refused the Round. */
  reasonCode: string;
  /** True when no later start can recover the Round; repeated transient
   * refusals become permanent at RECOVERY_REFUSAL_LIMIT. */
  permanent: boolean;
  message: string;
  requestId: string;
  correlationId: string;
}

export interface RoundRecoveryRefusalRecord {
  roundId: string;
  reasonCode: string;
  permanent: boolean;
  refusalCount: number;
  message: string;
  recordedAt: string;
}

export function listRecoverableCoordinatorAdmissionRoundIds(
  database: M11Database,
  limit: number,
): readonly string[] {
  const rows = database.readAll<{ roundId: string }>(
    `SELECT r.id AS roundId
     FROM rounds r
     LEFT JOIN events e
       ON e.aggregate_kind = 'round' AND e.aggregate_id = r.id
      AND e.aggregate_version = 1 AND e.type = 'turn.updated'
     WHERE r.state IN ('open', 'coordinating', 'waiting')
       AND (
         json_type(e.payload_json, '$.admissionPlan') = 'object'
         OR EXISTS (
           SELECT 1 FROM works w
           WHERE w.round_id = r.id AND w.kind = 'channel.bot_turn'
         )
       )
       AND ${NOT_PERMANENTLY_REFUSED_ROUND_SQL}
     ORDER BY r.created_at, r.id LIMIT ?`,
    limit,
  );
  return Object.freeze(rows.map((row) => row.roundId));
}

export function recordRoundRecoveryRefusal(
  database: M11Database,
  input: RecordRoundRecoveryRefusalInput,
  now: () => Date = () => new Date(),
): RoundRecoveryRefusalRecord {
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "correlationId,message,permanent,reasonCode,requestId,roundId") {
    throw new Error("Round recovery refusal contains missing or forbidden fields");
  }
  for (const [kind, value] of [
    ["round", input.roundId], ["request", input.requestId], ["correlation", input.correlationId],
  ] as const) {
    if (typeof value !== "string" || !validateCoordinationId(kind, value)) {
      throw new Error(`Round recovery refusal ${kind} ID is invalid`);
    }
  }
  if (typeof input.reasonCode !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.reasonCode)) {
    throw new Error("Round recovery refusal reason must be a bounded identifier");
  }
  if (typeof input.permanent !== "boolean") {
    throw new Error("Round recovery refusal permanence must be a boolean");
  }
  if (typeof input.message !== "string") {
    throw new Error("Round recovery refusal message must be a string");
  }
  const round = database.readOne<{ channelId: string }>(
    "SELECT channel_id AS channelId FROM rounds WHERE id = ?", input.roundId,
  );
  if (!round) throw new Error("Round was not found");
  const recordedAt = now().toISOString();
  const message = input.message.slice(0, 500);
  return database.mutateWithEvent((transaction) => {
    const previous = transaction.readOne<{ version: number | null }>(
      "SELECT max(aggregate_version) AS version FROM events WHERE aggregate_kind = ? AND aggregate_id = ?",
      ROUND_RECOVERY_REFUSAL_AGGREGATE, input.roundId,
    )?.version ?? 0;
    const refusalCount = previous + 1;
    const record: RoundRecoveryRefusalRecord = {
      roundId: input.roundId, reasonCode: input.reasonCode,
      permanent: input.permanent || refusalCount >= RECOVERY_REFUSAL_LIMIT,
      refusalCount, message, recordedAt,
    };
    return {
      value: Object.freeze(record),
      event: {
        type: "activity.updated",
        aggregateKind: ROUND_RECOVERY_REFUSAL_AGGREGATE,
        aggregateId: input.roundId,
        aggregateVersion: refusalCount,
        channelId: round.channelId,
        actorPrincipalId: null,
        requestId: input.requestId,
        correlationId: input.correlationId,
        payload: { ...record },
        createdAt: recordedAt,
      },
    };
  }).value;
}

export function getRoundRecoveryRefusal(
  database: M11Database,
  roundId: string,
): RoundRecoveryRefusalRecord | null {
  if (typeof roundId !== "string" || !validateCoordinationId("round", roundId)) {
    throw new Error("Round recovery refusal round ID is invalid");
  }
  const row = database.readOne<{ payload: string }>(
    `SELECT payload_json AS payload FROM events
     WHERE aggregate_kind = ? AND aggregate_id = ?
     ORDER BY aggregate_version DESC LIMIT 1`,
    ROUND_RECOVERY_REFUSAL_AGGREGATE, roundId,
  );
  return row ? Object.freeze(JSON.parse(row.payload) as RoundRecoveryRefusalRecord) : null;
}
