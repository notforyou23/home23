import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createResidentExecutionFeedbackProjection } from '../../../src/coordination/app/resident-execution-feedback.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { createLeaseService } from '../../../src/coordination/leases/service.js';
import { EventLedgerTailAdapter } from '../../../substrate/src/adapters/event-ledger-tail.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, OWNER_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';

function fixture(t: { after(fn: () => void): void }) {
  const database = M11TestDatabase.temporary();
  const root = mkdtempSync(join(tmpdir(), 'execution-feedback-'));
  t.after(() => { database.close(); rmSync(dirname(database.path), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  const generateId = createFixtureIdGenerator();
  const now = () => new Date(AT);
  const work = createWorkService({ database, generateId, now });
  const leases = createLeaseService({ database, generateId, now, leaseTtlMs: 60_000 });
  const directory = join(root, 'projection');
  const ledgerPath = join(root, 'jerry', 'brain', 'event-ledger.jsonl');
  const otherPath = join(root, 'forrest', 'brain', 'event-ledger.jsonl');
  const project = () => createResidentExecutionFeedbackProjection(database, directory,
    [{ slug: 'jerry', ledgerPath }, { slug: 'forrest', ledgerPath: otherPath }], { startSequence: 0 });
  const admit = (key = 'feedback-fixture') => work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn',
    idempotencyKey: key, manifest: manifestInput(), maxAutomaticOffers: 1,
    requestId: fixtureId('request', 20), correlationId: fixtureId('correlation', 20) }).work;
  function start(workId: string) {
    const ids = { requestId: fixtureId('request', 21), correlationId: fixtureId('correlation', 21) };
    const offer = leases.offer({ workId, holderPrincipalId: BOT_ID, holderInstanceId: 'resident-1', authorityReference: 'resident:jerry', automatic: true, ...ids });
    const binding = { workId, attemptId: offer.attempt.id, leaseId: offer.lease.id, holderPrincipalId: BOT_ID,
      holderInstanceId: 'resident-1', fencingToken: offer.fencingToken, ...ids };
    leases.accept(binding); leases.start(binding); return binding;
  }
  const terminalize = (binding: ReturnType<typeof start>, status: 'succeeded' | 'failed') => leases.terminalize({ ...binding,
    receipt: { status, sourceReference: 'resident:jerry', resultDigest: 'a'.repeat(64), artifactIds: [], timestamp: AT } });
  const read = () => existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { database, root, directory, ledgerPath, otherPath, project, admit, work, start, terminalize, read };
}

test('real Work receipt reaches the existing Seed mapper without converting queued or running Work into success', async t => {
  const f = fixture(t); const projection = f.project(); const work = f.admit();
  await projection.pump(64); assert.deepEqual(f.read(), []);
  const binding = f.start(work.id); await projection.pump(64); assert.deepEqual(f.read(), []);
  f.terminalize(binding, 'succeeded'); await projection.pump(64);
  const rows = f.read(); assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.status, 'completed'); assert.equal(rows[0].payload.declaredStatus, 'succeeded');
  assert.equal(rows[0].payload.verificationStatus, 'unknown'); assert.equal(rows[0].payload.taskOutcomeVerified, false);
  assert.equal(rows[0].payload.attemptId, binding.attemptId); assert.equal(rows[0].timestamp, AT);
  assert.match(rows[0].payload.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(f.otherPath), false, 'another resident does not inherit this Work');
  const adapter = new EventLedgerTailAdapter({ sourcePath: f.ledgerPath, cursorDir: join(f.root, 'seed'), fromEnd: false });
  const events = await adapter.pull(); assert.equal(events.length, 1);
  assert.equal(events[0]!.category, 'consequence');
  assert.match(String(events[0]!.payload.head), /verification unknown|not independently verified/);
  assert.equal(events[0]!.payload.verificationStatus, 'unknown');
  assert.equal(f.database.readOne<{ count: number }>('SELECT count(*) AS count FROM works')!.count, 1, 'projection cannot self-create tasks');
});

