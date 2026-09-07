import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResidentAssignments } from '../../../src/coordination/app/resident-assignments.js';
import { createResidentOutcomeStore } from '../../../src/coordination/app/resident-outcomes.js';
import { projectResidentWork } from '../../../src/coordination/app/resident-work-projection.js';
import { createForegroundDetachmentConsumer } from '../../../src/coordination/app/foreground-detachments.js';
import { createWorkService } from '../../../src/coordination/work/service.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { RESIDENT_OUTCOMES_MIGRATION_SQL } from '../../../src/coordination/migrations/0014-resident-outcomes.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, OWNER_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';
import type { CoordinationTurnOrigin } from '../../../src/agent/types.js';
import type { MessagingActorContext } from '../../../src/coordination/channels/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  database.raw.exec(RESIDENT_OUTCOMES_MIGRATION_SQL);
  database.raw.prepare('UPDATE resident_outcome_policy SET enabled_at=?').run(AT);
  database.raw.prepare("UPDATE bots SET active_instance_id='instance-jerry',active_key_version=1 WHERE id=?").run(BOT_ID);
  const generateId = createFixtureIdGenerator(), now = () => new Date(AT);
  const work = createWorkService({ database, generateId, now });
  const leases = createLeaseService({ database, generateId, now, leaseTtlMs: 60000 });
  const identity = { requestId: fixtureId('request', 10), correlationId: fixtureId('correlation', 10) };
  const context = { principalId: BOT_ID, ...identity } as MessagingActorContext;
  const parent = work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID, roundId: null, kind: 'resident_turn', idempotencyKey: 'parent-speaking-idempotency',
    manifest: manifestInput(), maxAutomaticOffers: 1, ...identity }).work;
  const offer = leases.offer({ workId: parent.id, holderPrincipalId: BOT_ID, holderInstanceId: 'instance-jerry', authorityReference: 'resident:jerry', automatic: true, ...identity });
  const binding = { workId: parent.id, attemptId: offer.attempt.id, leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID, holderInstanceId: 'instance-jerry', fencingToken: offer.fencingToken, ...identity };
  leases.accept(binding); leases.start(binding);
  const origin: CoordinationTurnOrigin = { kind: 'coordination', ...binding, authorityReference: 'resident:jerry', channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null };
  const credential = { residentSlug: 'jerry', instanceId: 'client-jerry', keyVersion: 1 };
  const consumer = createForegroundDetachmentConsumer({ database, work, now, schedule: () => {},
    resolveResident: () => ({ clientInstanceId: 'client-jerry', serverInstanceId: 'instance-jerry', keyVersion: 1 }) });
  const admit = (invocationId: string) => consumer.admit({ credential, request: { parentOrigin: origin,
    residentSlug: 'jerry', invocationId, toolName: 'spawn_agent', canonicalArgs: { task: 'Verify the repair' },
    executionInstruction: 'Verify the repair', title: 'Repair the launcher', summary: 'Running and verified', recoveryPolicy: 'safe_before_start' } }).workId;
  const cancel = (id: string) => work.cancelQueued({ workId: id, actorPrincipalId: OWNER_ID, reasonCode: 'operator_stop', sourceReference: 'owner:stop', timestamp: AT, ...identity });
  const assignments = createResidentAssignments(database);
  return { database, work, origin, context, consumer, admit, cancel, assignments };
}

test('execution termination remains an obligation until the resident records its assessed outcome', t => {
  const f = fixture(t), id = f.admit('first');
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: id, state: 'complete', summary: 'Done', evidence: ['receipt:one'] }, 'active-completion'), /active execution/);
  f.cancel(id);
  assert.throws(() => f.assignments.assertOpen(id), /cancelled/);
  assert.equal(f.assignments.list(BOT_ID).length, 0);
  assert.equal(f.assignments.list(BOT_ID, true)[0].assignmentState, 'cancelled');
  const args = { work_id: id, state: 'blocked', summary: 'Code saved; activation remains unverified', evidence: ['file:repair'] };
  f.assignments.report(f.context, f.origin, args, 'blocked-report');
  const outcomes = createResidentOutcomeStore(f.database);
  outcomes.discover();
  outcomes.update(outcomes.pending()[0], 'settled_at', AT);
  f.database.reopen();
  assert.equal(f.assignments.list(BOT_ID)[0].assignmentState, 'blocked', 'a delivered explanation does not settle the obligation');
  assert.equal(f.assignments.report(f.context, f.origin, args, 'blocked-report').replayed, true);
  assert.throws(() => f.assignments.report(f.context, f.origin, { ...args, summary: 'Changed' }, 'blocked-report'), /replay changed/);
  assert.throws(() => f.assignments.assertOpen(id), /blocked/);
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: id, state: 'complete', summary: 'Done' }, 'missing-evidence'), /evidence/);
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'complete', summary: 'Running behavior inspected', evidence: ['receipt:live-verification'] }, 'verified-report');
  assert.equal(f.assignments.list(BOT_ID).length, 0);
  assert.equal(f.assignments.list(BOT_ID, true)[0].assignmentState, 'complete');
  assert.throws(() => f.assignments.assertOpen(id), /complete/);
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: id, state: 'active', summary: 'Another attempt' }, 'late-reopen'), /newer canonical owner request/);
});

