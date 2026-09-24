import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { createCoordinationProcess, disabledCoordinationFeatureFlags } from "../../../src/coordination/app/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { ConnectedAgentsDeliveryStore } from "../../../src/push/connected-agents-delivery-store.js";

test("Core listens while durable notification recovery crosses several bounded pages", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-notification-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, "instances", ".house", "coordination");
  mkdirSync(runtime, { recursive: true });
  const databasePath = join(runtime, "home23-coordination.sqlite3");
  openCoordinationDatabase({ path: databasePath }).close();
  const db = new Database(databasePath);
  db.pragma("foreign_keys = OFF");
  const stamp = "2026-09-02T12:00:00.000Z";
  const botId = "bot_0198d95f-6c00-7000-8000-000000000911";
  const channelId = "chn_0198d95f-6c00-7000-8000-000000000911";
  db.prepare("INSERT OR IGNORE INTO principals (id,kind,created_at) VALUES ('user_owner','owner',?)").run(stamp);
  db.prepare("INSERT INTO principals (id,kind,created_at) VALUES (?,'bot',?)").run(botId, stamp);
  db.prepare(`INSERT INTO channels
    (id,kind,title,purpose,owner_principal_id,responder_mode,coordinator_bot_id,response_order,
     max_bot_turns,lifecycle,pinned,version,next_message_sequence,created_at,updated_at)
    VALUES (?,'group','Recovery','', 'user_owner','mentions_only',NULL,'parallel',1,'active',0,1,71,?,?)`)
    .run(channelId, stamp, stamp);
  db.prepare(`INSERT INTO channel_members
    (channel_id,principal_id,kind,role,active,joined_at,left_at)
    VALUES (? ,?,'bot','member',1,?,NULL)`).run(channelId, botId, stamp);
  db.prepare("INSERT INTO conversation_handles (id,channel_id,created_at) VALUES (?,?,?)")
    .run("cnv_0198d95f-6c00-7000-8000-000000000911", channelId, stamp);
  const insert = db.prepare(`INSERT INTO messages
    (id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,
     kind,body_text,stored_visibility,created_at)
    VALUES (?,?,?,?,'bot','Jerry','result','answer','visible',?)`);
  const ids: string[] = [];
  db.transaction(() => {
    for (let index = 0; index < 70; index += 1) {
      const id = `msg_0198d95f-6c00-7000-8000-${String(index).padStart(12, "0")}`;
      ids.push(id);
      insert.run(id, channelId, index + 1, botId,
        new Date(Date.parse(stamp) + index * 1_000).toISOString());
    }
  })();
  db.close();

  const keyPath = join(root, "apns.p8");
  writeFileSync(keyPath, "unused without registered devices");
  const registryPath = join(runtime, "devices.json");
  const store = new ConnectedAgentsDeliveryStore(`${registryPath}.connected-agents-delivery-receipts`);
  store.initializeCheckpoint(null);
  const process = createCoordinationProcess({
    enabled: true, host: "127.0.0.1", port: 0,
    databasePath, socketPath: join(runtime, "coord.sock"),
    capabilityToken: "c".repeat(64), residents: {},
    flags: { ...disabledCoordinationFeatureFlags(),
      "coordination.process.enabled": true, "coordination.public_api.enabled": true },
    push: { enabled: true, registryPath, apns: {
      team_id: "ABCDEFGHIJ", key_id: "ABCDEFGHIJ", key_path: keyPath,
      bundle_id: "com.regina6.home23.canary", default_env: "sandbox",
    } },
  });
  t.after(() => process.drain());
  const address = await process.start();
  assert.equal(store.checkpoint(), null, "startup should return before replay runs");
  assert.equal((await fetch(`${address.origin}/api/v1/capabilities`)).status, 200);
  const deadline = Date.now() + 5_000;
  while (store.checkpoint()?.message_id !== ids.at(-1)) {
    if (Date.now() > deadline) assert.fail("recovery did not reach the final Message");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
});
