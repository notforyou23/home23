import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHostAction, ownedProcessNames, productDefinitions, probeReadiness, safeProcesses } from '../cli/lib/product-host.js';
import { productEnvironment, privateJSON, socketRootFor, choosePortPlan } from '../cli/lib/product-environment.js';
import { writeProductManifest, installProductPayload } from '../cli/lib/product-payload.js';
import { adoptProductSupervisor, ensureProductSupervisor, inspectProductSupervisor, productSupervisorCommand, productSupervisorPlan, supervisorPlist } from '../cli/lib/product-supervisor.js';
import { parsePlist } from '../cli/lib/product-foreign-bindings.js';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-unit-')));
  const root = path.join(base, 'Home'), payload = path.join(base, 'payload');
  t.after(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(socketRootFor(root), { recursive: true, force: true }); });
  for (const file of ['bin/node', 'app/cli/home23.js', 'app/cli/lib/product-payload.js', 'app/cli/lib/product-supervisor.js', 'app/scripts/product/host.mjs', 'tools/node_modules/pm2/bin/pm2', 'tools/node_modules/pm2/lib/Daemon.js']) {
    fs.mkdirSync(path.dirname(path.join(payload, file)), { recursive: true });
    fs.writeFileSync(path.join(payload, file), '', { mode: file === 'bin/node' ? 0o755 : 0o644 });
  }
  writeProductManifest(payload, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.19.0' });
  installProductPayload({ payloadPath: payload, homeRoot: root });
  productEnvironment(root, { prepare: true });
  return root;
}

test('macOS Start admits launchd ownership before any mutating PM2 command', async t => {
  const homeRoot = fixture(t);
  privateJSON(path.join(homeRoot, '.home23-host.json'), { schema: 'home23.host.v1', homeRoot, ports: await choosePortPlan(), profile: { name: 'milo' }, phase: 'prepared', desiredRunning: false, encoderRequired: false });
  const rows = [], calls = [];
  const execute = async (_file, args) => {
    const cmd = args[1];
    calls.push(cmd);
    if (cmd === 'jlist') return { stdout: JSON.stringify(rows) };
    if (cmd === 'start') rows.push({ name: args[args.indexOf('--only') + 1], pid: 10, pm2_env: { status: 'online', pm_exec_path: path.join(homeRoot, 'bin/node'), pm_cwd: path.join(homeRoot, 'app'), args: [] } });
    return { stdout: '' };
  };
  await runHostAction('start', { homeRoot }, {
    execute, platform: 'darwin',
    ensureProductSupervisor: async () => { calls.push('launchd-admitted'); },
    definitions: () => productDefinitions(ownedProcessNames('milo').map(name => ({ name, script: 'dist/home.js', env: {} })), homeRoot, 'milo'),
    readinessWaitMs: 0, probeReadiness: async () => ({ ready: true, issues: [] }),
  });
  assert.ok(calls.indexOf('launchd-admitted') >= 0, 'Start must establish independent supervisor ownership');
  assert.ok(calls.indexOf('launchd-admitted') < calls.indexOf('start'));
});

