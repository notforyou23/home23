import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openCoordinationDatabase } from '../../../src/coordination/db/index.js';
import { generateCoordinationId as id } from '../../../src/coordination/ids/index.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { repairScheduledChannelWork } from '../../../src/coordination/operations/repair-scheduled-channel-work.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, manifestInput } from '../work/test-fixture.js';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'home23-scheduled-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'coordination.sqlite3');
  const db = openCoordinationDatabase({ path });
  db.mutateWithEvent(tx => {
    tx.run("INSERT OR IGNORE INTO principals (id,kind,created_at) VALUES ('user_owner','owner',?)", AT);
    tx.run("INSERT INTO principals (id,kind,created_at) VALUES (?,'bot',?)", BOT_ID, AT);
    tx.run(`INSERT INTO bots (id,principal_id,name,purpose,lifecycle,resident_binding,continuing_identity,durable_mailbox,
      required_capabilities_json,resident_capabilities_json,version,created_at,updated_at)
      VALUES (?,?,'Jerry','Fixture','active','jerry',1,1,'["messages"]','["messages"]',1,?,?)`, BOT_ID, BOT_ID, AT, AT);
    tx.run(`INSERT INTO channels VALUES (?,'group','Scheduled','','user_owner','mentions_only',NULL,'parallel',1,'active',0,1,2,?,?)`, CHANNEL_ID, AT, AT);
    tx.run(`INSERT INTO channel_members VALUES (?,'user_owner','owner','owner',1,?,NULL),(?,?,'bot','member',1,?,NULL)`, CHANNEL_ID, AT, CHANNEL_ID, BOT_ID, AT);
    tx.run(`INSERT INTO messages (id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at)
      VALUES (?,?,1,?,'bot','Jerry','text','Scheduled fixture','visible',?)`, MESSAGE_ID, CHANNEL_ID, BOT_ID, AT);
    return { value: null, event: { type: 'message.appended', aggregateKind: 'message', aggregateId: MESSAGE_ID,
      aggregateVersion: 1, channelId: CHANNEL_ID, actorPrincipalId: BOT_ID, requestId: id('request'), correlationId: id('correlation'), payload: {}, createdAt: AT } };
  });
  const runId = 'sched-run-0198d95f-6c00-7000-8000-000000000011';
  db.mutateWithEvent(() => ({ value: null, event: { type: 'activity.updated', aggregateKind: 'scheduled_channel_run', aggregateId: runId,
    aggregateVersion: 1, channelId: CHANNEL_ID, actorPrincipalId: BOT_ID, requestId: id('request'), correlationId: id('correlation'), createdAt: AT,
    payload: { runId, jobId: 'fixture', channelId: CHANNEL_ID, messageId: MESSAGE_ID, botId: BOT_ID, prompt: 'Fixture' } } }));
  const work = createWorkService({ database: db, generateId: id, now: () => new Date(AT) }).create({
    principalId: BOT_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null,
    kind: 'channel.bot_turn', idempotencyKey: `scheduled:${runId}`, maxAutomaticOffers: 1, manifest: manifestInput(),
    requestId: id('request'), correlationId: id('correlation'), presentation: { title: 'Scheduled channel run', summary: 'Fixture' },
  }).work;
  const leases = createLeaseService({ database: db, generateId: id, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const offer = leases.offer({ workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: 'fixture',
    authorityReference: 'resident:fixture', automatic: true, requestId: id('request'), correlationId: id('correlation') });
  const binding = { workId: work.id, attemptId: offer.attempt.id, leaseId: offer.lease.id, holderPrincipalId: BOT_ID,
    holderInstanceId: 'fixture', fencingToken: offer.fencingToken, requestId: id('request'), correlationId: id('correlation') };
  leases.accept(binding); leases.start(binding);
  const origin = { kind: 'coordination', ...binding, authorityReference: 'resident:fixture', channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null };
  const { requestId: _, correlationId: __, ...journalOrigin } = origin;
  db.close();
  const journal = join(root, 'turn.jsonl');
  function writeJournal(status: string, patch: Record<string, unknown> = {}, media = false) {
    const chat = `coordination:${CHANNEL_ID}:${work.id}`, turn = `coord-${work.id}`;
    const rows: unknown[] = [{ type: 'turn', turn_id: turn, chat_id: chat, status: 'pending', role: 'assistant', started_at: AT,
      coordination_origin: { ...journalOrigin, ...patch } }];
    if (media) rows.push({ type: 'event', turn_id: turn, seq: 1, ts: AT, kind: 'media', data: {} });
    rows.push({ role: 'assistant', content: 'Completed fixture', ts: AT });
    rows.push({ type: 'turn', turn_id: turn, chat_id: chat, status, role: 'assistant', started_at: '', ended_at: '2026-08-25T16:01:00.000Z',
      error_code: status === 'timeout' ? 'deadline_reached' : undefined, last_seq: 1 });
    writeFileSync(journal, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  return { root, path, journal, workId: work.id, binding, writeJournal };
}

for (const [status, target] of [['stopped', 'cancelled'], ['complete', 'succeeded'], ['timeout', 'failed']] as const) {
  test(`read-only plan repairs only exact ${status} journal truth`, async t => {
    const f = fixture(t); f.writeJournal(status);
    const before = hash(f.path);
    const plan = await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID, journalPaths: [f.journal] });
    assert.equal(plan.status, 'inspected'); assert.equal(plan.mode, 'dry-run');
    assert.deepEqual(plan.repairIds, [f.workId]); assert.equal(plan.items[0]?.targetState, target);
    assert.equal(hash(f.path), before); assert.equal(existsSync(`${f.path}.manifest.json`), false);
    f.writeJournal(status, { fencingToken: f.binding.fencingToken + 1 });
    const wrong = await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID, journalPaths: [f.journal] });
    assert.deepEqual(wrong.repairIds, []); assert.equal(wrong.items[0]?.disposition, 'skipped');
  });
}