test('a canonical stop supersedes an earlier active assessment without relying on a new chat message', t => {
  const f = fixture(t), id = f.admit('first');
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'active', summary: 'Execution underway' }, 'before-stop');
  f.cancel(id);
  assert.throws(() => f.assignments.assertOpen(id), /cancelled/);
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: id, state: 'active', summary: 'Try again' }, 'late-restart'), /newer canonical owner request/);
});

test('a dependency wakes the same unfinished assignment once, with separate resident scope', t => {
  const f = fixture(t), id = f.admit('first'), dependency = f.admit('dependency');
  f.cancel(id);
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'blocked', summary: 'Waiting for the verifier', wait_for: [dependency] }, 'dependency-report');
  assert.equal(f.assignments.revisits().length, 0);
  f.cancel(dependency);
  const store = createResidentOutcomeStore(f.database);
  store.discover(); store.discover();
  assert.equal(store.pending().filter(row => row.key.startsWith('assignment-revisit:')).length, 1);
  f.database.reopen(); createResidentOutcomeStore(f.database).discover();
  assert.equal(store.pending().filter(row => row.key.startsWith('assignment-revisit:')).length, 1);
  assert.throws(() => f.assignments.report({ ...f.context, principalId: fixtureId('bot', 2) }, f.origin,
    { work_id: id, state: 'active', summary: 'Other resident' }, 'outside-scope'), /resident scope/);
});

test('changed direction requires explicit assessment; newly admitted children inherit that read without another launch attempt', t => {
  const f = fixture(t);
  f.database.mutateWithEvent(tx => {
    tx.run(`INSERT INTO messages(id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at)
      VALUES(?,?,2,?,'owner','Owner','text','Continue the repair; also tell me what you found.','visible',?)`, fixtureId('message', 900), CHANNEL_ID, OWNER_ID, AT);
    return { value: undefined, event: { type: 'message.appended', aggregateKind: 'message', aggregateId: fixtureId('message', 900), aggregateVersion: 1,
      channelId: CHANNEL_ID, actorPrincipalId: OWNER_ID, requestId: fixtureId('request', 900), correlationId: fixtureId('correlation', 900), payload: {}, createdAt: AT } };
  });
  assert.throws(() => f.admit('stale'), /Owner direction changed/);
  assert.throws(() => f.assignments.report(f.context, f.origin, { work_id: f.origin.workId, state: 'active', summary: 'Continue' }, 'missing-read'), /latest owner messages/);
  const direction = f.assignments.direction(f.origin.workId);
  f.assignments.report(f.context, f.origin, { work_id: f.origin.workId, state: 'active', summary: 'Owner asks for an update while the repair continues', owner_message_sequence: direction.ownerMessageSequence }, 'current-read');
  const id = f.admit('current');
  assert.doesNotThrow(() => f.consumer.assertCurrentDirection(id));
});

test('canonical observations reach the existing agency and preserve private tasks without a second execution owner', async t => {
  const f = fixture(t), id = f.admit('first');
  f.cancel(id);
  const directory = mkdtempSync(join(tmpdir(), 'canonical-agency-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // @ts-expect-error existing engine module is JavaScript
  const { AgencyKernel } = await import('../../../engine/src/agency/resident-kernel.js');
  // @ts-expect-error existing engine module is JavaScript
  const { reconcileCanonicalWork } = await import('../../../engine/src/agency/canonical-work.js');
  const kernel = new AgencyKernel({ brainDir: join(directory, 'brain'), agentName: 'jerry', config: { enabled: true, mode: 'dry_run' } });
  kernel.recordTask({ id: 'private-promise', summary: 'Existing resident concern' });
  const source = join(directory, 'jerry.work.json');
  projectResidentWork(f.database, directory, ['jerry']);
  assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 1);
  assert.equal(kernel.store.getTask(`coordination:${id}`).status, 'closed');
  const before = statSync(source).mtimeMs;
  projectResidentWork(f.database, directory, ['jerry']);
  assert.equal(statSync(source).mtimeMs, before, 'a timer tick is not progress');
  assert.equal(reconcileCanonicalWork(kernel, source, 'jerry').changed, 0);
  f.assignments.report(f.context, f.origin, { work_id: id, state: 'cancelled', summary: 'Owner stopped the assignment' }, 'closed-report');
  projectResidentWork(f.database, directory, ['jerry']);
  reconcileCanonicalWork(kernel, source, 'jerry');
  assert.equal(kernel.store.getTask(`coordination:${id}`).status, 'closed');
  assert.equal(kernel.store.getTask('private-promise').status, 'open');
  assert.throws(() => reconcileCanonicalWork(kernel, source, 'forrest'), /Invalid canonical resident/);
  assert.equal(JSON.parse(readFileSync(source, 'utf8')).assignments[0].id, id);
});
