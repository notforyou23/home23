const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile: execFileCallback } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFile = promisify(execFileCallback);

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
      pm_uptime: 1_700_000_000_000,
      pm_exec_path: `/apps/${name}.js`,
      pm_cwd: '/apps',
      namespace: 'default',
      exec_mode: 'fork_mode',
      instances: 1,
      args: ['--safe'],
      exec_interpreter: 'node',
      node_args: [],
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
    pm_uptime: 1_700_000_000_000,
    pm_exec_path: `/apps/${name}.js`,
    pm_cwd: '/apps',
    namespace: 'default',
    exec_mode: 'fork_mode',
    instances: 1,
    args: ['--safe'],
    exec_interpreter: 'node',
    node_args: [],
    HOME23_MODE: 'test',
    ...overrides,
  };
}

function moduleLiveRow(name = 'pm2-logrotate', overrides = {}) {
  return liveRow(name, {
    pmx_module: true,
    pm_exec_path: `/modules/${name}/app.js`,
    pm_cwd: `/modules/${name}`,
    ...overrides,
  });
}

function ecosystemApp(name, overrides = {}) {
  return {
    name,
    script: `${name}.js`,
    cwd: '/apps',
    namespace: 'default',
    exec_mode: 'fork_mode',
    instances: 1,
    args: ['--safe'],
    ...overrides,
  };
}

function completeEcosystem(overrides = {}) {
  return APPROVED.map((name) => ecosystemApp(name, overrides[name] || {}));
}

function configuredAuthority() {
  return {
    expectedConfigured: APPROVED,
    ecosystemApps: completeEcosystem(),
    reloadEcosystemApps: async () => completeEcosystem(),
  };
}

async function writeRunAuthority(run, receiptRunId) {
  await fs.writeFile(path.join(run, 'run-authority.json'), `${JSON.stringify({
    schemaVersion: 1,
    receiptRunId,
    authority: 'live',
    implementationCommit: 'a'.repeat(40),
    expectedLiveTree: 'b'.repeat(40),
    actualLiveTree: 'b'.repeat(40),
    hostname: 'fixture-host',
    startedAt: '2026-07-11T00:00:00.000Z',
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'home23-guarded-pm2-')),
  );
  const run = path.join(root, 'run');
  const receiptRunId = `guarded-pm2-${path.basename(root)}`;
  await fs.mkdir(run, { mode: 0o700 });
  await writeRunAuthority(run, receiptRunId);
  const dumpPath = path.join(root, 'dump.pm2');
  const backupPath = path.join(run, 'backups', 'backup.pm2');
  const rows = [...APPROVED.map((name) => dumpRow(name)), dumpRow('unrelated-service')];
  const bytes = Buffer.from(`${JSON.stringify(rows, null, 2)}\n`);
  await fs.writeFile(dumpPath, bytes, { mode: 0o640 });
  return { root, run, receiptRunId, dumpPath, backupPath, bytes };
}

function stabilityProjection(rows) {
  return rows.map((row) => {
    const environment = row.pm2_env || row;
    return {
      name: row.name || environment.name,
      pid: row.pid ?? environment.pid ?? environment.pm_pid ?? null,
      status: environment.status,
      restarts: environment.restart_time,
      uptime: environment.pm_uptime ?? null,
      script: environment.pm_exec_path || null,
      cwd: environment.pm_cwd || null,
      namespace: environment.namespace || 'default',
      execMode: environment.exec_mode || null,
      instances: environment.instances ?? null,
      args: environment.args ?? null,
      interpreter: environment.exec_interpreter || null,
      nodeArgs: environment.node_args ?? null,
      envKeys: Object.keys(environment.env && typeof environment.env === 'object'
        ? environment.env : {}).sort(),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

async function cliFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-guarded-pm2-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const bin = path.join(root, 'bin');
  await fs.mkdir(run, { mode: 0o700 });
  await fs.mkdir(bin);
  const receiptRunId = 'guarded-pm2-cli-run';
  await writeRunAuthority(run, receiptRunId);

  const liveRows = completeLive();
  const dumpRows = [...APPROVED.map((name) => dumpRow(name)), dumpRow('unrelated-service')];
  const dumpPath = path.join(root, 'dump.pm2');
  const jlistPath = path.join(root, 'jlist.json');
  const restartBaselinePath = path.join(run, 'after-stability.json');
  const ecosystemPath = path.join(root, 'ecosystem.config.cjs');
  const saveLog = path.join(root, 'pm2-save.log');
  const commandLog = path.join(root, 'pm2-command.log');
  await fs.writeFile(dumpPath, `${JSON.stringify(dumpRows, null, 2)}\n`, { mode: 0o640 });
  await fs.writeFile(jlistPath, `${JSON.stringify(liveRows)}\n`);
  await fs.writeFile(restartBaselinePath, `${JSON.stringify(stabilityProjection(liveRows), null, 2)}\n`);
  await fs.writeFile(ecosystemPath,
    `module.exports = ${JSON.stringify({ apps: completeEcosystem() }, null, 2)};\n`);
  const fakePm2 = path.join(bin, 'pm2');
  await fs.writeFile(fakePm2, `#!${process.execPath}\n`
    + "const fs=require('node:fs');\n"
    + "const command=process.argv[2];\n"
    + "fs.appendFileSync(process.env.FAKE_PM2_COMMAND_LOG,command+'\\n');\n"
    + "if(command==='jlist')process.stdout.write(fs.readFileSync(process.env.FAKE_PM2_JLIST));\n"
    + "else if(command==='save')fs.appendFileSync(process.env.FAKE_PM2_SAVE_LOG,'save\\n');\n"
    + "else process.exitCode=64;\n");
  await fs.chmod(fakePm2, 0o755);
  const env = { ...process.env,
    PATH: `${bin}:${process.env.PATH || ''}`,
    FAKE_PM2_JLIST: jlistPath,
    FAKE_PM2_SAVE_LOG: saveLog,
    FAKE_PM2_COMMAND_LOG: commandLog,
  };
  for (const key of [
    'HOME23_RECEIPT_RUN_DIR', 'HOME23_RECEIPT_RUN_ID', 'HOME23_RECEIPT_AUTHORITY',
    'HOME23_RECEIPT_IMPLEMENTATION_COMMIT', 'IMPLEMENTATION_PUSH_COMMIT',
  ]) delete env[key];
  return {
    root, run, receiptRunId, dumpPath, restartBaselinePath, ecosystemPath,
    saveLog, commandLog, env,
  };
}

function guardedCliArgs(state, mode, output) {
  return [
    path.resolve(__dirname, '../../scripts/guarded-pm2-save.mjs'),
    '--dump', state.dumpPath,
    '--allow-changed', APPROVED.join(','),
    '--ecosystem', state.ecosystemPath,
    '--expected-configured', APPROVED.join(','),
    '--restart-baseline', state.restartBaselinePath,
    '--mode', mode,
    '--receipt-run-dir', state.run,
    '--receipt-run-id', state.receiptRunId,
    '--authority', 'live',
    '--output', output,
  ];
}