test('offline apply uses verified prewrite backup and product lifecycle, and repeating apply is idempotent', async t => {
  const f = fixture(t); f.writeJournal('stopped');
  const backupPath = join(f.root, 'before.sqlite3');
  const result = await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID,
    journalPaths: [f.journal], apply: true, coreStopped: true, backupPath });
  assert.deepEqual(result.appliedIds, [f.workId]); assert.ok(existsSync(`${backupPath}.manifest.json`));
  const before = new Database(backupPath, { readonly: true });
  assert.equal(before.prepare('SELECT state FROM works WHERE id=?').get(f.workId)?.state, 'running'); before.close();
  const db = openCoordinationDatabase({ path: f.path });
  assert.equal(db.readOne<{ state: string }>('SELECT state FROM works WHERE id=?', f.workId)?.state, 'cancelled');
  assert.equal(db.readOne<{ state: string }>('SELECT state FROM attempts WHERE id=?', f.binding.attemptId)?.state, 'cancelled');
  assert.equal(db.readOne<{ state: string }>('SELECT state FROM leases WHERE id=?', f.binding.leaseId)?.state, 'revoked');
  assert.equal(db.readOne<{ status: string }>('SELECT terminal_status AS status FROM terminal_receipts WHERE work_id=?', f.workId)?.status, 'cancelled');
  assert.equal(db.readOne<{ count: number }>("SELECT count(*) AS count FROM outbox WHERE kind='work.terminal' AND aggregate_id=?", f.workId)?.count, 1);
  const events = db.readOne<{ count: number }>('SELECT count(*) AS count FROM events')!.count; db.close();
  const replay = await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID,
    journalPaths: [f.journal], apply: true, coreStopped: true, backupPath: join(f.root, 'again.sqlite3') });
  assert.deepEqual(replay.repairIds, []); assert.deepEqual(replay.appliedIds, []); assert.equal(replay.items[0]?.disposition, 'already_terminal');
  const check = new Database(f.path, { readonly: true });
  assert.equal(check.prepare('SELECT count(*) AS count FROM events').get()?.count, events); check.close();
});

test('unsafe or ambiguous evidence is skipped; apply refuses absent operator acknowledgement or backup', async t => {
  const f = fixture(t); const before = hash(f.path);
  assert.deepEqual((await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID })).repairIds, []);
  f.writeJournal('complete', {}, true);
  assert.deepEqual((await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID, journalPaths: [f.journal] })).repairIds, []);
  await assert.rejects(repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID, apply: true }), /core.*stopped/i);
  await assert.rejects(repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID, apply: true, coreStopped: true }), /backup/i);
  assert.equal(hash(f.path), before);
});

