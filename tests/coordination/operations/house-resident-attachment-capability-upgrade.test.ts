import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  createBotDirectory,
  SqliteBotDirectoryRepository,
} from "../../../src/coordination/bots/index.js";
import {
  createChannelService,
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
} from "../../../src/coordination/channels/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import {
  HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES,
  HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION,
  upgradeHouseResidentAttachmentCapabilities,
  type HouseResidentAttachmentCapabilityAuthority,
  type HouseResidentCapabilitySnapshot,
} from "../../../src/coordination/operations/index.js";
import { M11MessageProvenanceAuthority } from "../../../src/coordination/work/index.js";

const AT = "2026-09-02T18:30:00.000Z";
const CHANGED_AT = "2026-09-02T18:31:00.000Z";
const AUTHORITY: HouseResidentAttachmentCapabilityAuthority = Object.freeze({
  approved: true,
  kind: "house-resident-attachment-capability-upgrade",
  operator: "user_owner",
  residents: ["jerry", "forrest"],
});

async function seedLegacyHouseResidents(databasePath: string): Promise<void> {
  const database = openCoordinationDatabase({
    path: databasePath,
    now: () => new Date(AT),
  });
  try {
    const repository = new SqliteBotDirectoryRepository(database);
    const directory = createBotDirectory({
      repository,
      availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 },
      now: () => new Date(AT),
    });
    const messaging = new SqliteMessagingRepository(database, {
      botConversationBinding: new SqliteBotConversationBindingAdapter(),
      messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
    });
    const channels = createChannelService({
      repository: messaging,
      participantDirectory: {
        listVisibleBots: directory.listVisibleBots,
        resolveAlias: directory.resolveAlias,
        getBotByResidentBinding: (binding) =>
          repository.getBotByResidentBinding(binding),
      },
      cursorSigningKey: Buffer.alloc(32, 7),
      now: () => new Date(AT),
    });

    for (const residentBinding of ["jerry", "forrest"] as const) {
      const displayName = residentBinding === "jerry" ? "Jerry" : "Forrest";
      const requestId = generateCoordinationId("request");
      const correlationId = generateCoordinationId("correlation");
      const bot = await directory.ensurePersistentBinding({
        residentBinding,
        name: displayName,
        purpose: "Persistent Home23 resident",
        continuingIdentity: true,
        durableMailbox: true,
        requiredCapabilities: ["messages"],
        aliases: [{ namespace: "name", value: displayName }],
      }, { principalId: "user_owner", requestId, correlationId });
      await directory.registerResident({
        context: {
          requestId,
          correlationId,
          credential: {
            residentSlug: residentBinding,
            role: "resident",
            instanceId: `home23-${residentBinding}-harness`,
            keyVersion: 1,
          },
        },
        botBinding: residentBinding,
        protocolVersion: 1,
        capabilities: ["messages"],
      });
      await channels.createDirectConversation({
        context: {
          principalId: "user_owner",
          requestId,
          correlationId,
          identity: {
            kind: "owner",
            auth: {
              principalId: "user_owner",
              deviceId: generateCoordinationId("device"),
              sessionId: generateCoordinationId("clientSession"),
              scopes: ["product:read", "message:send"],
            },
          },
        },
        memberBotIds: [bot.id],
        pinned: true,
        idempotencyKey: `isolated-${residentBinding}-direct`,
      });
    }
  } finally {
    database.close();
  }
}

function rawBots(databasePath: string): Record<string, unknown>[] {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database.prepare(
      `SELECT * FROM bots
       WHERE resident_binding IN ('jerry', 'forrest')
       ORDER BY resident_binding DESC`,
    ).all() as Record<string, unknown>[];
  } finally {
    database.close();
  }
}

function upgradeEventCount(databasePath: string): number {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (database.prepare(
      `SELECT count(*) AS count FROM events
       WHERE type = 'bot.updated'
         AND json_extract(payload_json, '$.outcome') =
             'attachment_capabilities_upgraded'`,
    ).get() as { count: number }).count;
  } finally {
    database.close();
  }
}

