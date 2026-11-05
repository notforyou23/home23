import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { HOUSE_RESIDENT_CAPABILITIES } from "../../../src/coordination/house-resident-capabilities.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import {
  HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION,
  upgradeHouseResidentAttachmentCapabilities,
  type HouseResidentAttachmentCapabilityAuthority,
  type HouseResidentCapabilityInspection,
} from "../../../src/coordination/operations/index.js";

const AT = "2026-09-02T18:30:00.000Z";
const AUTHORITY: HouseResidentAttachmentCapabilityAuthority = Object.freeze({
  approved: true, kind: "house-resident-attachment-capability-upgrade",
  operator: "user_owner", residents: ["jerry", "forrest"],
});
const IDS = {
  jerry: { bot: "bot_0199a111-1111-7111-8111-111111111111",
    channel: "chn_0199a111-1111-7111-8111-111111111112",
    conversation: "cnv_0199a111-1111-7111-8111-111111111113" },
  forrest: { bot: "bot_0199a222-2222-7222-8222-222222222222",
    channel: "chn_0199a222-2222-7222-8222-222222222223",
    conversation: "cnv_0199a222-2222-7222-8222-222222222224" },
} as const;

function seed(databasePath: string): void {
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    const requestId = generateCoordinationId("request");
    const correlationId = generateCoordinationId("correlation");
    database.mutateWithEvent((transaction) => {
      transaction.run(
        "INSERT OR IGNORE INTO principals (id,kind,created_at) VALUES ('user_owner','owner',?)",
        AT,
      );
      for (const resident of ["jerry", "forrest"] as const) {
        const ids = IDS[resident];
        transaction.run("INSERT INTO principals (id,kind,created_at) VALUES (?,'bot',?)", ids.bot, AT);
        transaction.run(
          `INSERT INTO channels VALUES (?,'direct',?,'','user_owner','mentions_only',NULL,
             'parallel',1,'active',1,1,1,?,?)`,
          ids.channel, resident, AT, AT,
        );
        transaction.run("INSERT INTO conversation_handles VALUES (?,?,?)", ids.conversation, ids.channel, AT);
        transaction.run(
          `INSERT INTO bots (id,principal_id,name,purpose,lifecycle,conversation_id,
             resident_binding,continuing_identity,durable_mailbox,required_capabilities_json,
             active_instance_id,active_key_version,resident_protocol_version,
             resident_capabilities_json,resident_registered_at,last_heartbeat_at,
             reported_availability,version,created_at,updated_at)
           VALUES (?,?,?,'Persistent Home23 resident','active',?, ?,1,1,'["messages"]',
             ?,1,1,'["messages"]',?,?,'available',3,?,?)`,
          ids.bot, ids.bot, resident === "jerry" ? "Jerry" : "Forrest",
          ids.conversation, resident, `home23-${resident}-harness`, AT, AT, AT, AT,
        );
      }
      const events = (["jerry", "forrest"] as const).map((resident) => ({
        type: "bot.updated", aggregateKind: "bot", aggregateId: IDS[resident].bot,
        aggregateVersion: 1, channelId: null, actorPrincipalId: "user_owner",
        requestId, correlationId, payload: { outcome: "fixture" }, createdAt: AT,
      }));
      return { value: null,
        events: events as [typeof events[number], ...Array<typeof events[number]>] };
    });
  } finally {
    database.close();
  }
}

function rows(databasePath: string) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare(
      `SELECT resident_binding AS residentBinding, required_capabilities_json AS required,
              resident_capabilities_json AS resident, version
       FROM bots ORDER BY CASE resident_binding WHEN 'jerry' THEN 0 ELSE 1 END`,
    ).all() as Array<{ residentBinding: string; required: string; resident: string; version: number }>;
  } finally {
    database.close();
  }
}

function apply(databasePath: string, expected: HouseResidentCapabilityInspection) {
  return upgradeHouseResidentAttachmentCapabilities({
    databasePath,
    apply: true,
    authority: AUTHORITY,
    expected,
    confirmation: HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION,
    now: () => new Date("2026-09-02T18:31:00.000Z"),
  });
}

test("owner upgrade changes only required capabilities and resident attestation remains resident-owned", (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-resident-capabilities-"));
  const databasePath = join(root, "coordination.sqlite3");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seed(databasePath);

  const inspection = upgradeHouseResidentAttachmentCapabilities({ databasePath });
  assert.equal(inspection.mode, "inspection");
  const before = rows(databasePath);
  assert.throws(() => upgradeHouseResidentAttachmentCapabilities({
    databasePath, apply: true, authority: AUTHORITY, expected: inspection,
  }), /UPGRADE JERRY AND FORREST/u);
  assert.throws(() => upgradeHouseResidentAttachmentCapabilities({
    databasePath, apply: true, confirmation: HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION,
    expected: inspection,
  }), /owner authority/u);

  const stale = { ...inspection, residents: [inspection.residents[0], {
    ...inspection.residents[1], version: inspection.residents[1].version + 1,
  }] } as HouseResidentCapabilityInspection;
  assert.throws(() => apply(databasePath, stale), /inspect again/u);
  assert.deepEqual(rows(databasePath), before, "snapshot mismatch must be atomic");

  const receipt = apply(databasePath, inspection);
  assert.equal(receipt.mode, "applied");
  assert.equal(receipt.mutated, true);
  assert.match(receipt.requestId, /^req_/u);
  assert.match(receipt.correlationId, /^cor_/u);
  assert.ok(receipt.residents.every((resident) => resident.changed && resident.eventSequence));
  assert.deepEqual(rows(databasePath), [
    { residentBinding: "jerry", required: JSON.stringify(HOUSE_RESIDENT_CAPABILITIES),
      resident: '["messages"]', version: 4 },
    { residentBinding: "forrest", required: JSON.stringify(HOUSE_RESIDENT_CAPABILITIES),
      resident: '["messages"]', version: 4 },
  ]);

  const current = upgradeHouseResidentAttachmentCapabilities({ databasePath });
  const replay = apply(databasePath, current);
  assert.equal(replay.mode, "applied");
  assert.equal(replay.mutated, false);
});
