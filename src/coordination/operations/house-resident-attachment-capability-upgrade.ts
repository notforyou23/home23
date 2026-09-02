import { createHash } from "node:crypto";
import Database from "better-sqlite3";

import {
  canonicalCoordinationJson,
  openCoordinationDatabase,
  type CoordinationTransaction,
  type JsonValue,
} from "../db/index.js";
import { assertCoordinationId } from "../ids/index.js";

export const HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES = Object.freeze([
  "attachments",
  "messages",
] as const);

export const HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION =
  "UPGRADE JERRY AND FORREST ATTACHMENT CAPABILITIES" as const;

export type HouseResidentBinding = "jerry" | "forrest";

export interface HouseResidentAttachmentCapabilityAuthority {
  approved: true;
  kind: "house-resident-attachment-capability-upgrade";
  operator: "user_owner";
  residents: readonly ["jerry", "forrest"];
}

export interface HouseResidentCapabilitySnapshot {
  botId: string;
  principalId: string;
  conversationId: string;
  residentBinding: HouseResidentBinding;
  lifecycle: "active";
  continuingIdentity: true;
  durableMailbox: true;
  activeInstanceId: string;
  activeKeyVersion: number;
  residentProtocolVersion: number;
  version: number;
  requiredCapabilities: readonly string[];
  residentCapabilities: readonly string[];
}

export interface HouseResidentAttachmentCapabilityUpgradeInput {
  databasePath: string;
  apply?: boolean;
  authority?: HouseResidentAttachmentCapabilityAuthority;
  confirmation?: typeof HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION;
  expectedResidents?: readonly [
    HouseResidentCapabilitySnapshot,
    HouseResidentCapabilitySnapshot,
  ];
  requestId?: string;
  correlationId?: string;
  now?: () => Date;
}

export interface HouseResidentAttachmentCapabilityResidentReceipt {
  residentBinding: HouseResidentBinding;
  changed: boolean;
  alreadyCurrent: boolean;
  before: HouseResidentCapabilitySnapshot;
  after: HouseResidentCapabilitySnapshot;
  eventSequence: number | null;
}

export interface HouseResidentAttachmentCapabilityUpgradeReceipt {
  mode: "inspection" | "applied";
  mutated: boolean;
  targetCapabilities: typeof HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES;
  residents: readonly HouseResidentAttachmentCapabilityResidentReceipt[];
  receiptDigest: string;
}

interface HouseResidentRow {
  botId: string;
  principalId: string;
  conversationId: string | null;
  residentBinding: string;
  lifecycle: string;
  continuingIdentity: number;
  durableMailbox: number;
  activeInstanceId: string | null;
  activeKeyVersion: number | null;
  residentProtocolVersion: number | null;
  version: number;
  requiredCapabilitiesJson: string;
  residentCapabilitiesJson: string;
}

const SNAPSHOT_KEYS = Object.freeze([
  "activeInstanceId",
  "activeKeyVersion",
  "botId",
  "continuingIdentity",
  "conversationId",
  "durableMailbox",
  "lifecycle",
  "principalId",
  "requiredCapabilities",
  "residentBinding",
  "residentCapabilities",
  "residentProtocolVersion",
  "version",
] as const);

const HOUSE_RESIDENT_QUERY = `
  SELECT id AS botId,
         principal_id AS principalId,
         conversation_id AS conversationId,
         resident_binding AS residentBinding,
         lifecycle,
         continuing_identity AS continuingIdentity,
         durable_mailbox AS durableMailbox,
         active_instance_id AS activeInstanceId,
         active_key_version AS activeKeyVersion,
         resident_protocol_version AS residentProtocolVersion,
         version,
         required_capabilities_json AS requiredCapabilitiesJson,
         resident_capabilities_json AS residentCapabilitiesJson
  FROM bots
  WHERE resident_binding IN ('jerry', 'forrest')
  ORDER BY CASE resident_binding WHEN 'jerry' THEN 0 ELSE 1 END`;

function capabilityArray(json: string, field: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "string")
  ) {
    throw new Error(`${field} must contain only string capabilities`);
  }
  return Object.freeze([...parsed]);
}