async function runGuardedCli(state, mode, output, extra = []) {
  return execFile(process.execPath, [...guardedCliArgs(state, mode, output), ...extra], {
    cwd: path.resolve(__dirname, '../..'),
    env: state.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function runGuardedRaw(state, args) {
  return execFile(process.execPath, args, {
    cwd: path.resolve(__dirname, '../..'),
    env: state.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function assertNoPm2OrBackupEffects(state) {
  await assert.rejects(fs.access(state.commandLog), (error) => error.code === 'ENOENT');
  await assert.rejects(fs.access(state.saveLog), (error) => error.code === 'ENOENT');
  await assert.rejects(
    fs.access(path.join(state.run, 'backups')),
    (error) => error.code === 'ENOENT',
  );
}

async function waitForPath(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function receiptContextFor(state) {
  const { receiptContext } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  return receiptContext({
    'receipt-run-dir': state.run,
    'receipt-run-id': state.receiptRunId,
    authority: 'live',
  }, {});
}

let transactionSequence = 0;
async function invokeGuarded(guardedPm2Save, state, options) {
  if (!options.apply || options.transaction) return guardedPm2Save(options);
  const { prepareGuardedPm2ReceiptTransaction } = await import(
    '../../scripts/guarded-pm2-save.mjs'
  );
  const context = await receiptContextFor(state);
  transactionSequence += 1;
  const outputPath = path.join(
    state.run,
    'test-transactions',
    `transaction-${transactionSequence}.json`,
  );
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath,
    mode: 'apply',
    dumpPath: options.dumpPath,
  });
  return guardedPm2Save({ ...options, context, transaction });
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

test('normalized process identity includes uptime interpreter and node arguments', async () => {
  const { normalizePm2Row } = await import('../../scripts/guarded-pm2-save.mjs');
  const normalized = normalizePm2Row(liveRow('home23-jerry-dash', {
    pm_uptime: 1_700_000_000_123,
    exec_interpreter: '/custom/node',
    node_args: ['--max-old-space-size=2048'],
  }));
  assert.equal(normalized.uptime, 1_700_000_000_123);
  assert.equal(normalized.interpreter, '/custom/node');
  assert.deepEqual(normalized.nodeArgs, ['--max-old-space-size=2048']);
});

test('PM2 runtime metadata nested in process env is not treated as application env', async () => {
  const { normalizePm2Row } = await import('../../scripts/guarded-pm2-save.mjs');
  const normalized = normalizePm2Row(liveRow('home23-jerry-dash', {
    env: {
      HOME23_MODE: 'test',
      unique_id: 'pm2-generated-id',
      cwd: '/apps',
      max_memory_restart: 1024,
      PM2_DISCRETE_MODE: 'true',
    },
  }));

  assert.deepEqual(normalized.envKeys, ['HOME23_MODE']);
});

test('realistic dump rows without runtime PIDs compare safely while live PID is frozen separately', async () => {
  const { comparePreSaveTables, normalizePm2Table } = await import('../../scripts/guarded-pm2-save.mjs');
  const persisted = dumpRow('unrelated-service');
  delete persisted.pid;
  const live = normalizePm2Table([liveRow('unrelated-service', {
    pm_uptime: persisted.pm_uptime + 60_000,
  })]);
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
  const result = await invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    listProcesses: async () => completeLive(),
    save: async () => { saves += 1; },
  });
  assert.equal(result.applied, false);
  assert.equal(saves, 0);
  assert.deepEqual(result.originalIdentity, {
    dev: result.originalIdentity.dev,
    ino: result.originalIdentity.ino,
    nlink: '1',
    mode: 0o640,
    size: String(state.bytes.length),
    mtimeNs: result.originalIdentity.mtimeNs,
    ctimeNs: result.originalIdentity.ctimeNs,
  });
  assert.match(result.originalIdentity.dev, /^\d+$/);
  assert.match(result.originalIdentity.ino, /^\d+$/);
  assert.match(result.originalIdentity.mtimeNs, /^\d+$/);
  assert.match(result.originalIdentity.ctimeNs, /^\d+$/);
  assert.deepEqual(await fs.readFile(state.backupPath), state.bytes);
  assert.equal((await fs.stat(state.backupPath)).mode & 0o777, 0o600);
});

test('live PM2 modules are excluded from dump equality and frozen across save', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const module = moduleLiveRow();
  let calls = 0;

  const result = await invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      calls += 1;
      return [...completeLive(), structuredClone(module)];
    },
    save: async () => {
      await fs.writeFile(state.dumpPath, state.bytes);
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.applied, true);
  assert.deepEqual(result.liveModules, [{
    name: 'pm2-logrotate',
    status: 'online',
    pid: 100,
    restartCount: 2,
    uptime: 1_700_000_000_000,
    script: '/modules/pm2-logrotate/app.js',
    cwd: '/modules/pm2-logrotate',
    namespace: 'default',
    execMode: 'fork_mode',
    instances: 1,
    args: ['--safe'],
    interpreter: 'node',
    nodeArgs: [],
    envKeys: ['HOME23_MODE'],
  }]);
});

test('a PM2 module semantic change during save restores the dump and fails closed', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  let calls = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      calls += 1;
      return [
        ...completeLive(),
        moduleLiveRow('pm2-logrotate', { restart_time: calls < 3 ? 2 : 3 }),
      ];
    },
    save: async () => fs.writeFile(state.dumpPath, state.bytes),
  }), (error) => error.code === 'pm2_live_module_changed'
    && error.message.includes('pm2-logrotate')
    && error.pm2Save?.restored === true);

  assert.equal(calls, 3);
  assert.deepEqual(await fs.readFile(state.dumpPath), state.bytes);
});

test('dump.pm2 containing a PM2 module is rejected before save', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const rows = JSON.parse(state.bytes.toString('utf8'));
  rows.push(dumpRow('pm2-logrotate', { pmx_module: true }));
  await fs.writeFile(state.dumpPath, `${JSON.stringify(rows, null, 2)}\n`);
  let saves = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => [...completeLive(), moduleLiveRow()],
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_dump_contains_module'
    && error.message.includes('pm2-logrotate'));
  assert.equal(saves, 0);
});

test('stable unrelated restart-count advance establishes a new dump baseline', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const live = completeLive({ 'unrelated-service': { restart_time: 4 } });

  const result = await invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => structuredClone(live),
    save: async () => {
      const rows = [
        ...APPROVED.map((name) => dumpRow(name)),
        dumpRow('unrelated-service', { restart_time: 4 }),
      ];
      await fs.writeFile(state.dumpPath, `${JSON.stringify(rows, null, 2)}\n`);
    },
  });

  assert.equal(result.applied, true);
  assert.deepEqual(result.unrelatedRestartBaselines, [{
    name: 'unrelated-service',
    dumpRestartCount: 2,
    liveRestartCount: 4,
  }]);
  assert.equal(
    result.dumpTableAfter.find((row) => row.name === 'unrelated-service').restartCount,
    4,
  );
});

test('unrelated restart baseline rejects regression or accompanying identity drift', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  for (const [label, overrides] of [
    ['regression', { restart_time: 1 }],
    ['identity-drift', { restart_time: 4, pm_cwd: '/moved' }],
  ]) {
    const state = await fixture();
    t.after(() => fs.rm(state.root, { recursive: true, force: true }));
    let saves = 0;
    await assert.rejects(invokeGuarded(guardedPm2Save, state, {
      ...configuredAuthority(),
      dumpPath: state.dumpPath,
      backupPath: path.join(state.run, 'backups', `${label}.pm2`),
      allowChanged: APPROVED,
      apply: true,
      listProcesses: async () => completeLive({ 'unrelated-service': overrides }),
      save: async () => { saves += 1; },
    }), (error) => error.code === 'pm2_unrelated_drift'
      && error.message.includes('unrelated-service'));
    assert.equal(saves, 0);
  }
});

test('unrelated restart movement during save restores the original dump', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  let calls = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      calls += 1;
      return completeLive({ 'unrelated-service': { restart_time: calls < 3 ? 4 : 5 } });
    },
    save: async () => {
      const rows = [
        ...APPROVED.map((name) => dumpRow(name)),
        dumpRow('unrelated-service', { restart_time: 4 }),
      ];
      await fs.writeFile(state.dumpPath, `${JSON.stringify(rows, null, 2)}\n`);
    },
  }), (error) => error.code === 'pm2_live_table_changed'
    && error.message.includes('unrelated-service')
    && error.pm2Save?.restored === true);

  assert.equal(calls, 3);
  assert.deepEqual(await fs.readFile(state.dumpPath), state.bytes);
});

