const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function liveRow(name, overrides = {}) {
  return {
    name,
    pid: 100,
    pm2_env: {
      name,
      status: 'online',
      restart_time: 2,
      pm_exec_path: `/apps/${name}.js`,
      pm_cwd: '/apps',
      namespace: 'default',
      exec_mode: 'fork_mode',
      instances: 1,
      args: ['--safe'],
      env: { HOME23_MODE: 'test' },
      ...overrides,
    },
  };
}

function dumpRow(name, overrides = {}) {
  return {
    name,
    status: 'online',
    pid: 100,
    restart_time: 2,
    pm_exec_path: `/apps/${name}.js`,
    pm_cwd: '/apps',
    namespace: 'default',
    exec_mode: 'fork_mode',
    instances: 1,
    args: ['--safe'],
    HOME23_MODE: 'test',
    ...overrides,
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-guarded-pm2-'));
  const dumpPath = path.join(root, 'dump.pm2');
  const backupPath = path.join(root, 'receipts', 'backup.pm2');
  const rows = [dumpRow('home23-jerry-dash'), dumpRow('unrelated-service')];
  const bytes = Buffer.from(`${JSON.stringify(rows, null, 2)}\n`);
  await fs.writeFile(dumpPath, bytes, { mode: 0o640 });
  return { root, dumpPath, backupPath, bytes };
}

test('normalizes flattened dump.pm2 rows identically to live jlist rows', async () => {
  const { normalizePm2Row } = await import('../../scripts/guarded-pm2-save.mjs');
  assert.deepEqual(
    normalizePm2Row(dumpRow('home23-jerry-dash')),
    normalizePm2Row(liveRow('home23-jerry-dash')),
  );
});

test('dry run writes a mode-0600 byte backup and never invokes pm2 save', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  let saves = 0;
  const result = await guardedPm2Save({
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: [],
    listProcesses: async () => [liveRow('home23-jerry-dash'), liveRow('unrelated-service')],
    save: async () => { saves += 1; },
  });
  assert.equal(result.applied, false);
  assert.equal(saves, 0);
  assert.deepEqual(await fs.readFile(state.backupPath), state.bytes);
  assert.equal((await fs.stat(state.backupPath)).mode & 0o777, 0o600);
});

test('apply restores the original dump after a failed full-table postcondition', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(guardedPm2Save({
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: [],
    apply: true,
    listProcesses: async () => {
      calls += 1;
      return [liveRow('home23-jerry-dash'), liveRow('unrelated-service')];
    },
    save: async () => {
      await fs.writeFile(state.dumpPath, `${JSON.stringify([
        dumpRow('home23-jerry-dash'),
        dumpRow('unrelated-service', { pid: 999 }),
      ])}\n`);
    },
  }), (error) => error.code === 'pm2_dump_postcondition_failed'
    && error.pm2Save?.restored === true);
  assert.equal(calls, 2);
  assert.deepEqual(await fs.readFile(state.dumpPath), state.bytes);
  assert.equal((await fs.stat(state.dumpPath)).mode & 0o777, 0o640);
});

test('duplicate, offline, or unrelated drift blocks save before mutation', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  for (const [name, live, code] of [
    ['duplicate', [liveRow('home23-jerry-dash'), liveRow('home23-jerry-dash')], 'pm2_duplicate_process'],
    ['offline', [liveRow('home23-jerry-dash', { status: 'stopped' }), liveRow('unrelated-service')], 'pm2_process_not_online'],
    ['drift', [liveRow('home23-jerry-dash'), liveRow('unrelated-service', { pm_cwd: '/moved' })], 'pm2_unrelated_drift'],
  ]) {
    const state = await fixture();
    t.after(() => fs.rm(state.root, { recursive: true, force: true }));
    let saves = 0;
    await assert.rejects(guardedPm2Save({
      dumpPath: state.dumpPath,
      backupPath: path.join(state.root, 'receipts', `${name}.pm2`),
      allowChanged: ['home23-jerry-dash'],
      apply: true,
      listProcesses: async () => live,
      save: async () => { saves += 1; },
    }), (error) => error.code === code);
    assert.equal(saves, 0);
  }
});

test('allowlisted rows permit only PID, restart, and environment-key drift', async () => {
  const {
    comparePreSaveTables,
    normalizePm2Table,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const live = normalizePm2Table([liveRow('home23-jerry-dash', {
    restart_time: 3,
    env: { HOME23_MODE: 'test', NEW_CAPABILITY: 'redacted' },
  })]);
  live.get('home23-jerry-dash').pid = 101;
  const dump = normalizePm2Table([dumpRow('home23-jerry-dash')]);
  assert.doesNotThrow(() => comparePreSaveTables(
    live,
    dump,
    new Set(['home23-jerry-dash']),
  ));

  const wrongScript = normalizePm2Table([dumpRow('home23-jerry-dash', {
    pm_exec_path: '/other/entrypoint.js',
  })]);
  assert.throws(
    () => comparePreSaveTables(live, wrongScript, new Set(['home23-jerry-dash'])),
    (error) => error.code === 'pm2_allowlisted_identity_drift',
  );
});