function machine(root) {
  const plan = productSupervisorPlan(root), calls = [];
  let live = false, loaded = false, pid = 4242, wrongSocket = false, unknown = false, jobPid = 4242;
  const deps = {
    platform: 'darwin', identity: async () => 'fixture-generation', alive: p => live && p === pid,
    listening: async p => unknown ? null : p === path.join(plan.env.PM2_HOME, 'rpc.sock') ? wrongSocket : live && [plan.env.PM2_DAEMON_RPC_PORT, plan.env.PM2_DAEMON_PUB_PORT].includes(p),
    execute: async (file, args) => {
      calls.push([file, ...args]);
      assert.equal(file, '/bin/launchctl');
      if (args[0] === 'list') { if (!loaded) throw Object.assign(new Error('absent'), { code: 113 }); return { stdout: `{\n\t"Label" = "${plan.label}";\n${live && jobPid ? `\t"PID" = ${jobPid};\n` : ''}};\n` }; }
      assert.ok(['bootstrap', 'kickstart'].includes(args[0]));
      loaded = true; live = true;
      fs.writeFileSync(path.join(plan.env.PM2_HOME, 'pm2.pid'), String(pid));
      const claim = JSON.parse(fs.readFileSync(plan.claim));
      privateJSON(plan.owner, { schema: 'home23.supervisor.owner.v1', homeRoot: root, token: claim.token, pid, parentPid: 1 });
      return { stdout: '' };
    },
  };
  return { plan, calls, deps, get live() { return live; }, set live(v) { live = v; }, get loaded() { return loaded; }, set loaded(v) { loaded = v; }, set pid(v) { pid = v; }, set jobPid(v) { jobPid = v; }, set wrongSocket(v) { wrongSocket = v; }, set unknown(v) { unknown = v; } };
}

test('launchd config is home-specific, foreground, private, and excludes ambient credentials', t => {
  const root = fixture(t), plan = productSupervisorPlan(root), other = productSupervisorPlan(path.join(path.dirname(root), 'other'));
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'do-not-copy';
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const job = parsePlist(supervisorPlist(plan, 'a'.repeat(36)));
  assert.notEqual(plan.label, other.label); assert.notEqual(plan.env.PM2_DAEMON_RPC_PORT, other.env.PM2_DAEMON_RPC_PORT);
  assert.deepEqual(job.ProgramArguments, [plan.node, plan.module, '--resident-daemon', root, 'a'.repeat(36)]);
  assert.equal(job.KeepAlive, false); assert.equal(job.Umask, 63); assert.equal(job.ExitTimeOut, 240);
  assert.equal(job.EnvironmentVariables.PM2_HOME, path.join(root, 'runtime/pm2'));
  assert.equal(job.EnvironmentVariables.OPENAI_API_KEY, undefined); assert.equal(job.EnvironmentVariables.NODE_OPTIONS, undefined);
});

test('read-only absent inspection leaves private runtime unchanged and never loads a job', async t => {
  const root = fixture(t), m = machine(root), before = fs.readdirSync(m.plan.env.PM2_HOME);
  assert.equal((await inspectProductSupervisor(root, m.deps)).ownership, 'absent');
  assert.deepEqual(fs.readdirSync(m.plan.env.PM2_HOME), before);
  assert.ok(m.calls.every(c => c[1] === 'list'));
});

test('cold Start is launchd-owned and repeated Start joins the same PID without replacing the job', async t => {
  const root = fixture(t), m = machine(root);
  assert.equal((await ensureProductSupervisor(root, m.deps)).ownership, 'launchd');
  const claim = fs.readFileSync(m.plan.claim);
  assert.equal((await ensureProductSupervisor(root, m.deps)).pid, 4242);
  assert.equal(m.calls.filter(c => c[1] === 'bootstrap').length, 1);
  assert.deepEqual(fs.readFileSync(m.plan.claim), claim);
  assert.equal(fs.statSync(m.plan.plist).mode & 0o777, 0o600);
});

test('legacy daemon requires explicit update admission; no daemon or role is changed', async t => {
  const root = fixture(t), m = machine(root); m.live = true;
  fs.writeFileSync(path.join(m.plan.env.PM2_HOME, 'pm2.pid'), '4242');
  assert.equal((await inspectProductSupervisor(root, m.deps)).ownership, 'legacy');
  await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_adoption_required' });
  assert.ok(m.calls.every(c => c[1] === 'list')); assert.equal(fs.existsSync(m.plan.claim), false);
});

test('ambiguous or noncanonical sockets and alive stale PIDs block creation', async t => {
  for (const kind of ['wrongSocket', 'unknown', 'stale']) {
    const root = fixture(t), m = machine(root);
    if (kind === 'stale') { m.live = true; fs.writeFileSync(path.join(m.plan.env.PM2_HOME, 'pm2.pid'), '4242'); m.deps.listening = async () => false; }
    else m[kind] = true;
    await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
    assert.ok(m.calls.every(c => c[1] === 'list'));
  }
});