test('concurrent dump replacement before save is rejected even with identical bytes', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  let saves = 0;
  let lists = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      lists += 1;
      if (lists === 1) {
        const replacement = path.join(state.root, 'replacement.pm2');
        await fs.writeFile(replacement, state.bytes, { mode: 0o640 });
        await fs.rename(replacement, state.dumpPath);
      }
      return completeLive();
    },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_dump_changed_before_save');

  assert.equal(lists, 2);
  assert.equal(saves, 0);
  assert.deepEqual(await fs.readFile(state.dumpPath), state.bytes);
});

test('concurrent dump chmod before save is rejected without overwriting it', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  let saves = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      await fs.chmod(state.dumpPath, 0o600);
      return completeLive();
    },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_dump_changed_before_save');

  assert.equal(saves, 0);
  assert.equal((await fs.stat(state.dumpPath)).mode & 0o777, 0o600);
});

test('concurrent dump hardlink before save is rejected without invoking save', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  let saves = 0;
  let linked = false;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      if (!linked) {
        linked = true;
        await fs.link(state.dumpPath, path.join(state.root, 'dump-hardlink.pm2'));
      }
      return completeLive();
    },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_dump_changed_before_save');

  assert.equal(saves, 0);
  assert.equal((await fs.stat(state.dumpPath)).nlink, 2);
});

test('concurrent same-inode dump byte change before save is rejected', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const compact = Buffer.from(JSON.stringify(JSON.parse(state.bytes.toString('utf8'))));
  let saves = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      await fs.writeFile(state.dumpPath, compact);
      return completeLive();
    },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_dump_changed_before_save');

  assert.equal(saves, 0);
  assert.deepEqual(await fs.readFile(state.dumpPath), compact);
});

test('oversized dump is rejected before backup, process listing, or save', async (t) => {
  const {
    guardedPm2Save,
    PM2_DUMP_MAX_BYTES,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const handle = await fs.open(state.dumpPath, 'w', 0o640);
  try {
    await handle.write(state.bytes);
    const spaces = Buffer.alloc(1024 * 1024, 0x20);
    let offset = state.bytes.length;
    while (offset <= PM2_DUMP_MAX_BYTES) {
      const length = Math.min(spaces.length, PM2_DUMP_MAX_BYTES + 1 - offset);
      await handle.write(spaces, 0, length, offset);
      offset += length;
    }
  } finally {
    await handle.close();
  }
  let lists = 0;
  let saves = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => { lists += 1; return completeLive(); },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_dump_invalid');

  assert.equal(lists, 0);
  assert.equal(saves, 0);
  await assert.rejects(fs.access(state.backupPath), (error) => error.code === 'ENOENT');
});

test('apply restores the original dump after a failed full-table postcondition', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
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
  assert.equal(calls, 3);
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
    await assert.rejects(invokeGuarded(guardedPm2Save, state, {
      ...configuredAuthority(),
      dumpPath: state.dumpPath,
      backupPath: path.join(state.run, 'backups', `${name}.pm2`),
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

test('configured allowlisted recreation accepts ecosystem env additions and stale env removal', async () => {
  const {
    comparePreSaveTables,
    normalizeEcosystemTable,
    normalizePm2Table,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const name = 'home23-jerry-dash';
  const expectedEnvironment = {
    HOME23_MODE: 'test',
    HOME23_MCP_AVAILABLE: 'true',
  };
  const ecosystem = normalizeEcosystemTable([
    ecosystemApp(name, { env: expectedEnvironment }),
  ]);
  const live = normalizePm2Table([liveRow(name, {
    env: expectedEnvironment,
  })]);
  const dump = normalizePm2Table([dumpRow(name, {
    env: {
      HOME23_MODE: 'test',
      STALE_PRE_RECREATION_ENV: 'remove-me',
    },
  })]);

  assert.doesNotThrow(
    () => comparePreSaveTables(live, dump, new Set([name]), ecosystem),
  );

  const unexpected = normalizePm2Table([liveRow(name, {
    env: {
      ...expectedEnvironment,
      UNDECLARED_ENV_ADDITION: 'refuse-me',
    },
  })]);
  assert.throws(
    () => comparePreSaveTables(unexpected, dump, new Set([name]), ecosystem),
    (error) => error.code === 'pm2_allowlisted_delta_invalid',
  );
});

test('configured allowlisted recreation accepts a restart counter reset', async () => {
  const {
    comparePreSaveTables,
    normalizeEcosystemTable,
    normalizePm2Table,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const name = 'home23-forrest';
  const ecosystem = normalizeEcosystemTable([ecosystemApp(name)]);
  const live = normalizePm2Table([liveRow(name, { restart_time: 1 })]);
  const dump = normalizePm2Table([dumpRow(name, { restart_time: 21 })]);

  assert.doesNotThrow(
    () => comparePreSaveTables(live, dump, new Set([name]), ecosystem),
  );
  assert.throws(
    () => comparePreSaveTables(live, dump, new Set([name])),
    (error) => error.code === 'pm2_allowlisted_delta_invalid',
  );
});

test('configured allowlisted recreation accepts an exact ecosystem script transition', async () => {
  const {
    comparePreSaveTables,
    normalizeEcosystemTable,
    normalizePm2Table,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const name = 'home23-jerry-harness';
  const ecosystem = normalizeEcosystemTable([
    ecosystemApp(name, { script: 'home.js' }),
  ]);
  const live = normalizePm2Table([liveRow(name, {
    pm_exec_path: '/apps/home.js',
    restart_time: 0,
  })]);
  const dump = normalizePm2Table([dumpRow(name, {
    pm_exec_path: '/apps/home-jerry.js',
    restart_time: 151,
  })]);

  assert.doesNotThrow(
    () => comparePreSaveTables(live, dump, new Set([name]), ecosystem),
  );
});

test('existing allowlisted rows reject a wrong agent identity even with the same env keys as the old dump', async () => {
  const {
    comparePreSaveTables,
    normalizeEcosystemTable,
    normalizePm2Table,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const name = 'home23-forrest-dash';
  const expectedEnvironment = {
    HOME23_AGENT: 'forrest',
    INSTANCE_ID: 'home23-forrest',
    DASHBOARD_PORT: '5012',
    COSMO_DASHBOARD_PORT: '5012',
    REALTIME_PORT: '5011',
    MCP_HTTP_PORT: '5015',
    COSMO_RUNTIME_DIR: '/apps/instances/forrest/brain',
    COSMO_WORKSPACE_PATH: '/apps/instances/forrest/workspace',
  };
  const wrongEnvironment = {
    HOME23_MODE: 'test',
    HOME23_AGENT: 'jerry',
    INSTANCE_ID: 'home23-jerry',
    DASHBOARD_PORT: '5002',
    COSMO_DASHBOARD_PORT: '5002',
    REALTIME_PORT: '5001',
    MCP_HTTP_PORT: '5003',
    COSMO_RUNTIME_DIR: '/apps/instances/jerry/brain',
    COSMO_WORKSPACE_PATH: '/apps/instances/jerry/workspace',
  };
  const live = normalizePm2Table([liveRow(name, { env: wrongEnvironment })]);
  const dump = normalizePm2Table([dumpRow(name, { env: wrongEnvironment })]);
  const ecosystem = normalizeEcosystemTable([
    ecosystemApp(name, { env: expectedEnvironment }),
  ]);

  assert.deepEqual(live.get(name).envKeys, dump.get(name).envKeys);
  assert.throws(
    () => comparePreSaveTables(live, dump, new Set([name]), ecosystem),
    (error) => error.code === 'pm2_ecosystem_identity_mismatch'
      && error.message.includes(name),
  );
});

test('critical ecosystem env values are compared without entering public normalized rows', async () => {
  const {
    comparePreSaveTables,
    normalizeEcosystemTable,
    normalizePm2Table,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const name = 'home23-jerry-dash';
  const key = 'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY';
  const expectedSecret = 'expected-capability-secret';
  const wrongSecret = 'wrong-capability-secret';
  const ecosystem = normalizeEcosystemTable([
    ecosystemApp(name, { env: { HOME23_AGENT: 'jerry', [key]: expectedSecret } }),
  ]);
  const live = normalizePm2Table([
    liveRow(name, { env: { HOME23_AGENT: 'jerry', [key]: wrongSecret } }),
  ]);
  const dump = normalizePm2Table([
    dumpRow(name, { env: { HOME23_MODE: 'test', HOME23_AGENT: 'jerry', [key]: wrongSecret } }),
  ]);
  const publicRows = JSON.stringify({
    ecosystem: [...ecosystem.values()],
    live: [...live.values()],
  });

  assert.equal(publicRows.includes(expectedSecret), false);
  assert.equal(publicRows.includes(wrongSecret), false);
  assert.throws(
    () => comparePreSaveTables(live, dump, new Set([name]), ecosystem),
    (error) => error.code === 'pm2_ecosystem_identity_mismatch'
      && !error.message.includes(expectedSecret)
      && !error.message.includes(wrongSecret),
  );
  const matchingLive = normalizePm2Table([
    liveRow(name, {
      env: { HOME23_MODE: 'test', HOME23_AGENT: 'jerry', [key]: expectedSecret },
    }),
  ]);
  const matchingDump = normalizePm2Table([
    dumpRow(name, {
      env: { HOME23_MODE: 'test', HOME23_AGENT: 'jerry', [key]: expectedSecret },
    }),
  ]);
  assert.doesNotThrow(
    () => comparePreSaveTables(matchingLive, matchingDump, new Set([name]), ecosystem),
  );
});

test('critical agent identity cannot change between immediate pre-save validation and post-save freeze', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const name = 'home23-forrest-dash';
  const originalRows = JSON.parse(await fs.readFile(state.dumpPath, 'utf8'));
  const originalRow = originalRows.find((row) => row.name === name);
  originalRow.env = { HOME23_MODE: 'test', HOME23_AGENT: 'forrest' };
  const originalBytes = Buffer.from(`${JSON.stringify(originalRows, null, 2)}\n`);
  await fs.writeFile(state.dumpPath, originalBytes);
  const ecosystemApps = completeEcosystem({
    [name]: { env: { HOME23_AGENT: 'forrest' } },
  });
  const correct = completeLive({
    [name]: { env: { HOME23_MODE: 'test', HOME23_AGENT: 'forrest' } },
  });
  const wrong = completeLive({
    [name]: { env: { HOME23_MODE: 'test', HOME23_AGENT: 'jerry' } },
  });
  let lists = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    ecosystemApps,
    reloadEcosystemApps: async () => ecosystemApps,
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      lists += 1;
      return structuredClone(lists < 3 ? correct : wrong);
    },
    save: async () => fs.writeFile(state.dumpPath, originalBytes),
  }), (error) => error.code === 'pm2_live_table_changed'
    && error.message.includes(name)
    && error.pm2Save?.restorationVerified === true);
  assert.equal(lists, 3);
  assert.deepEqual(await fs.readFile(state.dumpPath), originalBytes);
});

test('post-save dump cannot persist a different critical identity behind the same env keys', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const name = 'home23-forrest-dash';
  const originalRows = JSON.parse(await fs.readFile(state.dumpPath, 'utf8'));
  originalRows.find((row) => row.name === name).env = {
    HOME23_MODE: 'test', HOME23_AGENT: 'forrest',
  };
  const wrongRows = structuredClone(originalRows);
  wrongRows.find((row) => row.name === name).env.HOME23_AGENT = 'jerry';
  const originalBytes = Buffer.from(`${JSON.stringify(originalRows, null, 2)}\n`);
  await fs.writeFile(state.dumpPath, originalBytes);
  const ecosystemApps = completeEcosystem({
    [name]: { env: { HOME23_AGENT: 'forrest' } },
  });
  const live = completeLive({
    [name]: { env: { HOME23_MODE: 'test', HOME23_AGENT: 'forrest' } },
  });

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    ecosystemApps,
    reloadEcosystemApps: async () => ecosystemApps,
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => structuredClone(live),
    save: async () => fs.writeFile(
      state.dumpPath,
      `${JSON.stringify(wrongRows, null, 2)}\n`,
    ),
  }), (error) => error.code === 'pm2_dump_postcondition_failed'
    && error.message.includes(name)
    && error.pm2Save?.restorationVerified === true);
  assert.deepEqual(await fs.readFile(state.dumpPath), originalBytes);
});

test('configured process missing from both live table and old dump blocks before save', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const missing = 'home23-forrest-mcp';
  const dump = JSON.parse((await fs.readFile(state.dumpPath)).toString('utf8'))
    .filter((row) => row.name !== missing);
  await fs.writeFile(state.dumpPath, `${JSON.stringify(dump, null, 2)}\n`);
  let saves = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => completeLive().filter((row) => row.name !== missing),
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_expected_process_missing'
    && error.message.includes(missing));
  assert.equal(saves, 0);
});

