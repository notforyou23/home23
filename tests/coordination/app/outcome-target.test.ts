import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { canRecoverOutcomeTarget } from '../../../src/coordination/app/outcome-target.js';

test('historical direct Bot outcome waits while group and current outcomes remain routable', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY, kind TEXT);
      CREATE TABLE conversation_handles (id TEXT PRIMARY KEY, channel_id TEXT);
      CREATE TABLE bots (principal_id TEXT PRIMARY KEY, resident_binding TEXT, lifecycle TEXT, conversation_id TEXT,
        continuing_identity INTEGER, durable_mailbox INTEGER, required_capabilities_json TEXT,
        active_instance_id TEXT, active_key_version INTEGER, resident_protocol_version INTEGER,
        resident_registered_at TEXT, resident_capabilities_json TEXT);
      INSERT INTO channels VALUES ('old-direct','direct'),('current-direct','direct'),('group','group');
      INSERT INTO conversation_handles VALUES ('old-conversation','old-direct'),('current-conversation','current-direct');
      INSERT INTO bots VALUES
        ('bot-1','bot-helper','active','current-conversation',1,1,'["messages"]',NULL,NULL,NULL,NULL,'[]'),
        ('bot-archived','bot-archived-helper','archived','current-conversation',1,1,'["messages"]',NULL,NULL,NULL,NULL,'[]'),
        ('bot-stale','bot-stale-helper','active','current-conversation',1,1,'["messages"]','old-instance',1,1,'2026-09-24T00:00:00.000Z','["messages"]'),
        ('bot-no-messages','bot-no-messages-helper','active','current-conversation',1,1,'["work"]',NULL,NULL,NULL,NULL,'[]'),
        ('resident','jerry','active','current-conversation',1,1,'["messages"]','jerry-instance',1,1,'2026-09-24T00:00:00.000Z','["messages"]');`);
    const database = { readOne<T>(sql: string, ...args: unknown[]): T | undefined {
      return sqlite.prepare(sql).get(...args) as T | undefined;
    } };
    const source = (channelId: string, targetPrincipalId = 'bot-1') => ({ channelId, targetPrincipalId });
    assert.equal(canRecoverOutcomeTarget(database, source('old-direct')), false);
    assert.equal(canRecoverOutcomeTarget(database, source('current-direct')), true);
    assert.equal(canRecoverOutcomeTarget(database, source('group')), true);
    assert.equal(canRecoverOutcomeTarget(database, source('group', 'bot-archived')), false);
    assert.equal(canRecoverOutcomeTarget(database, source('group', 'bot-stale')), false);
    assert.equal(canRecoverOutcomeTarget(database, source('group', 'bot-no-messages')), false);
    assert.equal(canRecoverOutcomeTarget(database, source('old-direct', 'resident')), true);
    assert.equal(canRecoverOutcomeTarget(database, source('old-direct', 'missing-bot')), false);
    assert.equal(canRecoverOutcomeTarget(database, source('missing-channel')), false);
    sqlite.prepare(`UPDATE bots SET active_instance_id=NULL, active_key_version=NULL,
      resident_protocol_version=NULL, resident_registered_at=NULL, resident_capabilities_json='[]'
      WHERE principal_id='bot-stale'`).run();
    assert.equal(canRecoverOutcomeTarget(database, source('group', 'bot-stale')), true,
      'a pending outcome becomes eligible again when the Bot identity is repaired');
  } finally {
    sqlite.close();
  }
});
