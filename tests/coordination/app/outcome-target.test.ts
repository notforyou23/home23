import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { canRecoverOutcomeTarget } from '../../../src/coordination/app/outcome-target.js';

test('historical direct Bot outcome waits while group and current outcomes remain routable', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY, kind TEXT);
      CREATE TABLE conversation_handles (id TEXT PRIMARY KEY, channel_id TEXT);
      CREATE TABLE bots (principal_id TEXT PRIMARY KEY, resident_binding TEXT, conversation_id TEXT);
      INSERT INTO channels VALUES ('old-direct','direct'),('current-direct','direct'),('group','group');
      INSERT INTO conversation_handles VALUES ('old-conversation','old-direct'),('current-conversation','current-direct');
      INSERT INTO bots VALUES ('bot-1','bot-helper','current-conversation');`);
    const database = { readOne<T>(sql: string, ...args: unknown[]): T | undefined {
      return sqlite.prepare(sql).get(...args) as T | undefined;
    } };
    const source = (channelId: string, targetPrincipalId = 'bot-1') => ({ channelId, targetPrincipalId });
    assert.equal(canRecoverOutcomeTarget(database, source('old-direct')), false);
    assert.equal(canRecoverOutcomeTarget(database, source('current-direct')), true);
    assert.equal(canRecoverOutcomeTarget(database, source('group')), true);
    assert.equal(canRecoverOutcomeTarget(database, source('old-direct', 'missing-bot')), false);
    assert.equal(canRecoverOutcomeTarget(database, source('missing-channel')), false);
  } finally {
    sqlite.close();
  }
});