test('new allowlisted row must match normalized ecosystem identity before save', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const introduced = 'home23-forrest-mcp';
  const dump = JSON.parse((await fs.readFile(state.dumpPath)).toString('utf8'))
    .filter((row) => row.name !== introduced);
  await fs.writeFile(state.dumpPath, `${JSON.stringify(dump, null, 2)}\n`);
  let saves = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => completeLive({
      [introduced]: { pm_exec_path: '/wrong/new-entrypoint.js' },
    }),
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_ecosystem_identity_mismatch'
    && error.message.includes(introduced));
  assert.equal(saves, 0);
});

test('new allowlisted row with exact normalized ecosystem identity is accepted', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const introduced = 'home23-forrest-mcp';
  const dump = JSON.parse((await fs.readFile(state.dumpPath)).toString('utf8'))
    .filter((row) => row.name !== introduced);
  await fs.writeFile(state.dumpPath, `${JSON.stringify(dump, null, 2)}\n`);

  const result = await guardedPm2Save({
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    listProcesses: async () => completeLive(),
  });

  assert.equal(result.applied, false);
  assert.deepEqual(result.expectedConfigured, [...APPROVED].sort());
  assert.equal(
    result.ecosystemIdentity.find((row) => row.name === introduced)?.script,
    `/apps/${introduced}.js`,
  );
});

test('new allowlisted ecosystem identity covers script cwd namespace mode instances args interpreter and node args', async () => {
  const {
    comparePreSaveTables,
    normalizeEcosystemTable,
    normalizePm2Table,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const name = 'home23-forrest-mcp';
  const expected = normalizeEcosystemTable([ecosystemApp(name, { exec_mode: 'fork' })]);
  const allow = new Set([name]);
  assert.doesNotThrow(() => comparePreSaveTables(
    normalizePm2Table([liveRow(name)]),
    new Map(),
    allow,
    expected,
  ));
  for (const overrides of [
    { pm_exec_path: '/wrong/script.js' },
    { pm_cwd: '/wrong-cwd' },
    { namespace: 'wrong-namespace' },
    { exec_mode: 'cluster_mode' },
    { instances: 2 },
    { args: ['--different'] },
    { exec_interpreter: '/different/node' },
    { node_args: ['--different-node-arg'] },
  ]) {
    assert.throws(
      () => comparePreSaveTables(
        normalizePm2Table([liveRow(name, overrides)]),
        new Map(),
        allow,
        expected,
      ),
      (error) => error.code === 'pm2_ecosystem_identity_mismatch',
    );
  }
});

test('post-save dump missing an expected configured process is restored and rejected', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const missing = 'home23-forrest-mcp';
  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => completeLive(),
    save: async () => {
      const rows = [
        ...APPROVED.filter((name) => name !== missing).map((name) => dumpRow(name)),
        dumpRow('unrelated-service'),
      ];
      await fs.writeFile(state.dumpPath, `${JSON.stringify(rows, null, 2)}\n`);
    },
  }), (error) => error.code === 'pm2_expected_process_missing'
    && error.message.includes(missing)
    && error.pm2Save?.restored === true);
  assert.deepEqual(await fs.readFile(state.dumpPath), state.bytes);
});

