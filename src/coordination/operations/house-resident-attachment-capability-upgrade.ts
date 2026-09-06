import Database from "better-sqlite3";

import { openCoordinationDatabase, type CoordinationTransaction } from "../db/index.js";
import { HOUSE_RESIDENT_CAPABILITIES } from "../house-resident-capabilities.js";
import { generateCoordinationId } from "../ids/index.js";

export const HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION =
  "UPGRADE JERRY AND FORREST ATTACHMENT CAPABILITIES" as const;

type HouseResidentBinding = "jerry" | "forrest";
export interface HouseResidentAttachmentCapabilityAuthority {
  approved:true; kind:"house-resident-attachment-capability-upgrade";
  operator:"user_owner"; residents:readonly ["jerry", "forrest"];
}
export interface HouseResidentCapabilitySnapshot {
  residentBinding:HouseResidentBinding; botId:string; version:number;
  requiredCapabilities:readonly string[];
}
export interface HouseResidentCapabilityInspection {
  kind:"house-resident-attachment-capability-inspection"; mode:"inspection";
  targetCapabilities:typeof HOUSE_RESIDENT_CAPABILITIES;
  residents:readonly [HouseResidentCapabilitySnapshot, HouseResidentCapabilitySnapshot];
}
export interface HouseResidentCapabilityUpgradeReceipt {
  kind:"house-resident-attachment-capability-upgrade"; mode:"applied"; mutated:boolean;
  requestId:string; correlationId:string;
  residents:readonly Readonly<{
    residentBinding:HouseResidentBinding; changed:boolean;
    before:HouseResidentCapabilitySnapshot; after:HouseResidentCapabilitySnapshot;
    eventSequence:number|null;
  }>[];
}
export interface HouseResidentAttachmentCapabilityUpgradeInput {
  databasePath:string; apply?:boolean; authority?:HouseResidentAttachmentCapabilityAuthority;
  confirmation?:typeof HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION;
  expected?:HouseResidentCapabilityInspection; now?:()=>Date;
}
interface BotRow { residentBinding:string; botId:string; version:number; requiredCapabilitiesJson:string }

const QUERY = `SELECT resident_binding AS residentBinding, id AS botId, version,
  required_capabilities_json AS requiredCapabilitiesJson FROM bots
  WHERE resident_binding IN ('jerry','forrest')
    AND lifecycle='active' AND continuing_identity=1 AND durable_mailbox=1
    AND conversation_id IS NOT NULL AND active_instance_id IS NOT NULL
    AND active_key_version IS NOT NULL AND resident_protocol_version=1
  ORDER BY CASE resident_binding WHEN 'jerry' THEN 0 ELSE 1 END`;

function capabilities(json: string): readonly string[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("house resident required capabilities are invalid");
  }
  return Object.freeze(value);
}

function readResidents(reader: { readAll<T>(sql: string): T[] }): readonly
  [HouseResidentCapabilitySnapshot, HouseResidentCapabilitySnapshot] {
  const residents = reader.readAll<BotRow>(QUERY).map((row) => Object.freeze({
    residentBinding: row.residentBinding as HouseResidentBinding,
    botId: row.botId,
    version: row.version,
    requiredCapabilities: capabilities(row.requiredCapabilitiesJson),
  }));
  if (residents.length !== 2 || residents[0]?.residentBinding !== "jerry" ||
      residents[1]?.residentBinding !== "forrest") {
    throw new Error("capability upgrade requires exactly Jerry and Forrest");
  }
  return Object.freeze([residents[0], residents[1]]);
}

function inspect(databasePath: string): HouseResidentCapabilityInspection {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    return Object.freeze({
      kind: "house-resident-attachment-capability-inspection",
      mode: "inspection",
      targetCapabilities: HOUSE_RESIDENT_CAPABILITIES,
      residents: readResidents({
        readAll: <T>(sql: string) => database.prepare<[], T>(sql).all(),
      }),
    });
  } finally {
    database.close();
  }
}

function assertExpected(
  expected: HouseResidentCapabilityInspection | undefined,
  actual: readonly HouseResidentCapabilitySnapshot[],
): void {
  if (expected?.kind !== "house-resident-attachment-capability-inspection" ||
      expected.mode !== "inspection" || expected.residents.length !== 2 ||
      JSON.stringify(expected.targetCapabilities) !== JSON.stringify(HOUSE_RESIDENT_CAPABILITIES)) {
    throw new Error("apply requires the exact prior inspection receipt");
  }
  for (let index = 0; index < 2; index += 1) {
    const left = expected.residents[index]!;
    const right = actual[index]!;
    if (left.residentBinding !== right.residentBinding || left.botId !== right.botId ||
        left.version !== right.version ||
        JSON.stringify(left.requiredCapabilities) !== JSON.stringify(right.requiredCapabilities)) {
      throw new Error("house resident identity or version changed; inspect again");
    }
  }
}