test('foreign loaded label and altered private config fail closed without bootout', async t => {
  const root = fixture(t), m = machine(root); m.loaded = true;
  await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
  m.loaded = false; await ensureProductSupervisor(root, m.deps);
  fs.appendFileSync(m.plan.plist, '<!-- altered -->');
  await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
  assert.ok(m.calls.every(c => !['bootout', 'kill'].includes(c[1])));
});

test('Linux ensure and inspect do not load jobs or change any home state', async t => {
  const root = fixture(t), m = machine(root), before = fs.readdirSync(m.plan.env.PM2_HOME);
  for (const fn of [inspectProductSupervisor, ensureProductSupervisor]) assert.equal((await fn(root, { platform: 'linux', execute() { throw new Error('unexpected'); } })).ownership, 'not_required');
  assert.deepEqual(fs.readdirSync(m.plan.env.PM2_HOME), before);
});

test('loaded inactive label or a different launchd PID cannot admit a reparented socket owner', async t => {
  for (const pid of [null, 8181]) {
    const root = fixture(t), m = machine(root);
    await ensureProductSupervisor(root, m.deps);
    m.jobPid = pid;
    await assert.rejects(inspectProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
    await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
    assert.equal(m.calls.filter(c => c[1] === 'bootstrap').length, 1);
  }
});

async function migrationFixture(t, runtimeEnv = {}) {
  const root = fixture(t), m = machine(root); m.live = true;
  fs.writeFileSync(path.join(m.plan.env.PM2_HOME, 'pm2.pid'), '4242');
  const state = { schema: 'home23.host.v1', homeRoot: root, profile: { name: 'milo' }, desiredRunning: true, phase: 'starting', encoderRequired: false };
  privateJSON(path.join(root, '.home23-host.json'), state);
  const journalPath = path.join(path.dirname(root), '.Home.home23-update/journal.json');
  fs.mkdirSync(path.dirname(journalPath), { mode: 0o700 });
  privateJSON(journalPath, { id: 'update-fixture', homeRoot: root, ownerToken: 'fixture-token', phase: 'verifying', candidateStarted: false });
  const env = { pm_cwd: path.join(root, 'app'), pm_exec_path: path.join(root, 'bin/node'), args: [path.join(root, 'app/fixture-role.cjs')], exec_interpreter: 'none', kill_timeout: 230000, listen_timeout: 34000, env: { PRIVATE_VALUE: 'preserve-without-printing', ...runtimeEnv } };
  const registrations = [{ name: 'home23-milo', pm2_env: { ...env, status: 'online' } }, { name: 'home23-milo-dash', pm2_env: { ...env, status: 'stopped' } }];
  let rows = structuredClone(registrations);
  const commands = [], signals = [];
  m.deps.command = async args => { commands.push(args); if (args[0] === 'stop') rows.find(r => r.name === args[1]).pm2_env.status = 'stopped'; return { stdout: JSON.stringify(rows) }; };
  m.deps.signal = (pid, signal) => { signals.push([pid, signal]); m.live = false; };
  m.deps.restore = async (_root, saved) => { rows = structuredClone(saved).map(r => ({ ...r, pm2_env: { ...r.pm2_env, status: 'stopped' } })); };
  return { root, m, state, commands, signals, registrations, journalPath, clearRows() { rows = []; }, admission: { expectedPid: 4242, generation: 'fixture-generation', registrations, updateId: 'update-fixture', updateOwnerToken: 'fixture-token' } };
}

test('admitted migration preserves all definitions and paused roles, signals only the exact old PID, and is resumable', async t => {
  const f = await migrationFixture(t), before = fs.readFileSync(path.join(f.root, '.home23-host.json'));
  const result = await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.deepEqual(f.signals, [[4242, 'SIGINT']]);
  assert.equal(result.ownership, 'launchd'); assert.deepEqual(result.pausedNames, ['home23-milo-dash']);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.snapshotPath)).registrations, f.registrations);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.home23-host.json')), before);
  assert.ok(f.commands.every(c => !c.includes('all')));
  assert.equal(f.m.calls.filter(c => c[1] === 'bootstrap').length, 1);
  await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(f.signals.length, 1);
});

