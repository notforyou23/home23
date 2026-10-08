import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSupervisorForUpdate, adoptSupervisorForUpdate, verifySupervisorBeforeApplication } from '../../cli/lib/product-supervisor-admission.js';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'home23-supervisor-admission-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const home = join(parent, 'home'), candidate = join(parent, 'candidate');
  for (const root of [home, candidate]) {
    mkdirSync(join(root, 'app/cli/lib'), { recursive: true });
    writeFileSync(join(root, 'app/cli/lib/product-supervisor.js'), '');
  }
  const rows = [{ name: 'home23-jerry', pm2_env: { status: 'online', pm_exec_path: '/home/bin/node', args: ['engine'] } },
    { name: 'paused-role', pm2_env: { status: 'stopped', pm_exec_path: '/home/bin/node', args: ['helper'], kill_timeout: 30000 } }];
  return { home, candidate, rows };
}
const status = { ownership: 'legacy', pid: 42, generation: '42:birth' };

test('admission captures full registrations and paused status without creating a daemon', async t => {
  const f = fixture(t), calls = [];
  const supervisor = { inspectProductSupervisor: async () => status,
    productSupervisorCommand: async (_home, args) => { calls.push(args); return { stdout: JSON.stringify(f.rows) }; },
    ensureProductSupervisor: async () => { throw new Error('must not start'); } };
  const result = await captureSupervisorForUpdate(f.home, f.candidate, { platform: 'darwin', supervisor });
  assert.deepEqual(result.registrations, f.rows);
  assert.deepEqual(calls, [['jlist', '--silent']]);
  assert.equal(result.expectedPid, 42);
});

test('a changed supervisor generation invalidates the admission snapshot', async t => {
  const f = fixture(t); let probes = 0;
  await assert.rejects(captureSupervisorForUpdate(f.home, f.candidate, { platform: 'darwin', supervisor: {
    inspectProductSupervisor: async () => (++probes === 1 ? status : { ...status, generation: '42:another-birth' }),
    productSupervisorCommand: async () => ({ stdout: JSON.stringify(f.rows) }),
  } }), { code: 'host_supervisor_ambiguous' });
});

test('migration passes the admitted owner token and preserves its captured registration definitions', async t => {
  const f = fixture(t), admission = { ...status, expectedPid: 42, registrations: f.rows };
  const result = await adoptSupervisorForUpdate(f.home, { id: 'update-1', ownerToken: 'owned-token', supervisorAdmission: admission }, { platform: 'darwin', supervisor: {
    inspectProductSupervisor: async () => status,
    adoptProductSupervisor: async (_home, input) => {
      assert.equal(input.updateOwnerToken, 'owned-token'); assert.equal(input.expectedPid, 42);
      assert.equal(input.updateId, 'update-1'); assert.equal(input.generation, status.generation);
      assert.deepEqual(input.registrations, f.rows); return { ownership: 'launchd', pausedNames: ['paused-role'] };
    },
  } });
  assert.deepEqual(result.pausedNames, ['paused-role']);
});

test('a retained legacy migration can resume after the old daemon exited', async t => {
  const f = fixture(t); let adopted = false;
  await adoptSupervisorForUpdate(f.home, { ownerToken: 'owned', supervisorAdmission: { ownership: 'legacy', expectedPid: 42, generation: status.generation, registrations: f.rows } }, {
    platform: 'darwin', supervisor: { inspectProductSupervisor: async () => ({ ownership: 'absent' }),
      adoptProductSupervisor: async () => { adopted = true; return { ownership: 'launchd' }; } },
  });
  assert.equal(adopted, true);
});

test('an independent supervisor uses the same admission validator and refuses a changed generation', async t => {
  const f = fixture(t), journal = { id: 'update-2', ownerToken: 'owner-2', supervisorAdmission: {
    ownership: 'launchd', expectedPid: 43, generation: '43:birth', registrations: f.rows } };
  let generation = '43:birth', calls = 0;
  const supervisor = { inspectProductSupervisor: async () => ({ ownership: 'launchd', pid: 43, generation }),
    adoptProductSupervisor: async (_home, input) => {
      calls++; assert.equal(input.updateId, 'update-2'); assert.equal(input.updateOwnerToken, 'owner-2');
      assert.deepEqual(input.registrations, f.rows);
      return { ownership: 'launchd', pausedNames: ['paused-role'] };
    } };
  assert.deepEqual((await adoptSupervisorForUpdate(f.home, journal, { platform: 'darwin', supervisor })).pausedNames, ['paused-role']);
  generation = '43:another-birth';
  await assert.rejects(adoptSupervisorForUpdate(f.home, journal, { platform: 'darwin', supervisor }), { code: 'host_supervisor_ambiguous' });
  assert.equal(calls, 1);
});

test('Mac replacement refuses legacy ownership and permits the independently owned daemon', async t => {
  const f = fixture(t); let current = status;
  const dependencies = { platform: 'darwin', supervisor: { inspectProductSupervisor: async () => current } };
  await assert.rejects(verifySupervisorBeforeApplication(f.home, dependencies), { code: 'host_supervisor_adoption_required' });
  current = { ownership: 'launchd', pid: 43 };
  assert.deepEqual(await verifySupervisorBeforeApplication(f.home, dependencies), current);
});

test('a stopped empty home and Linux do not require a daemon during the app boundary check', async t => {
  const f = fixture(t); writeFileSync(join(f.home, '.home23-host.json'), JSON.stringify({ desiredRunning: false }), { mode: 0o600 });
  assert.equal((await verifySupervisorBeforeApplication(f.home, { platform: 'darwin', supervisor: { inspectProductSupervisor: async () => ({ ownership: 'absent' }) } })).running, false);
  assert.equal(await captureSupervisorForUpdate(f.home, f.candidate, { platform: 'linux' }), null);
  assert.deepEqual(await adoptSupervisorForUpdate(f.home, { desiredRunning: false, supervisorAdmission: { ownership: 'absent' } }, {
    platform: 'darwin', supervisor: { inspectProductSupervisor: async () => ({ ownership: 'absent' }),
      ensureProductSupervisor: async () => { throw new Error('must remain stopped'); } },
  }), { ownership: 'absent', running: false, updateId: undefined, pausedNames: [] });
});

test('cold running admission establishes ownership without inventing a previous registration generation', async t => {
  const f = fixture(t), journal = { id: 'cold-update', desiredRunning: true, supervisorAdmission: { ownership: 'absent', registrations: [] } };
  const result = await adoptSupervisorForUpdate(f.home, journal, { platform: 'darwin', supervisor: {
    inspectProductSupervisor: async () => ({ ownership: 'absent' }),
    ensureProductSupervisor: async () => ({ ownership: 'launchd', pid: 43, generation: '43:birth' }),
  } });
  assert.deepEqual(result, { ownership: 'launchd', pid: 43, generation: '43:birth', updateId: 'cold-update', pausedNames: [] });
  assert.equal(journal.supervisorAdmission.expectedPid, undefined);
});