function operationInput(
  databasePath: string,
  expectedResidents: readonly HouseResidentCapabilitySnapshot[],
) {
  return {
    databasePath,
    apply: true as const,
    authority: AUTHORITY,
    confirmation: HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION,
    expectedResidents: expectedResidents as readonly [
      HouseResidentCapabilitySnapshot,
      HouseResidentCapabilitySnapshot,
    ],
    requestId: generateCoordinationId("request"),
    correlationId: generateCoordinationId("correlation"),
    now: () => new Date(CHANGED_AT),
  };
}

test("house-resident attachment capability upgrade is inspection-first and atomic", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-house-resident-caps-"));
  const databasePath = join(root, "coordination.sqlite3");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await seedLegacyHouseResidents(databasePath);

  const beforeRows = rawBots(databasePath);
  const inspection = upgradeHouseResidentAttachmentCapabilities({ databasePath });
  const repeatedInspection = upgradeHouseResidentAttachmentCapabilities({ databasePath });
  assert.equal(inspection.mode, "inspection");
  assert.equal(inspection.mutated, false);
  assert.equal(inspection.receiptDigest, repeatedInspection.receiptDigest);
  assert.deepEqual(
    inspection.residents.map(({ changed, alreadyCurrent }) => ({
      changed,
      alreadyCurrent,
    })),
    [
      { changed: false, alreadyCurrent: false },
      { changed: false, alreadyCurrent: false },
    ],
  );
  assert.deepEqual(rawBots(databasePath), beforeRows);

  const expectedResidents = inspection.residents.map((resident) => resident.before);
  assert.throws(
    () => upgradeHouseResidentAttachmentCapabilities({
      ...operationInput(databasePath, expectedResidents),
      confirmation: undefined,
    }),
    /UPGRADE JERRY AND FORREST ATTACHMENT CAPABILITIES/u,
  );
  const staleForrest = {
    ...expectedResidents[1]!,
    version: expectedResidents[1]!.version + 1,
  };
  assert.throws(
    () => upgradeHouseResidentAttachmentCapabilities(operationInput(
      databasePath,
      [expectedResidents[0]!, staleForrest],
    )),
    /snapshot changed/u,
  );
  assert.deepEqual(rawBots(databasePath), beforeRows);
  assert.equal(upgradeEventCount(databasePath), 0);

  const applied = upgradeHouseResidentAttachmentCapabilities(
    operationInput(databasePath, expectedResidents),
  );
  assert.equal(applied.mode, "applied");
  assert.equal(applied.mutated, true);
  assert.match(applied.receiptDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    applied.residents.map(({ changed, alreadyCurrent }) => ({
      changed,
      alreadyCurrent,
    })),
    [
      { changed: true, alreadyCurrent: false },
      { changed: true, alreadyCurrent: false },
    ],
  );
  assert.equal(new Set(applied.residents.map((resident) => resident.eventSequence)).size, 2);
  for (const resident of applied.residents) {
    assert.deepEqual(
      resident.after.requiredCapabilities,
      HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES,
    );
    assert.deepEqual(
      resident.after.residentCapabilities,
      HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES,
    );
    assert.equal(resident.after.version, resident.before.version + 1);
    assert.deepEqual(
      { ...resident.after, version: resident.before.version,
        requiredCapabilities: resident.before.requiredCapabilities,
        residentCapabilities: resident.before.residentCapabilities },
      resident.before,
    );
  }
  assert.equal(upgradeEventCount(databasePath), 2);

  const afterRows = rawBots(databasePath);
  for (let index = 0; index < beforeRows.length; index += 1) {
    const before = { ...beforeRows[index] };
    const after = { ...afterRows[index] };
    for (const field of [
      "required_capabilities_json",
      "resident_capabilities_json",
      "updated_at",
      "version",
    ]) {
      delete before[field];
      delete after[field];
    }
    assert.deepEqual(after, before);
  }

  const current = upgradeHouseResidentAttachmentCapabilities({ databasePath });
  const eventsBeforeReplay = upgradeEventCount(databasePath);
  const replay = upgradeHouseResidentAttachmentCapabilities(operationInput(
    databasePath,
    current.residents.map((resident) => resident.before),
  ));
  assert.equal(replay.mutated, false);
  assert.ok(replay.residents.every((resident) => resident.alreadyCurrent));
  assert.equal(upgradeEventCount(databasePath), eventsBeforeReplay);
});