test('missing/stale admission, foreign roles and changed definitions cannot stop the daemon', async t => {
  for (const kind of ['token', 'phase', 'foreign', 'changed']) {
    const f = await migrationFixture(t);
    if (kind === 'token') f.admission.updateOwnerToken = 'wrong';
    if (kind === 'phase') privateJSON(f.journalPath, { id: 'update-fixture', homeRoot: f.root, ownerToken: 'fixture-token', phase: 'writers_admitted' });
    if (kind === 'foreign') f.admission.registrations.push({ name: 'other', pm2_env: f.registrations[0].pm2_env });
    if (kind === 'changed') f.admission.registrations[0].pm2_env.kill_timeout = 3;
    await assert.rejects(adoptProductSupervisor(f.root, f.admission, f.m.deps));
    assert.deepEqual(f.signals, []); assert.equal(f.commands.filter(c => c[0] === 'stop').length, 0);
  }
});

test('a daemon that ignores bounded SIGINT retains the snapshot and never gets SIGKILL or a replacement', async t => {
  const f = await migrationFixture(t);
  f.m.deps.signal = (pid, signal) => f.signals.push([pid, signal]);
  await assert.rejects(adoptProductSupervisor(f.root, f.admission, { ...f.m.deps, shutdownTimeoutMs: 1, pollMs: 1 }), { code: 'host_supervisor_shutdown_pending' });
  assert.deepEqual(f.signals, [[4242, 'SIGINT']]); assert.equal(fs.existsSync(f.m.plan.migration), true);
  assert.equal(f.m.calls.filter(c => c[1] === 'bootstrap').length, 0);
});

test('writer admission or accepted Work prevents migration even when all rows are stopped', async t => {
  const f = await migrationFixture(t);
  privateJSON(f.journalPath, { id: 'update-fixture', homeRoot: f.root, ownerToken: 'fixture-token', phase: 'writers_admitted', writersAdmitted: true, acceptedWork: true, candidateStarted: false });
  await assert.rejects(adoptProductSupervisor(f.root, f.admission, f.m.deps), { code: 'host_supervisor_admission_required' });
  assert.deepEqual(f.signals, []);
  await f.m.deps.command(['stop', 'home23-milo']);
  await assert.rejects(adoptProductSupervisor(f.root, f.admission, f.m.deps), { code: 'host_supervisor_admission_required' });
  const g = await migrationFixture(t);
  privateJSON(g.journalPath, { id: 'update-fixture', homeRoot: g.root, ownerToken: 'fixture-token', phase: 'writers_admitted', candidateStarted: true });
  await assert.rejects(adoptProductSupervisor(g.root, g.admission, g.m.deps), { code: 'host_supervisor_admission_required' });
  assert.deepEqual(g.signals, []);
});

test('registration snapshots must belong to this exact update; names-only fallback is refused', async t => {
  const f = await migrationFixture(t);
  await assert.rejects(adoptProductSupervisor(f.root, { ...f.admission, updateId: 'different' }, f.m.deps), { code: 'host_supervisor_admission_required' });
  await assert.rejects(adoptProductSupervisor(f.root, { expectedPid: 4242, updateId: 'update-fixture', updateOwnerToken: 'fixture-token' }, f.m.deps), { code: 'host_supervisor_ambiguous' });
  assert.deepEqual(f.signals, []);
});

