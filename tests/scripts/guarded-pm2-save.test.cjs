const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const APPROVED = [
  'home23-cosmo23',
  'home23-jerry',
  'home23-forrest',
  'home23-jerry-dash',
  'home23-forrest-dash',
  'home23-jerry-harness',
  'home23-forrest-harness',
  'home23-jerry-mcp',
  'home23-forrest-mcp',
];

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
  const rows = [...APPROVED.map((name) => dumpRow(name)), dumpRow('unrelated-service')];
  const bytes = Buffer.from(`${JSON.stringify(rows, null, 2)}\n`);
  await fs.writeFile(dumpPath, bytes, { mode: 0o640 });
  return { root, dumpPath, backupPath, bytes };
}

function completeLive(overrides = {}) {
  return [
    ...APPROVED.map((name) => liveRow(name, overrides[name] || {})),
    liveRow('unrelated-service', overrides['unrelated-service'] || {}),
  ];
}

test('normalizes flattened dump.pm2 rows identically to live jlist rows', async () => {
  const { normalizePm2Row } = await import('../../scripts/guarded-pm2-save.mjs');
  assert.deepEqual(
    normalizePm2Row(dumpRow('home23-jerry-dash')),
    normalizePm2Row(liveRow('home23-jerry-dash')),
  );
});

test('realistic dump rows without runtime PIDs compare safely while live PID is frozen separately', async () => {
  const { comparePreSaveTables, normalizePm2Table } = await import('../../scripts/guarded-pm2-save.mjs');
  const persisted = dumpRow('unrelated-service');
  delete persisted.pid;
  const live = normalizePm2Table([liveRow('unrelated-service')]);
  const dump = normalizePm2Table([persisted]);
  assert.equal(dump.get('unrelated-service').pid, null);
  assert.doesNotThrow(() => comparePreSaveTables(live, dump, new Set()));
  const reorderedArgs = normalizePm2Table([dumpRow('unrelated-service', {
    pid: undefined, args: ['second', 'first'],
  })]);
  assert.throws(
    () => comparePreSaveTables(live, reorderedArgs, new Set()),
    (error) => error.code === 'pm2_unrelated_drift',
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
    allowChanged: APPROVED,
    listProcesses: async () => completeLive(),
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
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      calls += 1;
      return completeLive();
    },
    save: async () => {
      await fs.writeFile(state.dumpPath, `${JSON.stringify([
        ...APPROVED.map((name) => dumpRow(name)),
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
    ['duplicate', [...completeLive(), liveRow('home23-jerry-dash')], 'pm2_duplicate_process'],
    ['offline', completeLive({ 'home23-jerry-dash': { status: 'stopped' } }), 'pm2_process_not_online'],
    ['drift', completeLive({ 'unrelated-service': { pm_cwd: '/moved' } }), 'pm2_unrelated_drift'],
  ]) {
    const state = await fixture();
    t.after(() => fs.rm(state.root, { recursive: true, force: true }));
    let saves = 0;
    await assert.rejects(guardedPm2Save({
      dumpPath: state.dumpPath,
      backupPath: path.join(state.root, 'receipts', `${name}.pm2`),
      allowChanged: APPROVED,
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
    env: { HOME23_MODE: 'test', HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY: 'redacted' },
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

  const removedEnvironment = normalizePm2Table([liveRow('home23-jerry-dash', {
    env: {},
  })]);
  assert.throws(
    () => comparePreSaveTables(
      removedEnvironment,
      dump,
      new Set(['home23-jerry-dash']),
    ),
    (error) => error.code === 'pm2_allowlisted_delta_invalid',
  );
});

test('save requires the exact approved nine-name allowlist', async (t) => {
  const { guardedPm2Save, APPROVED_BRAIN_PROCESS_NAMES } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  assert.deepEqual(APPROVED_BRAIN_PROCESS_NAMES, APPROVED);
  for (const allowChanged of [
    APPROVED.slice(0, -1),
    [...APPROVED, 'unrelated-service'],
    [...APPROVED.slice(0, -1), 'made-up-home23-process'],
  ]) {
    await assert.rejects(guardedPm2Save({
      dumpPath: state.dumpPath,
      backupPath: path.join(state.root, 'receipts', `invalid-${allowChanged.length}-${Math.random()}.pm2`),
      allowChanged,
      listProcesses: async () => completeLive(),
    }), (error) => error.code === 'pm2_allowlist_invalid');
  }
});

test('failed postcondition verifies byte-and-mode restoration and fails closed on bad restore', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await assert.rejects(guardedPm2Save({
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => completeLive(),
    save: async () => fs.writeFile(state.dumpPath, 'broken dump\n', { mode: 0o600 }),
    restoreDump: async (file) => fs.writeFile(file, 'wrong restored bytes\n', { mode: 0o600 }),
  }), (error) => error.code === 'pm2_dump_restore_failed');
});