test('dry-run reports an exclusive Core lock without claiming it inspected Work', async t => {
  const f = fixture(t); const db = openCoordinationDatabase({ path: f.path });
  try {
    const result = await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID });
    assert.equal(result.status, 'locked'); assert.deepEqual(result.items, []); assert.deepEqual(result.repairIds, []);
    const backupPath = join(f.root, 'no-active-backup.sqlite3');
    await assert.rejects(repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID,
      apply: true, coreStopped: true, backupPath }), /locked/i);
    assert.equal(existsSync(backupPath), false);
  } finally { db.close(); }
});

test('contradictory durable endings cannot establish terminal truth for repair', async t => {
  const f = fixture(t); f.writeJournal('complete');
  const records = readFileSync(f.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  records.push({ ...records.at(-1), status: 'stopped', ended_at: '2026-08-25T16:02:00.000Z' });
  writeFileSync(f.journal, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const result = await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID, journalPaths: [f.journal] });
  assert.deepEqual(result.repairIds, []); assert.equal(result.items[0]?.disposition, 'skipped');
});

test('schema mismatch is refused without migration or backup, and an existing backup is never overwritten', async t => {
  const f = fixture(t); f.writeJournal('stopped');
  const backupPath = join(f.root, 'before.sqlite3'); writeFileSync(backupPath, 'preserve');
  await assert.rejects(repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID, apply: true, coreStopped: true, backupPath }), /exist/i);
  assert.equal(readFileSync(backupPath, 'utf8'), 'preserve');
  const raw = new Database(f.path); raw.pragma('user_version = 999'); raw.close();
  const before = hash(f.path);
  await assert.rejects(repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID, apply: true, coreStopped: true, backupPath: join(f.root, 'no.sqlite3') }), /newer schema/i);
  assert.equal(hash(f.path), before); assert.equal(existsSync(join(f.root, 'no.sqlite3')), false);
});

test('current-attempt communication requires payload digest, actor, and exact binding', async t => {
  const f = fixture(t);
  const db = openCoordinationDatabase({ path: f.path });
  const payload = { communication: { turnId: `coord-${f.workId}`, workId: f.workId, attemptId: f.binding.attemptId,
    channelId: CHANNEL_ID, actor: { principalId: BOT_ID }, terminal: true, occurredAt: AT,
    payload: { status: 'failed', sourceReference: 'resident:fixture', resultDigest: 'a'.repeat(64), artifactIds: [] } } };
  db.mutateWithEvent(() => ({ value: null, event: { type: 'communication.recorded', aggregateKind: 'communication', aggregateId: CHANNEL_ID,
    aggregateVersion: 1, channelId: CHANNEL_ID, actorPrincipalId: BOT_ID, requestId: id('request'), correlationId: id('correlation'), createdAt: AT, payload } }));
  db.close();
  const plan = await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID });
  assert.deepEqual(plan.repairIds, [f.workId]); assert.equal(plan.items[0]?.evidence?.kind, 'communication');
  const raw = new Database(f.path);
  raw.prepare("UPDATE events SET payload_digest=? WHERE type='communication.recorded'").run('b'.repeat(64)); raw.close();
  assert.deepEqual((await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID })).repairIds, []);
});

test('terminal Work with a blocked scheduled assignment needs projection correction without a database rewrite', async t => {
  const f = fixture(t);
  const db = openCoordinationDatabase({ path: f.path });
  createLeaseService({ database: db, generateId: id, leaseTtlMs: 60_000 }).terminalize({ ...f.binding,
    receipt: { status: 'succeeded', sourceReference: 'resident:fixture', resultDigest: 'a'.repeat(64), artifactIds: [], timestamp: AT } });
  db.mutateWithEvent(() => ({ value: null, event: { type: 'activity.updated', aggregateKind: 'resident_assignment', aggregateId: f.workId,
    aggregateVersion: 1, channelId: CHANNEL_ID, actorPrincipalId: BOT_ID, requestId: id('request'), correlationId: id('correlation'), createdAt: AT,
    payload: { workId: f.workId, state: 'blocked' } } }));
  db.close(); const before = hash(f.path);
  const plan = await repairScheduledChannelWork({ databasePath: f.path, channelId: CHANNEL_ID });
  assert.deepEqual(plan.repairIds, []); assert.equal(plan.items[0]?.assignmentState, 'blocked');
  assert.equal(plan.items[0]?.state, 'succeeded'); assert.equal(plan.items[0]?.disposition, 'already_terminal');
  assert.match(plan.items[0]!.reason, /projection/); assert.equal(hash(f.path), before);
});