test('read-only client refuses unprepared runtime and maps lost connections to a truthful error', async t => {
  const root = fixture(t), env = productEnvironment(root);
  fs.rmSync(env.HOME, { recursive: true });
  await assert.rejects(productSupervisorCommand(root, ['jlist'], { execute() { throw new Error('client must not run'); } }), /not prepared/);
  assert.equal(fs.existsSync(env.HOME), false);
  productEnvironment(root, { prepare: true });
  await assert.rejects(productSupervisorCommand(root, ['jlist'], { execute: async () => { throw Object.assign(new Error('lost'), { code: 75 }); } }), { code: 'host_supervisor_ambiguous' });
});

function bindPausedJournal(root, registrations) {
  const snapshotPath = path.join(root, 'runtime/pm2/supervisor-migration.json');
  const pausedNames = registrations.filter(row => ['stopped', 'errored'].includes(row.pm2_env.status)).map(row => row.name);
  privateJSON(snapshotPath, { schema: 'home23.supervisor.migration.v1', updateId: 'paused-update', phase: 'registered', registrations });
  const journalPath = path.join(path.dirname(root), '.Home.home23-update/journal.json');
  fs.mkdirSync(path.dirname(journalPath), { mode: 0o700 });
  privateJSON(journalPath, { schema: 'home23.product-update.v1', id: 'paused-update', homeRoot: root, ownerToken: 'paused-token', phase: 'writers_admitted', candidateStarted: false, supervisorMigration: { updateId: 'paused-update', snapshotPath, pausedNames } });
  return journalPath;
}

test('owner-bound update Start retains the paused registration and starts only active roles', async t => {
  const root = fixture(t), ports = await choosePortPlan();
  privateJSON(path.join(root, '.home23-host.json'), { schema: 'home23.host.v1', homeRoot: root, ports, profile: { name: 'milo' }, phase: 'starting', desiredRunning: true, encoderRequired: false });
  const apps = productDefinitions(ownedProcessNames('milo').map(name => ({ name, script: 'dist/home.js', env: {} })), root, 'milo');
  const rows = apps.map(app => ({ name: app.name, pid: 0, pm2_env: { ...app.env, status: 'stopped', pm_exec_path: path.join(root, 'bin/node'), pm_cwd: app.cwd, args: app.args, min_uptime: app.min_uptime, exp_backoff_restart_delay: app.exp_backoff_restart_delay } }));
  const saved = structuredClone(rows); saved.forEach(r => { if (r.name !== 'home23-milo-dash') r.pm2_env.status = 'online'; });
  bindPausedJournal(root, saved);
  const commands = [];
  const result = await runHostAction('start', { homeRoot: root, input: { updateOwnerToken: 'paused-token', pausedProcessNames: ['home23-coordination'] } }, {
    execute: async (_node, args) => { commands.push(args.slice(1)); if (args[1] === 'restart') { const row = rows.find(r => r.name === args[2]); row.pm2_env.status = 'online'; row.pid = 123; } return { stdout: JSON.stringify(rows) }; },
    definitions: () => apps, readinessWaitMs: 0, probeReadiness: async () => ({ ready: true, issues: [] }),
  });
  assert.deepEqual(result.pausedProcessNames, ['home23-milo-dash']);
  assert.equal(rows.length, apps.length); assert.equal(rows.find(r => r.name === 'home23-milo-dash').pm2_env.status, 'stopped');
  assert.ok(commands.some(c => c[0] === 'restart' && c[1] === 'home23-coordination'));
  assert.ok(!commands.some(c => ['start', 'restart', 'delete'].includes(c[0]) && c.includes('home23-milo-dash')));
  const file = path.join(path.dirname(root), '.Home.home23-update/journal.json');
  const journal = JSON.parse(fs.readFileSync(file)); journal.phase = 'committed'; privateJSON(file, journal);
  rows.forEach(r => { r.pm2_env.status = 'stopped'; r.pid = 0; }); commands.length = 0;
  await runHostAction('start', { homeRoot: root }, {
    execute: async (_node, args) => { commands.push(args.slice(1)); if (args[1] === 'restart') { const row = rows.find(r => r.name === args[2]); row.pm2_env.status = 'online'; row.pid = 123; } return { stdout: JSON.stringify(rows) }; },
    definitions: () => apps, readinessWaitMs: 0, probeReadiness: async () => ({ ready: true, issues: [] }),
  });
  assert.equal(rows.find(r => r.name === 'home23-milo-dash').pm2_env.status, 'stopped');
  assert.ok(!commands.some(c => ['start', 'restart', 'delete'].includes(c[0]) && c.includes('home23-milo-dash')));
});

