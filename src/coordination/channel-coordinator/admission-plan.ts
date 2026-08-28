import { createHash } from "node:crypto";

import {
  canonicalCoordinationJson,
  type JsonValue,
} from "../db/index.js";
import { validateCoordinationId } from "../ids/index.js";
import type { M11Database } from "../work/index.js";
import type {
  CoordinatorAdmissionPlan,
  CoordinatorAdmissionTarget,
} from "./types.js";

type JsonObject = { [key: string]: JsonValue };

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`durable Channel admission ${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`durable Channel admission ${label} is invalid`);
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
    throw new Error(`durable Channel admission ${label} has an invalid ID`);
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
    throw new Error(`durable Channel admission ${label} is not bounded`);
  }
  const values = value.map((candidate) => id(kind, candidate, label));
  if (new Set(values).size !== values.length) {
    throw new Error(`durable Channel admission ${label} is duplicated`);
  }
  return Object.freeze(values);
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`durable Channel admission ${label} is invalid`);
  }
  return value as number;
}

function parseTarget(value: unknown): CoordinatorAdmissionTarget {
  const row = object(value, "target");
  const targetBotId = id("bot", row.targetBotId, "target Bot");
  const targetPrincipalId = id("principal", row.targetPrincipalId, "target principal");
  if (targetBotId !== targetPrincipalId) {
    throw new Error("durable Channel admission target identity is not exact");
  }
  return Object.freeze({
    targetBotId,
    targetPrincipalId,
    targetBotDisplayName: string(row.targetBotDisplayName, "target display name", 160),
    residentBinding: string(row.residentBinding, "resident binding", 128),
  });
}

export function parseCoordinatorAdmissionPlan(value: unknown): CoordinatorAdmissionPlan {
  const row = object(value, "plan");
  if (row.version !== 1) throw new Error("durable Channel admission version is unsupported");
  const channelId = id("channel", row.channelId, "Channel");
  const originMessageId = id("message", row.originMessageId, "origin Message");
  const visibleParticipantIds = ids("bot", row.visibleParticipantIds, "visible participants", 64);
  if (!Array.isArray(row.selectedTargets) || row.selectedTargets.length < 1 || row.selectedTargets.length > 8) {
    throw new Error("durable Channel admission targets are not bounded");
  }
  const selectedTargets = Object.freeze(row.selectedTargets.map(parseTarget));
  if (
    new Set(selectedTargets.map((target) => target.targetBotId)).size !== selectedTargets.length ||
    selectedTargets.some((target) => !visibleParticipantIds.includes(target.targetBotId))
  ) {
    throw new Error("durable Channel admission target plan is inconsistent");
  }
  if (row.responseOrder !== "parallel" && row.responseOrder !== "sequential") {
    throw new Error("durable Channel admission response order is invalid");
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
    throw new Error("durable Channel admission manifest is inconsistent");
  }

  const selection = object(row.turnSelection, "turn selection");
  const modelAlias = selection.modelAlias;
  const reasoningEffort = selection.reasoningEffort;
  if (
    modelAlias !== null &&
    (typeof modelAlias !== "string" || modelAlias.length < 1 || modelAlias.length > 256 || /[\0\r\n]/u.test(modelAlias))
  ) {
    throw new Error("durable Channel admission model selection is invalid");
  }
  if (
    reasoningEffort !== null &&
    (typeof reasoningEffort !== "string" || !REASONING_EFFORTS.has(reasoningEffort))
  ) {
    throw new Error("durable Channel admission effort selection is invalid");
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
    selectedTargets: parsed.selectedTargets.map((target) => ({ ...target })),
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
  if (digest !== row.payloadDigest) throw new Error("durable Channel admission event digest differs");
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
  if (!row) throw new Error("Round is missing its immutable Channel admission event");
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
     ORDER BY r.created_at, r.id`,
    input.channelId,
  );
  return Object.freeze(rows.flatMap((row) => {
    const plan = planFromEvent(row);
    return plan.originMessageId === input.originMessageId ? [row.roundId] : [];
  }));
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
     ORDER BY r.created_at, r.id LIMIT ?`,
    limit,
  );
  return Object.freeze(rows.map((row) => row.roundId));
}