function snapshot(row: HouseResidentRow): HouseResidentCapabilitySnapshot {
  if (
    (row.residentBinding !== "jerry" && row.residentBinding !== "forrest") ||
    row.lifecycle !== "active" ||
    row.continuingIdentity !== 1 ||
    row.durableMailbox !== 1 ||
    row.conversationId === null ||
    row.activeInstanceId === null ||
    row.activeKeyVersion === null ||
    row.residentProtocolVersion === null
  ) {
    throw new Error(
      `house resident ${row.residentBinding} is not an active, registered, persistent resident`,
    );
  }
  return Object.freeze({
    botId: row.botId,
    principalId: row.principalId,
    conversationId: row.conversationId,
    residentBinding: row.residentBinding,
    lifecycle: "active",
    continuingIdentity: true,
    durableMailbox: true,
    activeInstanceId: row.activeInstanceId,
    activeKeyVersion: row.activeKeyVersion,
    residentProtocolVersion: row.residentProtocolVersion,
    version: row.version,
    requiredCapabilities: capabilityArray(
      row.requiredCapabilitiesJson,
      `${row.residentBinding} required capabilities`,
    ),
    residentCapabilities: capabilityArray(
      row.residentCapabilitiesJson,
      `${row.residentBinding} resident capabilities`,
    ),
  });
}

interface ResidentReader {
  readAll<T>(sql: string): T[];
}

function readHouseResidents(
  reader: ResidentReader,
): readonly [HouseResidentCapabilitySnapshot, HouseResidentCapabilitySnapshot] {
  const residents = reader.readAll<HouseResidentRow>(HOUSE_RESIDENT_QUERY).map(snapshot);
  if (
    residents.length !== 2 ||
    residents[0]?.residentBinding !== "jerry" ||
    residents[1]?.residentBinding !== "forrest"
  ) {
    throw new Error("capability upgrade requires exactly Jerry and Forrest");
  }
  return Object.freeze([
    residents[0],
    residents[1],
  ]) as readonly [HouseResidentCapabilitySnapshot, HouseResidentCapabilitySnapshot];
}

function isTargetCapabilities(capabilities: readonly string[]): boolean {
  return JSON.stringify(capabilities) ===
    JSON.stringify(HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES);
}

function assertSupportedCurrentCapabilities(
  resident: HouseResidentCapabilitySnapshot,
): void {
  const supported = (capabilities: readonly string[]) =>
    JSON.stringify(capabilities) === JSON.stringify(["messages"]) ||
    isTargetCapabilities(capabilities);
  if (
    !supported(resident.requiredCapabilities) ||
    !supported(resident.residentCapabilities)
  ) {
    throw new Error(
      `${resident.residentBinding} capability upgrade refuses an unexpected capability set`,
    );
  }
}

function assertExactAuthority(
  authority: HouseResidentAttachmentCapabilityAuthority | undefined,
): asserts authority is HouseResidentAttachmentCapabilityAuthority {
  if (
    authority?.approved !== true ||
    authority.kind !== "house-resident-attachment-capability-upgrade" ||
    authority.operator !== "user_owner" ||
    !Array.isArray(authority.residents) ||
    authority.residents.length !== 2 ||
    authority.residents[0] !== "jerry" ||
    authority.residents[1] !== "forrest" ||
    Object.keys(authority).sort().join(",") !==
      "approved,kind,operator,residents"
  ) {
    throw new Error(
      "capability upgrade apply requires exact Jerry and Forrest owner authority",
    );
  }
}