test('already-independent update pause authority comes from full journal admission, including errored roles', async t => {
  const root = fixture(t), ports = await choosePortPlan();
  const state = { schema: 'home23.host.v1', homeRoot: root, ports, profile: { name: 'milo' }, desiredRunning: true, encoderRequired: false };
  privateJSON(path.join(root, '.home23-host.json'), state);
  const names = ownedProcessNames('milo');
  const rows = names.map(name => ({ name, pid: 0, pm2_env: { status: name === 'home23-milo-dash' ? 'errored' : 'online', pm_exec_path: path.join(root, 'bin/node'), pm_cwd: path.join(root, 'app'), args: [path.join(root, 'app/fixture-role.cjs')] } }));
  const journalPath = bindPausedJournal(root, rows);
  const journal = JSON.parse(fs.readFileSync(journalPath));
  journal.supervisorAdmission = { expectedPid: 4242, generation: 'fixture-generation', ownership: 'launchd', registrations: rows };
  journal.supervisorMigration = { ownership: 'launchd', pid: 4242, pausedNames: ['home23-milo-dash'] };
  privateJSON(journalPath, journal);
  fs.rmSync(path.join(root, 'runtime/pm2/supervisor-migration.json'));
  const currentRows = rows.map(r => ({ ...r, pm2_env: { ...r.pm2_env, status: r.name === 'home23-milo-dash' ? 'stopped' : 'online' } }));
  const result = await runHostAction('status', { homeRoot: root }, { execute: async () => ({ stdout: JSON.stringify(currentRows) }), probeReadiness: async () => ({ ready: true, issues: [] }) });
  assert.deepEqual(result.pausedProcessNames, ['home23-milo-dash']);
  assert.equal(result.processes.length, rows.length);
  journal.supervisorMigration.pausedNames = ['home23-coordination']; privateJSON(journalPath, journal);
  await assert.rejects(probeReadiness(root, state, safeProcesses(rows, root, names)), { code: 'host_supervisor_ambiguous' });
});

test('second independent update archives the completed migration and preserves paused intent without another shutdown', async t => {
  const f = await migrationFixture(t);
  await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  privateJSON(f.journalPath, { id: 'second-update', homeRoot: f.root, ownerToken: 'second-token', phase: 'verifying', candidateStarted: false });
  const second = await adoptProductSupervisor(f.root, { ...f.admission, updateId: 'second-update', updateOwnerToken: 'second-token' }, f.m.deps);
  assert.deepEqual(second.pausedNames, ['home23-milo-dash']);
  assert.equal(f.signals.length, 1);
  assert.equal(f.m.calls.filter(c => c[1] === 'bootstrap').length, 1);
  assert.equal(fs.existsSync(f.m.plan.migration), false);
  assert.equal(fs.readdirSync(f.m.plan.env.PM2_HOME).filter(f => /^supervisor-migration\.[a-f0-9]+\.json$/.test(f)).length, 1);
});

test('same admitted update can restore missing stopped registrations after an independent daemon loss', async t => {
  const f = await migrationFixture(t);
  await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  f.clearRows(); f.m.live = false; f.m.pid = 8181; f.m.jobPid = 8181;
  const resumed = await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(resumed.pid, 8181); assert.deepEqual(resumed.pausedNames, ['home23-milo-dash']);
  assert.equal(f.signals.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(resumed.snapshotPath)).registrations, f.registrations);
});

