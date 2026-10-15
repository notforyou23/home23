import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkDiagnostics } from '../../../src/coordination/app/work-diagnostics.js';
import { workTerminalEvidence } from '../../../src/coordination/app/resident-outcomes.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { RESIDENT_OUTCOMES_MIGRATION_SQL } from '../../../src/coordination/migrations/0014-resident-outcomes.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, OWNER_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';
import type { CoordinationTurnOrigin } from '../../../src/agent/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
  const service = createWorkService({ database, generateId: createFixtureIdGenerator(), now: () => new Date(AT) });
  const work = service.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_work_thread', idempotencyKey: 'old-completed-work',
    manifest: manifestInput(), maxAutomaticOffers: 1, requestId: fixtureId('request', 90), correlationId: fixtureId('correlation', 90) }).work;
  const leases = createLeaseService({ database, generateId: createFixtureIdGenerator(100), now: () => new Date(AT), leaseTtlMs: 60000 });
  const ids = { requestId: fixtureId('request', 91), correlationId: fixtureId('correlation', 91) };
  const offer = leases.offer({ workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: 'resident-1',
    authorityReference: 'resident:jerry', automatic: true, ...ids });
  const binding = { workId: work.id, attemptId: offer.attempt.id, leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID, holderInstanceId: 'resident-1', fencingToken: offer.fencingToken, ...ids };
  leases.accept(binding); leases.start(binding);
  leases.terminalize({ ...binding, receipt: { status: 'succeeded', sourceReference: 'resident:jerry',
    resultDigest: 'a'.repeat(64), artifactIds: [], timestamp: AT } });
  // The current caller remains a separate authenticated turn. The exact target
  // can be older than the assignment discovery policy or on an archived channel.
  const origin = { workId: work.id, holderPrincipalId: BOT_ID } as CoordinationTurnOrigin;
  const diagnostics = createWorkDiagnostics({ database, assignments: {
    list: () => assert.fail('An exact Work lookup must not enumerate assignment history'),
    direction: () => ({ ownerMessageSequence: 1, acknowledgedSequence: 1 }),
  } });
  return { database, work, origin, diagnostics, attemptId: offer.attempt.id };
}

test('exact old terminal Work is returned without enumerating resident assignments, including an archived channel', t => {
  const f = fixture(t);
  f.database.raw.prepare("UPDATE channels SET lifecycle='archived' WHERE id=?").run(CHANNEL_ID);
  const result = f.diagnostics(BOT_ID, { operation: 'work_status', work_id: `  ${f.work.id}  ` }, f.origin);
  assert.equal(result.lookup?.status, 'found');
  assert.equal(result.work.length, 1);
  assert.equal(result.work[0].id, f.work.id);
  assert.equal(result.work[0].state, 'succeeded');
  assert.deepEqual(result.work[0].terminalEvidence, []);
  assert.equal(result.ownerMessageSequence, 1);
  assert.equal(result.acknowledgedSequence, 1);
  assert.deepEqual(result.unseenOwnerMessages, []);
});

test('missing and other-resident exact Work return a clear scoped not-found result', t => {
  const f = fixture(t);
  for (const [principal, id] of [[BOT_ID, fixtureId('work', 999)], ['another-resident', f.work.id]]) {
    const result = f.diagnostics(principal, { operation: 'work_status', work_id: id }, f.origin);
    assert.equal(result.lookup?.status, 'not_found');
    assert.match(result.lookup?.message ?? '', /not found.*resident scope.*archived/iu);
    assert.deepEqual(result.work, []);
  }
});

test('missing terminal evidence seeks only the Work-bound turn index', t => {
  const f = fixture(t);
  const readAll = f.database.readAll.bind(f.database);
  let plan: string[] = [];
  f.database.readAll = (<T>(sql: string, ...parameters: any[]): T[] => {
    if (sql.includes('communication.recorded')) {
      plan = f.database.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
        .map((row: any) => row.detail);
    }
    return readAll<T>(sql, ...parameters);
  }) as typeof f.database.readAll;
  assert.deepEqual(workTerminalEvidence(f.database, f.work.id), []);
  assert.match(plan.join('\n'), /communication_events_turn_sequence \(<expr>>\? AND <expr><\?\)/);
  assert.doesNotMatch(plan.join('\n'), /events_type_sequence/);
});