test('expected configured names must exactly match approved ecosystem rows', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const optional = 'home23-forrest-mcp';
  for (const [expectedConfigured, ecosystemApps, code] of [
    [APPROVED.filter((name) => name !== optional), completeEcosystem(), 'pm2_expected_configured_mismatch'],
    [APPROVED, completeEcosystem().filter((row) => row.name !== optional), 'pm2_expected_configured_mismatch'],
    [APPROVED.slice(1), completeEcosystem().slice(1), 'pm2_expected_configured_invalid'],
  ]) {
    await assert.rejects(guardedPm2Save({
      dumpPath: state.dumpPath,
      backupPath: path.join(state.root, `backup-${code}-${Math.random()}.pm2`),
      allowChanged: APPROVED,
      expectedConfigured,
      ecosystemApps,
      listProcesses: async () => completeLive(),
    }), (error) => error.code === code);
  }
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
  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => completeLive(),
    save: async () => fs.writeFile(state.dumpPath, 'broken dump\n', { mode: 0o600 }),
    restoreDump: async (file) => fs.writeFile(file, 'wrong restored bytes\n', { mode: 0o600 }),
  }), (error) => error.code === 'pm2_dump_restore_failed'
    && error.pm2Save?.pm2SaveInvoked === true
    && error.pm2Save?.restored === true
    && error.pm2Save?.restorationVerified === false);
});

test('exact CLI mode dry-run never invokes pm2 save and emits truthful verifier fields', async (t) => {
  const state = await cliFixture(t);
  const output = path.join(state.run, 'guarded-dry-run.json');
  await runGuardedCli(state, 'dry-run', output);
  await assert.rejects(fs.access(state.saveLog), (error) => error.code === 'ENOENT');
  const receipt = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(receipt.mode, 'dry-run');
  assert.equal(receipt.pm2SaveInvoked, false);
  assert.equal(receipt.moduleRowsExcluded, true);
  assert.equal(receipt.moduleRowsFrozen, true);
  assert.equal(receipt.unrelatedRestartBaselineMonotonic, true);
  assert.equal(receipt.unrelatedRowsFrozen, true);
  assert.equal(receipt.backupMode, '0600');
  assert.equal(receipt.backupCreatedExclusively, true);
  assert.match(receipt.backupBasename, /^pm2-dump-backup-[A-Za-z0-9._-]+\.pm2$/);
  assert.match(receipt.backupSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.receiptPublicationVerified, true);
  assert.equal(receipt.receiptKind, 'guarded-pm2-save-result');
  assert.equal(receipt.transactionRole, 'result');
  assert.equal(receipt.transactionState, 'committed');
  assert.equal(receipt.outputPath, output);
  assert.match(receipt.transactionId, /^[a-f0-9-]{36}$/);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  const intent = JSON.parse(await fs.readFile(
    path.join(state.run, receipt.transactionIntentBasename),
    'utf8',
  ));
  assert.equal(intent.transactionId, receipt.transactionId);
  assert.equal(intent.receiptKind, 'guarded-pm2-save-intent');
  assert.equal(intent.transactionRole, 'intent');
  assert.equal(intent.transactionState, 'committed');
  assert.equal(intent.outputPath, output);
  assert.equal(intent.outputArtifactSha256, receipt.artifactSha256);
  assert.equal(intent.backupBasename, receipt.backupBasename);
  assert.equal((await fs.stat(
    path.join(state.run, receipt.transactionIntentBasename),
  )).mode & 0o777, 0o600);
});

test('dry-run and apply create distinct exclusive backups of the same pre-save dump', async (t) => {
  const state = await cliFixture(t);
  const dryOutput = path.join(state.run, 'guarded-dry-run.json');
  const applyOutput = path.join(state.run, 'guarded-apply.json');
  await runGuardedCli(state, 'dry-run', dryOutput);
  await runGuardedCli(state, 'apply', applyOutput);
  const dry = JSON.parse(await fs.readFile(dryOutput, 'utf8'));
  const applied = JSON.parse(await fs.readFile(applyOutput, 'utf8'));
  assert.notEqual(dry.backupBasename, applied.backupBasename);
  assert.equal(dry.backupSha256, applied.backupSha256);
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.pm2SaveInvoked, true);
  assert.equal(applied.ecosystemAuthorityReloaded, true);
  assert.equal(applied.immediatePreSaveTableRevalidated, true);
  assert.equal((await fs.readFile(state.saveLog, 'utf8')).trim(), 'save');
  for (const receipt of [dry, applied]) {
    const backup = path.join(state.run, 'backups', receipt.backupBasename);
    assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
    assert.equal(receipt.backupCreatedExclusively, true);
  }
});

test('CLI refuses legacy or conflicting mode flags instead of guessing', async (t) => {
  const state = await cliFixture(t);
  const output = path.join(state.run, 'legacy-mode.json');
  await assert.rejects(
    runGuardedCli(state, 'dry-run', output, ['--apply']),
    (error) => error.code === 1
      && /pm2_legacy_mode_flag_refused|pm2_mode_conflict/.test(error.stderr),
  );
  await assert.rejects(fs.access(output), (error) => error.code === 'ENOENT');
  await assert.rejects(fs.access(state.saveLog), (error) => error.code === 'ENOENT');
});