test('empty absent admission preserves stopped intent or accepts a bounded cold launchd result without a fabricated old PID', async t => {
  for (const desiredRunning of [false, true]) {
    const root = fixture(t), ports = await choosePortPlan();
    const state = { schema: 'home23.host.v1', homeRoot: root, ports, profile: { name: 'milo' }, phase: 'prepared', desiredRunning, encoderRequired: false };
    privateJSON(path.join(root, '.home23-host.json'), state);
    const file = bindPausedJournal(root, []), journal = JSON.parse(fs.readFileSync(file));
    journal.supervisorAdmission = { ownership: 'absent', registrations: [] };
    journal.supervisorMigration = desiredRunning ? { ownership: 'launchd', updateId: journal.id, pid: 4242, generation: 'fixture-generation', pausedNames: [] } : { ownership: 'absent', running: false };
    privateJSON(file, journal);
    const result = await runHostAction('status', { homeRoot: root }, { execute: async () => ({ stdout: '[]' }) });
    assert.deepEqual(result.pausedProcessNames, []); assert.equal(result.desiredRunning, desiredRunning);
    journal.supervisorMigration = desiredRunning ? { ownership: 'absent', running: false } : { ownership: 'launchd', pid: 4242, generation: 'fixture-generation', pausedNames: [] };
    privateJSON(file, journal);
    await assert.rejects(probeReadiness(root, state, []), { code: 'host_supervisor_ambiguous' });
  }
});

test('retained executable is admitted only by the exact selected journal, package bytes and daemon generation', async t => {
  const root = fixture(t), m = machine(root);
  await ensureProductSupervisor(root, m.deps);
  const previous = path.join(path.dirname(root), '.Home.home23-update/previous');
  fs.mkdirSync(previous, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(previous, 'manifest.json'));
  fs.copyFileSync(path.join(root, '.home23-install.json'), path.join(previous, '.home23-install.json'));
  fs.renameSync(path.join(root, 'bin'), path.join(previous, 'bin'));
  fs.mkdirSync(path.join(root, 'bin')); fs.writeFileSync(path.join(root, 'bin/node'), '', { mode: 0o755 });
  const journal = { schema: 'home23.product-update.v1', id: 'swap-update', homeRoot: root, ownerToken: 'swap-owner', phase: 'selected', candidateStarted: false, acceptedWork: false,
    fromPackageId: JSON.parse(fs.readFileSync(path.join(previous, 'manifest.json'))).packageId, supervisorAdmission: { expectedPid: 4242, generation: `${process.getuid()} fixture-generation` } };
  const file = path.join(path.dirname(previous), 'journal.json'); privateJSON(file, journal);
  const deps = { ...m.deps, identity: undefined, execute: async (file, args) => {
    if (file === '/bin/ps') return { stdout: `${process.getuid()} fixture-generation\n` };
    if (file === '/usr/sbin/lsof') return { stdout: args.includes('-d') ? `p4242\nn${previous}/bin/node\n` : `p4242\nn${m.plan.env.PM2_DAEMON_RPC_PORT}\nn${m.plan.env.PM2_DAEMON_PUB_PORT}\n` };
    return m.deps.execute(file, args);
  } };
  assert.equal((await inspectProductSupervisor(root, deps)).executable, path.join(previous, 'bin/node'));
  await assert.rejects(ensureProductSupervisor(root, deps), { code: 'host_supervisor_adoption_required' });
  journal.acceptedWork = true; privateJSON(file, journal);
  await assert.rejects(inspectProductSupervisor(root, deps), { code: 'host_supervisor_ambiguous' });
  journal.acceptedWork = false; journal.supervisorAdmission.generation = 'different'; privateJSON(file, journal);
  await assert.rejects(inspectProductSupervisor(root, deps), { code: 'host_supervisor_ambiguous' });
  journal.supervisorAdmission.generation = `${process.getuid()} fixture-generation`; privateJSON(file, journal);
  fs.appendFileSync(path.join(previous, 'bin/node'), 'changed');
  await assert.rejects(inspectProductSupervisor(root, deps), { code: 'host_supervisor_ambiguous' });
});