test('late current-attempt terminal evidence reaches Seed and stale attempts/tool results cannot replace the cause', async t => {
  const f = fixture(t); const projection = f.project(); const work = f.admit(); const binding = f.start(work.id);
  f.terminalize(binding, 'failed'); await projection.pump(64);
  for (const [index, attemptId, sourceEventType, error] of [
    [1, binding.attemptId, 'turn.terminal', 'provider_failed_after_dispatch'],
    [2, binding.attemptId, 'agent.tool_result', 'wrong_tool_error'],
    [3, 'stale-attempt', 'turn.terminal', 'stale_attempt_error'],
  ] as const) f.database.mutateWithEvent(() => ({ value: undefined, event: {
    type: 'communication.recorded', aggregateKind: 'communication', aggregateId: `terminal-${index}`, aggregateVersion: 1,
    channelId: CHANNEL_ID, actorPrincipalId: BOT_ID, requestId: fixtureId('request', 40 + index), correlationId: fixtureId('correlation', 40 + index),
    payload: { communication: { workId: work.id, attemptId, source: { sourceEventType }, terminal: true,
      payload: { status: 'failed', residentTerminal: { errorMessage: error } } } }, createdAt: AT,
  } }));
  await projection.pump(64);
  const rows = f.read(); assert.equal(rows.length, 2);
  assert.equal(rows[1].payload.evidenceStage, 'terminal_evidence');
  assert.match(rows[1].payload.head, /provider_failed_after_dispatch/);
  assert.doesNotMatch(JSON.stringify(rows), /wrong_tool_error|stale_attempt_error/);
  const events = await new EventLedgerTailAdapter({ sourcePath: f.ledgerPath, cursorDir: join(f.root, 'seed'), fromEnd: false }).pull();
  assert.deepEqual(events.map(event => event.category), ['correction', 'correction']);
});

test('lost cursor and an append-before-cursor crash cannot duplicate canonical outcomes', async t => {
  const f = fixture(t); const work = f.admit();
  f.work.cancelQueued({ workId: work.id, actorPrincipalId: OWNER_ID, reasonCode: 'operator_stop', sourceReference: 'owner:stop',
    timestamp: AT, requestId: fixtureId('request', 50), correlationId: fixtureId('correlation', 50) });
  await f.project().pump(64);
  assert.equal(f.read().length, 1); assert.equal(f.read()[0].payload.status, 'cancelled');
  // Recovery must search backwards beyond one block through other writers' events.
  appendFileSync(f.ledgerPath, Array.from({ length: 100 }, () => JSON.stringify({ event_type: 'Other', payload: 'x'.repeat(1000) }) + '\n').join(''));
  rmSync(join(f.directory, 'execution-feedback-cursor.json'));
  await f.project().pump(64);
  assert.equal(f.read().filter(row => row.event_type === 'ExecutionOutcomeObserved').length, 1);
  writeFileSync(join(f.directory, 'execution-feedback-cursor.json'), '{"eventSequence":0,"delivered":{}}');
  await f.project().pump(64);
  assert.equal(f.read().filter(row => row.event_type === 'ExecutionOutcomeObserved').length, 1);
});

test('torn ledger tail fails closed without advancing canonical progress', async t => {
  const f = fixture(t); const work = f.admit();
  f.work.cancelQueued({ workId: work.id, actorPrincipalId: OWNER_ID, reasonCode: 'operator_stop', sourceReference: 'owner:stop',
    timestamp: AT, requestId: fixtureId('request', 60), correlationId: fixtureId('correlation', 60) });
  mkdirSync(dirname(f.ledgerPath), { recursive: true }); writeFileSync(f.ledgerPath, '{"event_type":');
  await assert.rejects(f.project().pump(), /Incomplete execution feedback ledger tail/);
  assert.equal(existsSync(join(f.directory, 'execution-feedback-cursor.json')), false);
  assert.equal(readFileSync(f.ledgerPath, 'utf8'), '{"event_type":');
});

test('first activation lives forward from its captured head without replaying old Work', async t => {
  const f = fixture(t);
  const old = f.admit('old-work-before-activation'); f.terminalize(f.start(old.id), 'failed');
  const projection = createResidentExecutionFeedbackProjection(f.database, f.directory, [{ slug: 'jerry', ledgerPath: f.ledgerPath }]);
  // A completion committed after construction but before async startup is kept.
  const fresh = f.admit('new-work-after-activation'); f.terminalize(f.start(fresh.id), 'failed');
  await projection.pump(64);
  assert.deepEqual(f.read().map(row => row.payload.workId), [fresh.id]);
  rmSync(join(f.directory, 'execution-feedback-cursor.json'));
  const resumed = createResidentExecutionFeedbackProjection(f.database, f.directory, [{ slug: 'jerry', ledgerPath: f.ledgerPath }]);
  await resumed.pump(64);
  assert.deepEqual(f.read().map(row => row.payload.workId), [fresh.id], 'lost cursor retains the original activation floor');
});

test('a shadow process with no destinations does not scan the journal or create a feedback cursor', async t => {
  const f = fixture(t);
  const projection = createResidentExecutionFeedbackProjection(f.database, f.directory, []);
  const original = f.database.readAll;
  f.database.readAll = () => { throw new Error('empty feedback projection must not scan events'); };
  try {
    assert.equal((await projection.pump()).emitted, 0);
    assert.equal(existsSync(f.directory), false);
  } finally { f.database.readAll = original; }
});