test('CLI rejects an unrelated restart counter below the delayed stability baseline', async (t) => {
  const state = await cliFixture(t);
  const baseline = JSON.parse(await fs.readFile(state.restartBaselinePath, 'utf8'));
  const unrelated = baseline.find((row) => row.name === 'unrelated-service');
  unrelated.restarts += 1;
  await fs.writeFile(state.restartBaselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  const output = path.join(state.run, 'regressed-baseline.json');
  await assert.rejects(
    runGuardedCli(state, 'dry-run', output),
    (error) => error.code === 1 && /pm2_restart_baseline_regressed/.test(error.stderr),
  );
  const failure = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(failure.transactionState, 'failed-nonmutating');
  assert.equal(failure.pm2SaveInvoked, false);
  assert.equal(failure.restored, false);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  await assert.rejects(fs.access(state.saveLog), (error) => error.code === 'ENOENT');
});

test('missing duplicate or relative output is refused before backup listing or save', async (t) => {
  for (const variant of ['missing', 'duplicate', 'relative']) {
    const state = await cliFixture(t);
    const validOutput = path.join(state.run, `guarded-${variant}.json`);
    const args = guardedCliArgs(state, 'apply', validOutput);
    if (variant === 'missing') {
      const index = args.indexOf('--output');
      args.splice(index, 2);
    } else if (variant === 'duplicate') {
      args.push('--output', path.join(state.run, 'second-output.json'));
    } else {
      args[args.indexOf('--output') + 1] = 'relative-output.json';
    }
    await assert.rejects(
      runGuardedRaw(state, args),
      (error) => error.code === 1 && /missing_argument|duplicate_argument|output_path_invalid/.test(error.stderr),
    );
    await assertNoPm2OrBackupEffects(state);
  }
});

test('outside preexisting or symlink output is refused before backup listing or save', async (t) => {
  for (const variant of ['outside', 'preexisting', 'symlink']) {
    const state = await cliFixture(t);
    const output = variant === 'outside'
      ? path.join(state.root, 'outside-receipt.json')
      : path.join(state.run, `${variant}-receipt.json`);
    if (variant === 'preexisting') {
      await fs.writeFile(output, 'operator-owned\n', { mode: 0o600 });
    } else if (variant === 'symlink') {
      const target = path.join(state.root, 'symlink-target.json');
      await fs.writeFile(target, 'operator-owned\n', { mode: 0o600 });
      await fs.symlink(target, output);
    }
    await assert.rejects(
      runGuardedCli(state, 'apply', output),
      (error) => error.code === 1
        && /output_path_invalid|receipt_output_exists|receipt_output_changed/.test(error.stderr),
    );
    await assertNoPm2OrBackupEffects(state);
  }
});

test('a symlinked output parent is refused before backup listing or save', async (t) => {
  const state = await cliFixture(t);
  const outside = path.join(state.root, 'outside-output-parent');
  const linkedParent = path.join(state.run, 'linked-output-parent');
  await fs.mkdir(outside);
  await fs.symlink(outside, linkedParent);
  const output = path.join(linkedParent, 'guarded.json');
  await assert.rejects(
    runGuardedCli(state, 'apply', output),
    (error) => error.code === 1 && /output_path_invalid/.test(error.stderr),
  );
  await assertNoPm2OrBackupEffects(state);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a pre-existing receipt output parent must be exact mode 0700', async (t) => {
  const state = await cliFixture(t);
  const looseParent = path.join(state.run, 'loose-output-parent');
  await fs.mkdir(looseParent, { mode: 0o755 });
  await fs.chmod(looseParent, 0o755);
  const output = path.join(looseParent, 'guarded.json');

  await assert.rejects(
    runGuardedCli(state, 'apply', output),
    (error) => error.code === 1 && /output_path_invalid/.test(error.stderr),
  );
  await assertNoPm2OrBackupEffects(state);
  assert.deepEqual(await fs.readdir(looseParent), []);
});

test('a reserved output identity race is refused before dump backup listing or save', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const output = path.join(state.run, 'raced-output.json');
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: output,
    mode: 'apply',
    dumpPath: state.dumpPath,
  });
  const renamed = path.join(state.run, 'raced-output-original.json');
  await fs.rename(output, renamed);
  await fs.writeFile(output, 'replacement\n', { mode: 0o600 });
  let lists = 0;
  let saves = 0;

  await assert.rejects(guardedPm2Save({
    ...configuredAuthority(),
    context,
    transaction,
    dumpPath: state.dumpPath,
    backupPath: path.join(state.run, 'backups', 'raced.pm2'),
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => { lists += 1; return completeLive(); },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'receipt_output_changed');
  assert.equal(lists, 0);
  assert.equal(saves, 0);
  await assert.rejects(
    fs.access(path.join(state.run, 'backups')),
    (error) => error.code === 'ENOENT',
  );
});