test('readiness excludes bound paused role probes but still verifies every active role', async t => {
  const root = fixture(t), ports = await choosePortPlan();
  const state = { schema: 'home23.host.v1', homeRoot: root, ports, profile: { name: 'milo' }, desiredRunning: true, encoderRequired: false, birth: { home: { id: 'home-fixture' }, coordination: { botId: 'bot-fixture' } } };
  privateJSON(path.join(root, '.home23-host.json'), state);
  const rows = ownedProcessNames('milo').map(name => ({ name, pid: 123, pm2_env: { status: name === 'home23-milo-dash' ? 'stopped' : 'online', pm_exec_path: path.join(root, 'bin/node'), pm_cwd: path.join(root, 'app'), args: [path.join(root, 'app/fixture-role.cjs')] } }));
  bindPausedJournal(root, rows);
  privateJSON(path.join(root, 'runtime/host-session.json'), { accessToken: 'fixture', refreshToken: 'fixture', accessExpiresAt: new Date(Date.now() + 3600000).toISOString() });
  const seen = [], request = async url => {
    seen.push(url); if (url.endsWith('/process.json')) throw new Error('paused dashboard must not be probed');
    if (url.endsWith('/capabilities')) return { pairingAvailable: true, capabilities: { bootstrap: true, messageSubmission: true } };
    if (url.endsWith('/bootstrap')) return { home: { id: 'home-fixture' }, snapshot: { bots: [{ id: 'bot-fixture', availability: 'available', conversationId: 'conversation-fixture' }] } };
    return { ok: true };
  };
  assert.equal((await probeReadiness(root, state, safeProcesses(rows, root, ownedProcessNames('milo')), { request })).ready, true);
  assert.ok(seen.some(url => url.endsWith('/health'))); assert.ok(!seen.some(url => url.endsWith('/process.json')));
});

function coerceRestoredVizionMarker(f, changeDesired = false) {
  const restore = f.m.deps.restore, command = f.m.deps.command, signal = f.m.deps.signal;
  f.m.deps.signal = (...args) => { signal(...args); f.clearRows(); };
  let restored = false;
  f.m.deps.restore = async (...args) => { await restore(...args); restored = true; };
  f.m.deps.command = async args => {
    const result = await command(args);
    if (!restored || args[0] !== 'jlist') return result;
    const rows = JSON.parse(result.stdout);
    for (const row of rows) {
      row.pm2_env.env.vizion_running = false;
      if (changeDesired) row.pm2_env.env.PRIVATE_VALUE = 'unexpected-desired-edit';
    }
    return { stdout: JSON.stringify(rows) };
  };
}

test('PM2 restored computed vizion marker coercion preserves admission and same-operation resume', async t => {
  const f = await migrationFixture(t, { vizion_running: 'false' });
  coerceRestoredVizionMarker(f);
  const first = await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(first.ownership, 'launchd');
  assert.equal(JSON.parse(fs.readFileSync(first.snapshotPath)).registrations[0].pm2_env.env.vizion_running, 'false');
  const resumed = await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(resumed.pid, first.pid);
  assert.equal(f.signals.length, 1);
  assert.deepEqual(resumed.pausedNames, ['home23-milo-dash']);
});

test('computed marker coercion never permits a changed desired environment', async t => {
  const f = await migrationFixture(t, { vizion_running: 'false' });
  coerceRestoredVizionMarker(f, true);
  await assert.rejects(adoptProductSupervisor(f.root, f.admission, f.m.deps), { code: 'host_supervisor_ambiguous' });
  assert.equal(JSON.parse(fs.readFileSync(f.m.plan.migration)).phase, 'old_exited');
});