function assertExactExpectedSnapshot(
  value: unknown,
  binding: HouseResidentBinding,
): asserts value is HouseResidentCapabilitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${binding} snapshot is missing`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== [...SNAPSHOT_KEYS].sort().join(",") ||
    record.residentBinding !== binding ||
    typeof record.botId !== "string" ||
    typeof record.principalId !== "string" ||
    typeof record.conversationId !== "string" ||
    record.lifecycle !== "active" ||
    record.continuingIdentity !== true ||
    record.durableMailbox !== true ||
    typeof record.activeInstanceId !== "string" ||
    !Number.isSafeInteger(record.activeKeyVersion) ||
    !Number.isSafeInteger(record.residentProtocolVersion) ||
    !Number.isSafeInteger(record.version) ||
    !Array.isArray(record.requiredCapabilities) ||
    record.requiredCapabilities.some((entry) => typeof entry !== "string") ||
    !Array.isArray(record.residentCapabilities) ||
    record.residentCapabilities.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`expected ${binding} snapshot is not exact`);
  }
}

function assertExpectedResidents(
  expected: HouseResidentAttachmentCapabilityUpgradeInput["expectedResidents"],
  actual: readonly [
    HouseResidentCapabilitySnapshot,
    HouseResidentCapabilitySnapshot,
  ],
): void {
  if (!Array.isArray(expected) || expected.length !== 2) {
    throw new Error("capability upgrade apply requires two expected resident snapshots");
  }
  assertExactExpectedSnapshot(expected[0], "jerry");
  assertExactExpectedSnapshot(expected[1], "forrest");
  if (
    canonicalCoordinationJson(expected[0] as unknown as JsonValue) !==
      canonicalCoordinationJson(actual[0] as unknown as JsonValue) ||
    canonicalCoordinationJson(expected[1] as unknown as JsonValue) !==
      canonicalCoordinationJson(actual[1] as unknown as JsonValue)
  ) {
    throw new Error("house resident snapshot changed; inspect again before apply");
  }
}

function canonicalTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("capability upgrade clock returned an invalid date");
  }
  return new Date(value.getTime()).toISOString();
}

function nextBotEventVersion(
  transaction: CoordinationTransaction,
  botId: string,
): number {
  return (
    transaction.readOne<{ version: number | null }>(
      `SELECT max(aggregate_version) AS version
       FROM events WHERE aggregate_kind = 'bot' AND aggregate_id = ?`,
      botId,
    )?.version ?? 0
  ) + 1;
}

function receiptDigest(
  receipt: Omit<HouseResidentAttachmentCapabilityUpgradeReceipt, "receiptDigest">,
): string {
  return createHash("sha256")
    .update(canonicalCoordinationJson(receipt as unknown as JsonValue), "utf8")
    .digest("hex");
}

function finalizeReceipt(
  mode: HouseResidentAttachmentCapabilityUpgradeReceipt["mode"],
  residents: readonly HouseResidentAttachmentCapabilityResidentReceipt[],
): HouseResidentAttachmentCapabilityUpgradeReceipt {
  const base = Object.freeze({
    mode,
    mutated: residents.some((resident) => resident.changed),
    targetCapabilities: HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES,
    residents: Object.freeze([...residents]),
  });
  return Object.freeze({ ...base, receiptDigest: receiptDigest(base) });
}

function inspectionReceipt(
  residents: readonly [
    HouseResidentCapabilitySnapshot,
    HouseResidentCapabilitySnapshot,
  ],
): HouseResidentAttachmentCapabilityUpgradeReceipt {
  return finalizeReceipt(
    "inspection",
    residents.map((resident) => {
      assertSupportedCurrentCapabilities(resident);
      return Object.freeze({
        residentBinding: resident.residentBinding,
        changed: false,
        alreadyCurrent:
          isTargetCapabilities(resident.requiredCapabilities) &&
          isTargetCapabilities(resident.residentCapabilities),
        before: resident,
        after: resident,
        eventSequence: null,
      });
    }),
  );
}

function inspectDatabase(
  databasePath: string,
): readonly [HouseResidentCapabilitySnapshot, HouseResidentCapabilitySnapshot] {
  let database: Database.Database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch {
    throw new Error("capability upgrade inspection requires an existing database");
  }
  try {
    database.pragma("query_only = ON");
    return readHouseResidents({
      readAll: <T>(sql: string) => database.prepare<[], T>(sql).all(),
    });
  } finally {
    database.close();
  }
}

/**
 * Inspects or atomically upgrades the two persistent house residents. This is
 * deliberately not a general bot-edit API: apply is bound to an exact owner
 * authority object, exact before snapshots, and one human confirmation phrase.
 */
export function upgradeHouseResidentAttachmentCapabilities(
  input: HouseResidentAttachmentCapabilityUpgradeInput,
): HouseResidentAttachmentCapabilityUpgradeReceipt {
  if (input.apply !== true) {
    return inspectionReceipt(inspectDatabase(input.databasePath));
  }

  assertExactAuthority(input.authority);
  if (input.confirmation !== HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION) {
    throw new Error(
      `capability upgrade apply requires confirmation: ${HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION}`,
    );
  }
  if (!input.requestId || !input.correlationId) {
    throw new Error("capability upgrade apply requires request and correlation IDs");
  }
  assertCoordinationId("request", input.requestId);
  assertCoordinationId("correlation", input.correlationId);
  const requestId = input.requestId;
  const correlationId = input.correlationId;

  const database = openCoordinationDatabase({
    path: input.databasePath,
    applicationVersion: "home23-house-resident-attachment-capability-upgrade",
  });
  try {
    const observed = readHouseResidents(database);
    observed.forEach(assertSupportedCurrentCapabilities);
    assertExpectedResidents(input.expectedResidents, observed);
    const needsChange = observed.filter((resident) =>
      !isTargetCapabilities(resident.requiredCapabilities) ||
      !isTargetCapabilities(resident.residentCapabilities)
    );
    if (needsChange.length === 0) {
      return finalizeReceipt(
        "applied",
        observed.map((resident) => Object.freeze({
          residentBinding: resident.residentBinding,
          changed: false,
          alreadyCurrent: true,
          before: resident,
          after: resident,
          eventSequence: null,
        })),
      );
    }

    const changedAt = canonicalTimestamp(input.now ?? (() => new Date()));
    const mutation = database.mutateWithEvent((transaction) => {
      const before = readHouseResidents(transaction);
      before.forEach(assertSupportedCurrentCapabilities);
      assertExpectedResidents(input.expectedResidents, before);
      const changedBindings = new Set(
        before
          .filter((resident) =>
            !isTargetCapabilities(resident.requiredCapabilities) ||
            !isTargetCapabilities(resident.residentCapabilities)
          )
          .map((resident) => resident.residentBinding),
      );
      for (const resident of before) {
        if (!changedBindings.has(resident.residentBinding)) continue;
        const update = transaction.run(
          `UPDATE bots
           SET required_capabilities_json = ?,
               resident_capabilities_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
          JSON.stringify(HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES),
          JSON.stringify(HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES),
          changedAt,
          resident.botId,
          resident.version,
        );
        if (update.changes !== 1) {
          throw new Error(`${resident.residentBinding} capability update conflicted`);
        }
      }
      const after = readHouseResidents(transaction);
      const events = before
        .filter((resident) => changedBindings.has(resident.residentBinding))
        .map((resident) => ({
          type: "bot.updated",
          aggregateKind: "bot",
          aggregateId: resident.botId,
          aggregateVersion: nextBotEventVersion(transaction, resident.botId),
          channelId: null,
          actorPrincipalId: input.authority!.operator,
          requestId,
          correlationId,
          payload: {
            outcome: "attachment_capabilities_upgraded",
            residentBinding: resident.residentBinding,
            requiredCapabilities: [...HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES],
            residentCapabilities: [...HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES],
          },
          createdAt: changedAt,
        }));
      if (events.length === 0) {
        throw new Error("capability upgrade mutation unexpectedly had no events");
      }
      return {
        value: { before, after, changedBindings },
        events: events as [typeof events[number], ...Array<typeof events[number]>],
      };
    });

    const eventSequenceByBot = new Map(
      mutation.events.map((event) => [event.aggregateId, event.sequence]),
    );
    return finalizeReceipt(
      "applied",
      mutation.value.before.map((before, index) => {
        const after = mutation.value.after[index]!;
        const changed = mutation.value.changedBindings.has(before.residentBinding);
        let eventSequence: number | null = null;
        if (changed) {
          const storedSequence = eventSequenceByBot.get(before.botId);
          if (storedSequence === undefined) {
            throw new Error(
              `${before.residentBinding} capability receipt is missing its event sequence`,
            );
          }
          eventSequence = storedSequence;
        }
        return Object.freeze({
          residentBinding: before.residentBinding,
          changed,
          alreadyCurrent: !changed,
          before,
          after,
          eventSequence,
        });
      }),
    );
  } finally {
    database.close();
  }
}