test('a symlinked backup parent is rejected before writing listing or save', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pm2-backup-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.dirname(state.backupPath));
  let lists = 0;
  let saves = 0;

  await assert.rejects(invokeGuarded(guardedPm2Save, state, {
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => { lists += 1; return completeLive(); },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_backup_parent_invalid');
  assert.equal(lists, 0);
  assert.equal(saves, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('backup parent turnover before exclusive open is rejected without an escaped write', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const parent = path.dirname(state.backupPath);
  const renamed = path.join(state.root, 'backups-renamed');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pm2-backup-race-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(parent);
  let lists = 0;
  let hookCalls = 0;

  await assert.rejects(guardedPm2Save({
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    beforeBackupOpen: async () => {
      hookCalls += 1;
      await fs.rename(parent, renamed);
      await fs.symlink(outside, parent);
    },
    listProcesses: async () => { lists += 1; return completeLive(); },
  }), (error) => error.code === 'pm2_backup_parent_changed');
  assert.equal(hookCalls, 1);
  assert.equal(lists, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('post-save receipt publication failure restores exact dump bytes and mode with durable failure evidence', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const originalBytes = await fs.readFile(state.dumpPath);
  const originalMode = (await fs.stat(state.dumpPath)).mode & 0o777;
  const output = path.join(state.run, 'publication-failure.json');
  let transientPair;
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: output,
    mode: 'apply',
    dumpPath: state.dumpPath,
    beforeFinalReadback: async () => {
      transientPair = {
        output: JSON.parse(await fs.readFile(output, 'utf8')),
        intent: JSON.parse(await fs.readFile(transaction.intentPath, 'utf8')),
      };
      const error = new Error('injected final receipt readback failure');
      error.code = 'receipt_publication_injected_failure';
      throw error;
    },
  });
  let caught;
  try {
    await guardedPm2Save({
      ...configuredAuthority(),
      context,
      transaction,
      dumpPath: state.dumpPath,
      backupPath: path.join(state.run, 'backups', 'publication-failure.pm2'),
      allowChanged: APPROVED,
      apply: true,
      listProcesses: async () => completeLive(),
      save: async () => {
        const compact = Buffer.from(JSON.stringify([
          ...APPROVED.map((name) => dumpRow(name)),
          dumpRow('unrelated-service'),
        ]));
        await fs.writeFile(state.dumpPath, compact, { mode: 0o600 });
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, 'receipt_publication_injected_failure');
  assert.equal(caught?.pm2Save?.restored, true);
  assert.equal(caught?.pm2Save?.restorationVerified, true);
  assert.equal(transientPair.output.receiptKind, 'guarded-pm2-save-result');
  assert.equal(transientPair.output.transactionState, 'reserved');
  assert.equal(transientPair.output.ok, false);
  assert.equal(transientPair.intent.receiptKind, 'guarded-pm2-save-intent');
  assert.equal(transientPair.intent.transactionState, 'committed');
  assert.equal(transientPair.intent.ok, true);
  assert.deepEqual(await fs.readFile(state.dumpPath), originalBytes);
  assert.equal((await fs.stat(state.dumpPath)).mode & 0o777, originalMode);
  const failure = JSON.parse(await fs.readFile(transaction.intentPath, 'utf8'));
  assert.equal(failure.transactionState, 'failed-restored');
  assert.equal(failure.pm2SaveInvoked, true);
  assert.equal(failure.restored, true);
  assert.equal(failure.restorationVerified, true);
  assert.equal((await fs.stat(transaction.intentPath)).mode & 0o777, 0o600);
  const outputFailure = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(failure.outputArtifactSha256, outputFailure.artifactSha256);
  assert.equal(outputFailure.transactionState, 'failed-restored');
  assert.equal(outputFailure.ok, false);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
});

test('final publication revalidates run authority and restores after same-byte inode replacement', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const originalBytes = await fs.readFile(state.dumpPath);
  const originalMode = (await fs.stat(state.dumpPath)).mode & 0o777;
  const authorityPath = path.join(state.run, 'run-authority.json');
  const authorityBytes = await fs.readFile(authorityPath);
  const displacedAuthority = path.join(state.run, 'run-authority.displaced.json');
  const output = path.join(state.run, 'authority-turnover.json');
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: output,
    mode: 'apply',
    dumpPath: state.dumpPath,
    beforeFinalReadback: async () => {
      await fs.rename(authorityPath, displacedAuthority);
      await fs.writeFile(authorityPath, authorityBytes, { mode: 0o600, flag: 'wx' });
    },
  });

  let caught;
  try {
    await guardedPm2Save({
      ...configuredAuthority(),
      context,
      transaction,
      dumpPath: state.dumpPath,
      backupPath: path.join(state.run, 'backups', 'authority-turnover.pm2'),
      allowChanged: APPROVED,
      apply: true,
      listProcesses: async () => completeLive(),
      save: async () => {
        await fs.writeFile(state.dumpPath, Buffer.from(JSON.stringify([
          ...APPROVED.map((name) => dumpRow(name)),
          dumpRow('unrelated-service'),
        ])), { mode: 0o600 });
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught?.code, 'receipt_run_authority_changed');
  assert.equal(caught?.pm2Save?.restored, true);
  assert.equal(caught?.pm2Save?.restorationVerified, true);
  assert.deepEqual(await fs.readFile(state.dumpPath), originalBytes);
  assert.equal((await fs.stat(state.dumpPath)).mode & 0o777, originalMode);
});

test('direct exported apply refuses to invoke save without a branded receipt transaction', async (t) => {
  const { guardedPm2Save } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  let lists = 0;
  let saves = 0;

  await assert.rejects(guardedPm2Save({
    ...configuredAuthority(),
    dumpPath: state.dumpPath,
    backupPath: state.backupPath,
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => { lists += 1; return completeLive(); },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_receipt_transaction_required');

  assert.equal(lists, 0);
  assert.equal(saves, 0);
  await assert.rejects(fs.access(state.backupPath), (error) => error.code === 'ENOENT');
});

test('branded apply requires a live ecosystem reload authority before preflight', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: path.join(state.run, 'missing-ecosystem-reload.json'),
    mode: 'apply',
    dumpPath: state.dumpPath,
  });
  let lists = 0;
  let saves = 0;
  await assert.rejects(guardedPm2Save({
    expectedConfigured: APPROVED,
    ecosystemApps: completeEcosystem(),
    context,
    transaction,
    dumpPath: state.dumpPath,
    backupPath: path.join(state.run, 'backups', 'missing-ecosystem-reload.pm2'),
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => { lists += 1; return completeLive(); },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_ecosystem_reload_required');
  assert.equal(lists, 0);
  assert.equal(saves, 0);
});

test('branded transaction binds exact mode dump and context and is single use', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const output = path.join(state.run, 'bound-transaction.json');
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: output,
    mode: 'dry-run',
    dumpPath: state.dumpPath,
  });
  let lists = 0;
  let saves = 0;

  await assert.rejects(guardedPm2Save({
    ...configuredAuthority(),
    context,
    transaction,
    dumpPath: state.dumpPath,
    backupPath: path.join(state.run, 'backups', 'bound.pm2'),
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => { lists += 1; return completeLive(); },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'pm2_receipt_transaction_mismatch');

  assert.equal(lists, 0);
  assert.equal(saves, 0);
  await assert.rejects(guardedPm2Save({
    ...configuredAuthority(),
    context,
    transaction,
    dumpPath: state.dumpPath,
    backupPath: path.join(state.run, 'backups', 'bound-replay.pm2'),
    allowChanged: APPROVED,
    apply: false,
    listProcesses: async () => completeLive(),
  }), (error) => error.code === 'pm2_receipt_transaction_replayed');
});

test('reserved output replacement is never overwritten when a branded apply begins', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const output = path.join(state.run, 'replacement-no-overwrite.json');
  const displaced = path.join(state.run, 'replacement-original.json');
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: output,
    mode: 'apply',
    dumpPath: state.dumpPath,
  });
  await fs.rename(output, displaced);
  const operatorBytes = Buffer.from('operator-owned replacement\n');
  await fs.writeFile(output, operatorBytes, { mode: 0o600, flag: 'wx' });
  let lists = 0;
  let saves = 0;

  await assert.rejects(guardedPm2Save({
    ...configuredAuthority(),
    context,
    transaction,
    dumpPath: state.dumpPath,
    backupPath: path.join(state.run, 'backups', 'replacement.pm2'),
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => { lists += 1; return completeLive(); },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'receipt_output_changed');

  assert.equal(lists, 0);
  assert.equal(saves, 0);
  assert.deepEqual(await fs.readFile(output), operatorBytes);
});

test('branded transaction refuses cross-dump and cross-context substitution', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const other = await cliFixture(t);
  const context = await receiptContextFor(state);
  const otherContext = await receiptContextFor(other);
  let saves = 0;

  for (const [label, suppliedContext, suppliedDump] of [
    ['dump', context, path.join(state.root, 'different-dump.pm2')],
    ['context', otherContext, state.dumpPath],
  ]) {
    const transaction = await prepareGuardedPm2ReceiptTransaction({
      context,
      outputPath: path.join(state.run, `cross-${label}.json`),
      mode: 'apply',
      dumpPath: state.dumpPath,
    });
    await assert.rejects(guardedPm2Save({
      ...configuredAuthority(),
      context: suppliedContext,
      transaction,
      dumpPath: suppliedDump,
      backupPath: path.join(state.run, 'backups', `cross-${label}.pm2`),
      allowChanged: APPROVED,
      apply: true,
      listProcesses: async () => completeLive(),
      save: async () => { saves += 1; },
    }), (error) => error.code === 'pm2_receipt_transaction_mismatch');
  }
  assert.equal(saves, 0);
});

test('concurrent and replayed use of one branded transaction permits one execution only', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: path.join(state.run, 'single-use.json'),
    mode: 'dry-run',
    dumpPath: state.dumpPath,
  });
  let lists = 0;
  const options = {
    ...configuredAuthority(),
    context,
    transaction,
    dumpPath: state.dumpPath,
    backupPath: path.join(state.run, 'backups', 'single-use.pm2'),
    allowChanged: APPROVED,
    apply: false,
    listProcesses: async () => { lists += 1; return completeLive(); },
  };

  const concurrent = await Promise.allSettled([
    guardedPm2Save(options),
    guardedPm2Save(options),
  ]);
  assert.equal(concurrent.filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejected = concurrent.find((entry) => entry.status === 'rejected');
  assert.equal(rejected.reason.code, 'pm2_receipt_transaction_replayed');
  assert.equal(lists, 2);
  await assert.rejects(
    guardedPm2Save(options),
    (error) => error.code === 'pm2_receipt_transaction_replayed',
  );
});

test('transaction and reserved files are revalidated immediately before save', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const output = path.join(state.run, 'stale-before-save.json');
  const displaced = path.join(state.run, 'stale-before-save.displaced.json');
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: output,
    mode: 'apply',
    dumpPath: state.dumpPath,
  });
  const replacement = Buffer.from('operator replacement before save\n');
  let lists = 0;
  let saves = 0;

  await assert.rejects(guardedPm2Save({
    ...configuredAuthority(),
    context,
    transaction,
    dumpPath: state.dumpPath,
    backupPath: path.join(state.run, 'backups', 'stale-before-save.pm2'),
    allowChanged: APPROVED,
    apply: true,
    listProcesses: async () => {
      lists += 1;
      if (lists === 1) {
        await fs.rename(output, displaced);
        await fs.writeFile(output, replacement, { mode: 0o600, flag: 'wx' });
      }
      return completeLive();
    },
    save: async () => { saves += 1; },
  }), (error) => error.code === 'receipt_output_changed');
  assert.equal(lists, 1);
  assert.equal(saves, 0);
  assert.deepEqual(await fs.readFile(output), replacement);
});

test('post-save backup pathname replacement restores only from retained verified backup', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const backupPath = path.join(state.run, 'backups', 'retained-backup.pm2');
  const displacedBackup = path.join(state.run, 'backups', 'retained-backup.displaced.pm2');
  const replacement = Buffer.from('operator backup replacement\n');
  const original = await fs.readFile(state.dumpPath);
  const originalMode = (await fs.stat(state.dumpPath)).mode & 0o777;
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: path.join(state.run, 'retained-backup-result.json'),
    mode: 'apply',
    dumpPath: state.dumpPath,
  });

  let caught;
  try {
    await guardedPm2Save({
      ...configuredAuthority(),
      context,
      transaction,
      dumpPath: state.dumpPath,
      backupPath,
      allowChanged: APPROVED,
      apply: true,
      listProcesses: async () => completeLive(),
      save: async () => {
        await fs.rename(backupPath, displacedBackup);
        await fs.writeFile(backupPath, replacement, { mode: 0o600, flag: 'wx' });
        await fs.writeFile(state.dumpPath, 'invalid post-save dump\n', { mode: 0o600 });
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.pm2Save?.backupRestoreSourceVerified, true);
  assert.equal(caught?.pm2Save?.backupRestoreSource, 'retained-exclusive-backup-file');
  assert.equal(caught?.pm2Save?.restored, true);
  assert.equal(caught?.pm2Save?.restorationVerified, true);
  assert.deepEqual(await fs.readFile(state.dumpPath), original);
  assert.equal((await fs.stat(state.dumpPath)).mode & 0o777, originalMode);
  assert.deepEqual(await fs.readFile(backupPath), replacement);
  assert.deepEqual(await fs.readFile(displacedBackup), original);
});

test('one-sided failure publication never leaves a public committed-success result', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');
  const state = await cliFixture(t);
  const context = await receiptContextFor(state);
  const output = path.join(state.run, 'one-sided-publication.json');
  const savedDump = await fs.readFile(state.dumpPath);
  const transaction = await prepareGuardedPm2ReceiptTransaction({
    context,
    outputPath: output,
    mode: 'apply',
    dumpPath: state.dumpPath,
    beforeFinalReadback: async () => {
      const error = new Error('fail after success result write');
      error.code = 'receipt_success_result_injected_failure';
      throw error;
    },
    beforeFailureIntent: async () => {
      const error = new Error('retain one-sided intent failure');
      error.code = 'receipt_failure_intent_injected_failure';
      throw error;
    },
  });
  let caught;
  try {
    await guardedPm2Save({
      ...configuredAuthority(),
      context,
      transaction,
      dumpPath: state.dumpPath,
      backupPath: path.join(state.run, 'backups', 'one-sided-publication.pm2'),
      allowChanged: APPROVED,
      apply: true,
      listProcesses: async () => completeLive(),
      save: async () => fs.writeFile(state.dumpPath, savedDump),
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, 'receipt_success_result_injected_failure');
  assert.equal(caught?.pm2Save?.restorationVerified, true);
  assert.equal(caught?.failureEvidenceError?.code, 'receipt_failure_evidence_unavailable');
  const result = JSON.parse(await fs.readFile(output, 'utf8'));
  const intent = JSON.parse(await fs.readFile(transaction.intentPath, 'utf8'));
  assert.equal(result.transactionState, 'failed-restored');
  assert.equal(result.ok, false);
  assert.equal(intent.transactionState, 'committed');
  assert.equal(intent.ok, true);
  assert.notEqual(intent.outputArtifactSha256, result.artifactSha256);
});

test('apply reloads ecosystem and revalidates live apps modules and restart baseline before save', async (t) => {
  const {
    guardedPm2Save,
    prepareGuardedPm2ReceiptTransaction,
  } = await import('../../scripts/guarded-pm2-save.mjs');

  for (const variant of ['ecosystem', 'application', 'module', 'restart-baseline']) {
    const state = await cliFixture(t);
    const context = await receiptContextFor(state);
    const transaction = await prepareGuardedPm2ReceiptTransaction({
      context,
      outputPath: path.join(state.run, `pre-save-${variant}.json`),
      mode: 'apply',
      dumpPath: state.dumpPath,
    });
    let lists = 0;
    let reloads = 0;
    let saves = 0;
    const initialRows = variant === 'module'
      ? [...completeLive(), moduleLiveRow()]
      : completeLive();
    const expectedCode = {
      ecosystem: 'pm2_ecosystem_authority_changed',
      application: 'pm2_unrelated_drift',
      module: 'pm2_live_module_changed',
      'restart-baseline': 'pm2_restart_baseline_regressed',
    }[variant];

    await assert.rejects(guardedPm2Save({
      ...configuredAuthority(),
      context,
      transaction,
      dumpPath: state.dumpPath,
      backupPath: path.join(state.run, 'backups', `pre-save-${variant}.pm2`),
      allowChanged: APPROVED,
      apply: true,
      restartBaselineRows: stabilityProjection(initialRows),
      reloadEcosystemApps: async () => {
        reloads += 1;
        return variant === 'ecosystem'
          ? completeEcosystem({ 'home23-jerry': { cwd: '/changed-ecosystem' } })
          : completeEcosystem();
      },
      listProcesses: async () => {
        lists += 1;
        if (lists === 1 || variant === 'ecosystem') return structuredClone(initialRows);
        if (variant === 'application') {
          return completeLive({ 'unrelated-service': { pm_cwd: '/changed-live-app' } });
        }
        if (variant === 'module') {
          return [...completeLive(), moduleLiveRow('pm2-logrotate', { restart_time: 3 })];
        }
        return completeLive({ 'unrelated-service': { restart_time: 1 } });
      },
      save: async () => { saves += 1; },
    }), (error) => error.code === expectedCode, variant);
    assert.equal(saves, 0, `${variant} blocks before save`);
    assert.equal(reloads, 1, `${variant} reloads ecosystem once immediately pre-save`);
    assert.equal(lists, variant === 'ecosystem' ? 1 : 2, `${variant} live table reads`);
  }
});

test('guarded apply serializes separate CLI processes for the same dump', async (t) => {
  const state = await cliFixture(t);
  const fakePm2 = path.join(state.root, 'bin', 'pm2');
  const active = path.join(state.root, 'fake-save-active');
  const overlap = path.join(state.root, 'fake-save-overlap.log');
  const timeline = path.join(state.root, 'fake-save-timeline.log');
  await fs.writeFile(fakePm2, `#!${process.execPath}\n`
    + "const fs=require('node:fs');\n"
    + "const command=process.argv[2];\n"
    + "if(command==='jlist'){process.stdout.write(fs.readFileSync(process.env.FAKE_PM2_JLIST));return;}\n"
    + "if(command!=='save'){process.exitCode=64;return;}\n"
    + "let fd;try{fd=fs.openSync(process.env.FAKE_PM2_ACTIVE,'wx',0o600);}\n"
    + "catch(error){fs.appendFileSync(process.env.FAKE_PM2_OVERLAP,'overlap\\n');process.exit(73);}\n"
    + "fs.appendFileSync(process.env.FAKE_PM2_TIMELINE,'start\\n');\n"
    + "setTimeout(()=>{fs.closeSync(fd);fs.unlinkSync(process.env.FAKE_PM2_ACTIVE);"
    + "fs.appendFileSync(process.env.FAKE_PM2_TIMELINE,'end\\n');},250);\n");
  await fs.chmod(fakePm2, 0o755);
  Object.assign(state.env, {
    FAKE_PM2_ACTIVE: active,
    FAKE_PM2_OVERLAP: overlap,
    FAKE_PM2_TIMELINE: timeline,
  });

  const first = runGuardedCli(state, 'apply', path.join(state.run, 'serialized-first.json'));
  await waitForPath(active);
  const second = runGuardedCli(state, 'apply', path.join(state.run, 'serialized-second.json'));
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 2);
  await assert.rejects(fs.access(overlap), (error) => error.code === 'ENOENT');
  assert.deepEqual(
    (await fs.readFile(timeline, 'utf8')).trim().split('\n'),
    ['start', 'end', 'start', 'end'],
  );
  await assert.rejects(
    fs.access(`${state.dumpPath}.home23-guarded-save.lock`),
    (error) => error.code === 'ENOENT',
  );
});
