import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { provisionFreshHouse } from "../../../src/coordination/operations/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { createBotDirectory, SqliteBotDirectoryRepository } from "../../../src/coordination/bots/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import { HOUSE_RESIDENT_CAPABILITIES } from "../../../src/coordination/house-resident-capabilities.js";

const definition = { home: { id: "home_0198d95f-6c00-7000-8000-000000000001", name: "River Home" }, resident: { slug: "milo", name: "Milo", purpose: "Help River think and build." } };
const snapshot = (path: string) => {
  const db = new Database(path, { readonly: true });
  try { return {
    bots: db.prepare("SELECT * FROM bots").all(),
    channels: db.prepare("SELECT * FROM channels").all(),
    authority: db.prepare("SELECT * FROM authority_epochs").all(),
    events: db.prepare("SELECT * FROM events").all(),
  }; } finally { db.close(); }
};

test("fresh home has its own resident, complete authority, durable mailbox and repeatable identity", async t => {
  const root = mkdtempSync(join(tmpdir(), "h23-fresh-house-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "house.sqlite3");
  const first = await provisionFreshHouse({ databasePath, ...definition });
  const initial = snapshot(databasePath);
  assert.equal(first.residentBinding, "milo");
  assert.equal(initial.bots.length, 1);
  assert.equal(initial.channels.length, 1);
  const bot = initial.bots[0] as any;
  assert.equal(bot.name, "Milo");
  assert.equal(bot.continuing_identity, 1);
  assert.equal(bot.durable_mailbox, 1);
  assert.equal(bot.active_instance_id, null, "provisioning cannot claim a running resident");
  assert.deepEqual(JSON.parse(bot.required_capabilities_json), [...HOUSE_RESIDENT_CAPABILITIES]);
  assert.equal(initial.authority.length, 21);
  assert.equal((initial.authority as any[]).filter(row => row.mode === "canonical").length, 7);
  assert.equal(JSON.stringify(initial).includes('"Jerry"'), false);
  assert.deepEqual(await provisionFreshHouse({ databasePath, ...definition }), { ...first, replayed: true });
  assert.deepEqual(snapshot(databasePath), initial, "replay does not modify history or identity");
  await assert.rejects(provisionFreshHouse({ databasePath, ...definition, resident: { ...definition.resident, name: "Other" } }), /existing home claim/);
  assert.deepEqual(snapshot(databasePath), initial);
});

test("interrupted fresh creation resumes through the generic mailbox and authority operations", async t => {
  const root = mkdtempSync(join(tmpdir(), "h23-fresh-resume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "house.sqlite3");
  const db = openCoordinationDatabase({ path: databasePath });
  const at = new Date().toISOString();
  const digest = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
  db.mutateWithEvent(tx => {
    tx.run("INSERT INTO kernel_meta (key,value,updated_at) VALUES (?,?,?)", "home23.fresh-house.claim.v1", digest, at);
    return { value: null, event: { type: "home.provisioning_started", aggregateKind: "homeProvision", aggregateId: definition.home.id, aggregateVersion: 1,
      channelId: null, actorPrincipalId: "user_owner", requestId: generateCoordinationId("request"), correlationId: generateCoordinationId("correlation"), payload: { definitionDigest: digest }, createdAt: at } };
  });
  const repository = new SqliteBotDirectoryRepository(db);
  const directory = createBotDirectory({ repository, availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 } });
  const bot = await directory.ensurePersistentBinding({ residentBinding: "milo", name: "Milo", purpose: definition.resident.purpose, continuingIdentity: true, durableMailbox: true,
    requiredCapabilities: HOUSE_RESIDENT_CAPABILITIES, aliases: [{ namespace: "name", value: "Milo" }] },
  { principalId: "user_owner", requestId: generateCoordinationId("request"), correlationId: generateCoordinationId("correlation") });
  db.close();
  const receipt = await provisionFreshHouse({ databasePath, ...definition });
  assert.equal(receipt.botId, bot.id);
  assert.equal(snapshot(databasePath).channels.length, 1);
  assert.equal(snapshot(databasePath).bots.length, 1);
});

test("foreign home and malformed identity are refused without changing the database", async t => {
  const root = mkdtempSync(join(tmpdir(), "h23-fresh-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "house.sqlite3");
  const db = openCoordinationDatabase({ path: databasePath });
  const repository = new SqliteBotDirectoryRepository(db);
  await createBotDirectory({ repository, availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 } }).ensurePersistentBinding({ residentBinding: "existing", name: "Existing", purpose: "Keep my life", continuingIdentity: true, durableMailbox: true, requiredCapabilities: ["messages"], aliases: [] },
    { principalId: "user_owner", requestId: generateCoordinationId("request"), correlationId: generateCoordinationId("correlation") });
  db.close();
  const before = readFileSync(databasePath);
  await assert.rejects(provisionFreshHouse({ databasePath, ...definition }), /refuses an existing home/);
  assert.deepEqual(readFileSync(databasePath), before);
  await assert.rejects(provisionFreshHouse({ databasePath, ...definition, resident: { ...definition.resident, slug: "bot-owned" } }), /slug is invalid/);
  assert.deepEqual(readFileSync(databasePath), before);
});
