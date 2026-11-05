import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResidentContactProjection } from '../../../src/coordination/app/resident-contact.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { createConversationShipper } from '../../../substrate/src/conversation-shipper.js';
import { SeedRunner } from '../../../substrate/src/runner.js';
import { probeShipperFlow } from '../../../substrate/bin/organ-probes.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, OWNER_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';

function fixture(t: { after(fn: () => void): void }) {
  const database = M11TestDatabase.temporary();
  const root = mkdtempSync(join(tmpdir(), 'resident-contact-'));
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
  database.raw.prepare('INSERT INTO conversation_handles(id,channel_id,created_at) VALUES(?,?,?)')
    .run(fixtureId('conversation', 1), CHANNEL_ID, AT);
  const directory = join(root, 'instances', '.house', 'coordination', 'resident-contact');
  const conversationsDir = join(root, 'instances', 'jerry', 'conversations');
  mkdirSync(conversationsDir, { recursive: true });
  const coordinationSource = join(directory, 'jerry.jsonl');
  const streamPath = join(root, 'instances', 'jerry', 'substrate', 'conversation-stream.jsonl');
  const work = createWorkService({ database, generateId: createFixtureIdGenerator(), now: () => new Date(AT) });
  function admit(key = 'owner-request-idempotency') {
    return work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
      originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn', idempotencyKey: key,
      manifest: manifestInput(), maxAutomaticOffers: 1,
      requestId: fixtureId('request', 20), correlationId: fixtureId('correlation', 20) });
  }
  const project = () => createResidentContactProjection(database, directory, ['jerry', 'forrest']);
  return { database, root, directory, conversationsDir, coordinationSource, streamPath, admit, project };
}

test('canonical owner contact reaches the existing Seed transition once across projection and shipper recovery', async t => {
  const f = fixture(t);
  // Private runtime-role user prompts are not contact.
  writeFileSync(join(f.conversationsDir, 'jerry__coordination_private.jsonl'), JSON.stringify({
    role: 'user', content: 'INTERNAL WORK OUTCOME: launch another worker', ts: AT,
  }) + '\n');
  const projection = f.project();
  projection.pump();
  assert.equal(existsSync(f.coordinationSource), false, 'unreceived messages are not broadcast');
  f.admit(); projection.pump(); f.admit('second-attempt-idempotency'); projection.pump();
  assert.equal(existsSync(join(f.directory, 'forrest.jsonl')), false, 'Jerry contact stays private');
  const contact = JSON.parse(readFileSync(f.coordinationSource, 'utf8'));
  assert.equal(contact.actor.principalId, OWNER_ID);
  assert.equal(contact.content, 'not exposed');
  assert.equal(contact.ts, AT, 'recovery retains original event time');
  writeFileSync(join(f.directory, 'cursor.json'), '{"eventSequence":0}');
  f.project().pump();
  assert.equal(readFileSync(f.coordinationSource, 'utf8').trim().split('\n').length, 1);
  assert.equal(probeShipperFlow('jerry', f.root).ok, false, 'unshipped canonical contact is visible to health');
  let perceptions = 0;
  const options = { conversationsDir: f.conversationsDir, coordinationSource: f.coordinationSource,
    streamPath: f.streamPath, cursorPath: `${f.streamPath}.cursor.json`, backfillBytes: 100_000,
    maxAgeDays: 14, embed: () => { perceptions++; return null; } };
  assert.equal(createConversationShipper(options).pass(), 1);
  writeFileSync(options.cursorPath, '{}');
  assert.equal(createConversationShipper(options).pass(), 0, 'lost cursor cannot duplicate experience');
  assert.equal(perceptions, 1, 'recovery does not re-perceive existing contact');
  assert.equal(probeShipperFlow('jerry', f.root).ok, true);
  const emptySource = join(f.root, 'empty.jsonl'); writeFileSync(emptySource, '');
  const runner = new SeedRunner({ stateDir: join(f.root, 'test-seed'), sourcePath: emptySource,
    extraSources: [{ sourcePath: f.streamPath, sourceType: 'conversation-stream', id: 'conversation', backfillBytes: 1_000_000 }] });
  runner.start();
  try {
    const report = await runner.tick();
    assert.equal(report.transitioned, 1, 'the existing Seed consumes authentic app contact');
    assert.equal((await runner.tick()).transitioned, 0);
    const ledger = readFileSync(join(f.root, 'test-seed', 'seed-ledger.jsonl'), 'utf8');
    assert.match(ledger, /conversation\.jtr:coordination\.message:/);
    assert.doesNotMatch(ledger, /INTERNAL WORK OUTCOME/);
  } finally { runner.stop(); }
});

test('scheduled instructions are not exported as owner contact', t => {
  const f = fixture(t);
  f.database.mutateWithEvent(() => ({ value: undefined, event: { type: 'activity.updated',
    aggregateKind: 'scheduled_channel_run', aggregateId: 'scheduled-fixture', aggregateVersion: 1,
    channelId: CHANNEL_ID, actorPrincipalId: BOT_ID, requestId: fixtureId('request', 30),
    correlationId: fixtureId('correlation', 30), payload: { messageId: MESSAGE_ID }, createdAt: AT } }));
  f.admit(); f.project().pump();
  assert.equal(existsSync(f.coordinationSource), false);
});

test('the current app cannot be hidden behind healthy older conversation files', t => {
  const f = fixture(t);
  const old = { role: 'user', content: 'older conversation', ts: AT };
  writeFileSync(join(f.conversationsDir, 'jerry__ios_old.jsonl'), JSON.stringify(old) + '\n');
  writeFileSync(join(f.conversationsDir, 'jerry__coordination_current.jsonl'), JSON.stringify({ ...old, content: 'new contact' }) + '\n');
  mkdirSync(join(f.root, 'instances', 'jerry', 'substrate'));
  writeFileSync(f.streamPath, JSON.stringify(old) + '\n');
  const result = probeShipperFlow('jerry', f.root);
  assert.equal(result.ok, false);
  assert.match(result.why, /canonical resident contact feed is missing/);
});