test('terminal evidence includes recovered turns and excludes stale attempts, wrong Work, tool results and unrelated history', t => {
  const f = fixture(t);
  const record = (n: number, communication: Record<string, unknown>) => f.database.mutateWithEvent(() => ({
    value: undefined, event: { type: 'communication.recorded', aggregateKind: 'communication',
      aggregateId: `work-evidence-${n}`, aggregateVersion: 1, channelId: CHANNEL_ID,
      actorPrincipalId: BOT_ID, requestId: fixtureId('request', 200 + n), correlationId: fixtureId('correlation', 200 + n),
      payload: { communication }, createdAt: AT },
  }));
  const correct = { workId: f.work.id, attemptId: f.attemptId, turnId: `coord-${f.work.id}`,
    source: { sourceEventType: 'turn.terminal' }, terminal: true, payload: { status: 'succeeded', marker: 'base' } };
  record(1, correct);
  record(2, { ...correct, turnId: `coord-${f.work.id}-recovery-2`, payload: { marker: 'recovered' } });
  record(3, { ...correct, workId: fixtureId('work', 999), payload: { marker: 'wrong-work' } });
  record(4, { ...correct, attemptId: fixtureId('attempt', 999), payload: { marker: 'stale-attempt' } });
  record(5, { ...correct, source: { sourceEventType: 'agent.tool_result' }, payload: { marker: 'tool-result' } });
  record(6, { ...correct, turnId: 'unrelated-turn', payload: { marker: 'unrelated-turn' } });
  record(7, { ...correct, turnId: null, payload: { marker: 'unbound-legacy-evidence' } });
  // This history is newer than the old Work. It must never widen the lookup
  // from the exact Work's turns to every resident's later communication.
  for (let n = 8; n < 128; n++) record(n, { ...correct, workId: fixtureId('work', n),
    turnId: `coord-${fixtureId('work', n)}`, payload: { marker: 'other-work', padding: 'x'.repeat(1000) } });
  const evidence = workTerminalEvidence(f.database, f.work.id);
  assert.equal(evidence.length, 1);
  assert.match(JSON.stringify(evidence), /recovered/);
  assert.doesNotMatch(JSON.stringify(evidence), /wrong-work|stale-attempt|tool-result|unrelated-turn|unbound-legacy|other-work/);
  f.database.raw.prepare("DELETE FROM events WHERE aggregate_kind='work' AND aggregate_id=?").run(f.work.id);
  assert.deepEqual(workTerminalEvidence(f.database, f.work.id), evidence, 'retained terminal evidence does not depend on a retained Work creation event');
});


test('work_list still returns the assignment view and rejects a missing exact status ID', t => {
  const f = fixture(t);
  let calls = 0;
  const assignments = [{ id: 'assignment', state: 'running' }];
  const diagnostics = createWorkDiagnostics({ database: f.database, assignments: {
    list: (principalId, includeTerminal, limit) => {
      calls++;
      assert.equal(principalId, BOT_ID); assert.equal(includeTerminal, true); assert.equal(limit, 3);
      return assignments;
    }, direction: () => ({ ownerMessageSequence: 9, acknowledgedSequence: 7 }),
  } });
  const result = diagnostics(BOT_ID, { operation: 'work_list', assignments_only: true, include_terminal: true, limit: 3 }, f.origin);
  assert.deepEqual(result.work, assignments);
  assert.deepEqual(result.assignments, assignments);
  assert.equal(result.ownerMessageSequence, 9);
  assert.equal(calls, 1);
  assert.throws(() => diagnostics(BOT_ID, { operation: 'work_status', work_id: ' ' }, f.origin), /work_id is required/);
});