function assertAuthority(authority: HouseResidentAttachmentCapabilityAuthority | undefined): asserts authority is HouseResidentAttachmentCapabilityAuthority {
  if (authority?.approved !== true ||
      authority.kind !== "house-resident-attachment-capability-upgrade" ||
      authority.operator !== "user_owner" ||
      Object.keys(authority).sort().join(",") !== "approved,kind,operator,residents" ||
      JSON.stringify(authority.residents) !== '["jerry","forrest"]') {
    throw new Error("apply requires explicit Jerry and Forrest owner authority");
  }
}

function supported(capabilities: readonly string[]): boolean {
  const json = JSON.stringify(capabilities);
  return json === '["messages"]' || json === JSON.stringify(HOUSE_RESIDENT_CAPABILITIES);
}

function nextEventVersion(transaction: CoordinationTransaction, botId: string): number {
  return (transaction.readOne<{ version: number | null }>(
    "SELECT max(aggregate_version) AS version FROM events WHERE aggregate_kind='bot' AND aggregate_id=?",
    botId,
  )?.version ?? 0) + 1;
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("capability upgrade clock returned an invalid date");
  }
  return new Date(value.getTime()).toISOString();
}

export function upgradeHouseResidentAttachmentCapabilities(
  input: HouseResidentAttachmentCapabilityUpgradeInput,
): HouseResidentCapabilityInspection | HouseResidentCapabilityUpgradeReceipt {
  if (input.apply !== true) return inspect(input.databasePath);
  if (input.confirmation !== HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION) {
    throw new Error(`apply requires --confirm '${HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION}'`);
  }
  const authority = input.authority;
  assertAuthority(authority);

  const requestId = generateCoordinationId("request");
  const correlationId = generateCoordinationId("correlation");
  const database = openCoordinationDatabase({ path: input.databasePath });
  try {
    const before = readResidents(database);
    assertExpected(input.expected, before);
    if (before.some((resident) => !supported(resident.requiredCapabilities))) {
      throw new Error("capability upgrade refuses an unexpected required capability set");
    }
    const changedIds = new Set(before.filter((resident) =>
      JSON.stringify(resident.requiredCapabilities) !== JSON.stringify(HOUSE_RESIDENT_CAPABILITIES)
    ).map((resident) => resident.botId));
    if (changedIds.size === 0) return Object.freeze({
      kind: "house-resident-attachment-capability-upgrade",
      mode: "applied",
      mutated: false,
      requestId,
      correlationId,
      residents: before.map((resident) => Object.freeze({
        residentBinding: resident.residentBinding, changed: false,
        before: resident, after: resident, eventSequence: null,
      })),
    });

    const at = timestamp(input.now ?? (() => new Date()));
    const mutation = database.mutateWithEvent((transaction) => {
      const transactionBefore = readResidents(transaction);
      assertExpected(input.expected, transactionBefore);
      if (transactionBefore.some((resident) => !supported(resident.requiredCapabilities))) {
        throw new Error("capability upgrade refuses an unexpected required capability set");
      }
      for (const resident of transactionBefore) {
        if (!changedIds.has(resident.botId)) continue;
        const result = transaction.run(
          `UPDATE bots SET required_capabilities_json=?, version=version+1, updated_at=?
           WHERE id=? AND version=?`,
          JSON.stringify(HOUSE_RESIDENT_CAPABILITIES), at, resident.botId, resident.version,
        );
        if (result.changes !== 1) throw new Error("house resident capability update conflicted");
      }
      const after = readResidents(transaction);
      const events = transactionBefore.filter((resident) => changedIds.has(resident.botId))
        .map((resident) => ({
          type: "bot.updated", aggregateKind: "bot", aggregateId: resident.botId,
          aggregateVersion: nextEventVersion(transaction, resident.botId), channelId: null,
          actorPrincipalId: authority.operator, requestId, correlationId,
          payload: { outcome: "required_capabilities_upgraded", residentBinding: resident.residentBinding,
            requiredCapabilities: [...HOUSE_RESIDENT_CAPABILITIES] }, createdAt: at,
        }));
      return { value: { before: transactionBefore, after },
        events: events as [typeof events[number], ...Array<typeof events[number]>] };
    });
    const sequence = new Map(mutation.events.map((event) => [event.aggregateId, event.sequence]));
    return Object.freeze({
      kind: "house-resident-attachment-capability-upgrade",
      mode: "applied",
      mutated: true,
      requestId,
      correlationId,
      residents: mutation.value.before.map((resident, index) => Object.freeze({
        residentBinding: resident.residentBinding,
        changed: changedIds.has(resident.botId),
        before: resident,
        after: mutation.value.after[index]!,
        eventSequence: sequence.get(resident.botId) ?? null,
      })),
    });
  } finally {
    database.close();
  }
}
