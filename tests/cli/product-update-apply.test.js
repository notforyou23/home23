import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { installProductPayload, verifyProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import { previewProductUpdate } from '../../cli/lib/product-update.js';
import { applyProductUpdate, readUpdateJournal, resumeProductUpdate, softwareUnits, updateBlocksStart, updateDirectoryFor } from '../../cli/lib/product-update-apply.js';
import { candidateCoordinationSchema, inspectCoordinationDatabase, inspectUpdateInventory, SUPPORTED_COORDINATION_MIGRATION_CHECKSUM, SUPPORTED_COORDINATION_SCHEMA, SUPPORTED_COORDINATION_SCHEMA_CHECKSUM, SUPPORTED_COORDINATION_SCHEMAS, ownedWriterNames } from '../../cli/lib/product-update-inventory.js';
import { adoptVerifiedStage, stageLockPath, stageProductPayload } from '../../cli/lib/product-update-stage.js';
import { acquireInstallLock } from '../../cli/lib/product-payload.js';
import { acquireHostLock } from '../../cli/lib/product-backup.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const quiet = { listProcesses: async () => [], acquireHostLock: async () => async () => {} };
const hostStub = `export async function runHostAction(action, { homeRoot, input } = {}) {
  if (!input?.updateOwnerToken) return { ok: false, status: 'recovery_required' };
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.join(homeRoot, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(homeRoot, 'runtime/started.txt'), action);
  return { ok: true, status: 'ready' };
}\n`;

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-apply-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function payload(dir, { sourceCommit, extra = {} } = {}) {
  const files = { 'bin/node': '#!/bin/sh\n', 'app/cli/home23.js': 'export {};\n', 'app/cli/lib/product-payload.js': 'export {};\n',
    'app/scripts/product/host.mjs': 'export {};\n', 'tools/node_modules/pm2/bin/pm2': 'pm2\n',
    'app/dist/coordination/migrations/index.js': 'migration-index\n', 'app/dist/coordination/migrations/0001-coordination-spine.js': 'migration-one\n',
    'app/dist/coordination/contracts/v1/pack-manifest.json': '{}\n', 'app/dist/coordination/contracts/v1/schema.json': '{}\n',
    'app/engine/data/images/.gitkeep': '', ...extra };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  fs.mkdirSync(path.join(dir, 'app/config'), { recursive: true, mode: 0o755 });
  return writeProductManifest(dir, { sourceCommit, platform: process.platform, arch: process.arch, nodeVersion: 'v22.19.0' });
}
function database(file, version = 20) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${version};
    CREATE TABLE schema_migrations (version INTEGER, name TEXT, checksum TEXT, applied_at TEXT, application_version TEXT);
    INSERT INTO schema_migrations VALUES (${version}, 'reviewed', '${SUPPORTED_COORDINATION_SCHEMAS[version]?.migrationChecksum || SUPPORTED_COORDINATION_MIGRATION_CHECKSUM}', 't', 'test');
    CREATE TABLE kernel_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    INSERT INTO kernel_meta VALUES ('schema.checksum', '${SUPPORTED_COORDINATION_SCHEMAS[version]?.schemaChecksum || SUPPORTED_COORDINATION_SCHEMA_CHECKSUM}', 't');
    INSERT INTO kernel_meta VALUES ('schema.version', '${version}', 't');
    CREATE TABLE kept (value TEXT);
    INSERT INTO kept VALUES ('same-home');`);
  db.close();
}
function populate(home, { desiredRunning = false, version = 20 } = {}) {
  const profile = { name: 'milo', provider: 'ollama-local', model: 'fixture' };
  fs.mkdirSync(path.join(home, 'app/config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app/config/home.yaml'), 'name: milo\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'app/config/secrets.yaml'), 'providers: {}\n', { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'app/instances/milo/conversations'), { recursive: true });
  fs.mkdirSync(path.join(home, 'app/instances/milo/brain'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app/instances/milo/conversations/session.txt'), 'hello-milo');
  fs.writeFileSync(path.join(home, 'app/instances/milo/brain/event-ledger.jsonl'), '{"id":"seed-1"}\n');
  database(path.join(home, 'app/instances/.house/coordination/home23-coordination.sqlite3'), version);
  fs.writeFileSync(path.join(home, '.home23-host.json'), JSON.stringify({ schema: 'home23.host.v2', homeRoot: home, profile, desiredRunning, encoderRequired: true, phase: 'prepared' }), { mode: 0o600 });
}
function homeFixture(t, options = {}) {
  const root = tempRoot(t);
  const current = path.join(root, 'current'), candidate = path.join(root, 'candidate'), home = path.join(root, 'home'), staging = path.join(root, 'staging');
  const installed = payload(current, { sourceCommit: 'a'.repeat(40), extra: options.currentExtra || {} });
  const next = payload(candidate, { sourceCommit: 'b'.repeat(40), extra: options.extra || { 'app/cli/lib/update-marker.txt': 'schema-preserving-apply\n' } });
  installProductPayload({ payloadPath: current, homeRoot: home });
  populate(home, options);
  return { root, current, candidate, home, staging, installed, next };
}
function kept(home) {
  const db = new DatabaseSync(path.join(home, 'app/instances/.house/coordination/home23-coordination.sqlite3'), { readOnly: true });
  try { return { value: db.prepare('SELECT value FROM kept').get().value, version: Number(db.prepare('PRAGMA user_version').get().user_version) }; }
  finally { db.close(); }
}
function packageId(home) { return JSON.parse(fs.readFileSync(path.join(home, '.home23-install.json'), 'utf8')).packageId; }
function preserved(home) {
  return { conversation: fs.readFileSync(path.join(home, 'app/instances/milo/conversations/session.txt'), 'utf8'),
    seed: fs.readFileSync(path.join(home, 'app/instances/milo/brain/event-ledger.jsonl'), 'utf8'),
    config: fs.readFileSync(path.join(home, 'app/config/home.yaml'), 'utf8'), ...kept(home) };
}
function run(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: rootDir, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('reviewed schema constants and writer names stay aligned with source', () => {
  const migrations = fs.readFileSync(path.join(rootDir, 'src/coordination/migrations/index.ts'), 'utf8');
  const source = fs.readFileSync(path.join(rootDir, 'cli/lib/product-host.js'), 'utf8');
  assert.match(migrations, new RegExp(SUPPORTED_COORDINATION_SCHEMA_CHECKSUM));
  assert.match(migrations, new RegExp(SUPPORTED_COORDINATION_MIGRATION_CHECKSUM));
  assert.match(source, /agentProcessNames/);
  assert.match(source, /home23-seed-observatory/);
  assert.deepEqual(ownedWriterNames('milo', { encoderRequired: true }), ['home23-coordination', 'home23-milo', 'home23-milo-dash', 'home23-milo-mcp', 'home23-milo-harness', 'home23-milo-seed', 'home23-milo-shipper', 'home23-milo-house-sense', 'home23-seed-observatory', 'home23-evobrew', 'home23-embedder']);
  assert.equal(updateBlocksStart({ phase: 'applying', ownerToken: 'token' }, 'token'), true);
  assert.equal(updateBlocksStart({ phase: 'selected', ownerToken: 'token' }, 'token'), false);
  assert.equal(updateBlocksStart({ phase: 'committed' }), false);
  assert.equal(updateBlocksStart({ phase: 'rolled_back' }), false);
});

test('the reviewed v21 migration is the only accepted schema asset transition', async t => {
  const fixture = homeFixture(t);
  const databaseFile = path.join(fixture.home, 'app/instances/.house/coordination/home23-coordination.sqlite3');
  assert.equal((await inspectCoordinationDatabase(databaseFile)).compatible, true);
  const candidate = structuredClone(fixture.next);
  const index = candidate.files.find(entry => entry.path === 'app/dist/coordination/migrations/index.js');
  index.sha256 = 'd436d6b3cbea64c10127e59f27babc1a6783e62ae386bf4dc8990d84c71e6f90';
  candidate.files.push({ path: 'app/dist/coordination/migrations/0021-notification-recovery-order.js',
    type: 'file', mode: 0o644, size: 4266,
    sha256: '71239e12d1d0164cc5e3b0f395664fc56da906b04627f9c743b8240bbf3004ff' });
  const allowed = await inspectUpdateInventory(fixture.home, { installed: fixture.installed, candidate });
  assert.equal(allowed.reasons.some(item => item.code === 'schema_assets_changed'), false);
  const quick = await inspectUpdateInventory(fixture.home, { installed: fixture.installed, candidate, databaseCheck: 'fingerprint' });
  assert.equal(quick.databaseInspection.compatible, true);
  assert.equal(quick.databaseInspection.integrityChecked, false);
  const emitted = structuredClone(candidate);
  const previous = structuredClone(fixture.installed);
  const generated = {
    'index.d.ts': ['c8e332800f31c42b786e5b6425fca534eaa413fa3ffea76e057aa599a05c2cbc', '753b762758943371621b43542a137664e4e111cc75eb311927da2183297a9f81'],
    'index.d.ts.map': ['17337d0decf4ede4a160ebbf85504535c4c123453aa10b895048c9d7491301ca', '2396ec75a0f10b47cbbebec1aeff7bad20b8fa13bc8ed1fa9309f7c5f7d1f67b'],
    'index.js.map': ['c521b789c6d991a9ce3bcf540735aabff0f9b80641a5033ec159f32262deea35', '3772dfcd06076ea0961c80dbfcdf433abe60b23c2612c4250efb2d4d59474383'],
    '0021-notification-recovery-order.d.ts': [null, '743c3e0e0a76767dc23533fd63b18d3c51eddac768a8bf7a8deeb5cf39ae4156'],
    '0021-notification-recovery-order.d.ts.map': [null, 'd8f85d2a1faffa962260fba6adf1de6e77f62a64a4a556ba3e9eadecde0f015e'],
    '0021-notification-recovery-order.js.map': [null, 'c062d5d7137f0c92c1917b8f6931ea5adb872c9f8f83ef368b504ad32b8d80c0'],
  };
  for (const [name, [oldHash, newHash]] of Object.entries(generated)) {
    const path = `app/dist/coordination/migrations/${name}`;
    if (oldHash) previous.files.push({ path, type: 'file', mode: 0o644, sha256: oldHash });
    emitted.files.push({ path, type: 'file', mode: 0o644, sha256: newHash });
  }
  assert.equal((await inspectUpdateInventory(fixture.home, { installed: previous, candidate: emitted }))
    .reasons.some(item => item.code === 'schema_assets_changed'), false);
  emitted.files.find(entry => entry.path.endsWith('/0021-notification-recovery-order.js.map')).sha256 = '0'.repeat(64);
  assert.equal((await inspectUpdateInventory(fixture.home, { installed: previous, candidate: emitted }))
    .reasons.some(item => item.code === 'schema_assets_changed'), true);
  candidate.files.find(entry => entry.path === 'app/dist/coordination/migrations/0001-coordination-spine.js').sha256 = '0'.repeat(64);
  const changedHistory = await inspectUpdateInventory(fixture.home, { installed: fixture.installed, candidate });
  assert.equal(changedHistory.reasons.some(item => item.code === 'schema_assets_changed'), true);
  candidate.files.find(entry => entry.path === 'app/dist/coordination/migrations/0001-coordination-spine.js').sha256 = fixture.next.files.find(entry => entry.path === 'app/dist/coordination/migrations/0001-coordination-spine.js').sha256;
  index.sha256 = '0'.repeat(64);
  const unreviewedIndex = await inspectUpdateInventory(fixture.home, { installed: fixture.installed, candidate });
  assert.equal(unreviewedIndex.reasons.some(item => item.code === 'schema_assets_changed'), true);

  fs.rmSync(databaseFile);
  database(databaseFile, 21);
  assert.equal((await inspectCoordinationDatabase(databaseFile)).compatible, true);
  index.sha256 = 'd436d6b3cbea64c10127e59f27babc1a6783e62ae386bf4dc8990d84c71e6f90';
  const nextV21 = await inspectUpdateInventory(fixture.home, { installed: candidate, candidate });
  assert.equal(nextV21.reasons.some(item => item.code === 'schema_assets_changed'), false);
  const downgrade = await inspectUpdateInventory(fixture.home, { installed: fixture.installed, candidate: fixture.next });
  assert.equal(downgrade.reasons.some(item => item.code === 'schema_assets_changed'), true);
  const db = new DatabaseSync(databaseFile);
  db.exec("UPDATE kernel_meta SET value = 'wrong' WHERE key = 'schema.checksum'");
  db.close();
  assert.equal((await inspectCoordinationDatabase(databaseFile)).compatible, false);
  assert.equal((await inspectCoordinationDatabase(databaseFile, { quickCheck: false })).compatible, false);
});

test('an in-home relative state link is preserved and an outside link is refused', async t => {
  const fixture = homeFixture(t);
  const directory = path.join(fixture.home, 'app/instances/milo/brain/coordinator');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'insights_curated_cycle.md'), 'inside\n');
  fs.symlinkSync('insights_curated_cycle.md', path.join(directory, 'insights_curated_LATEST.md'));
  const allowed = await inspectUpdateInventory(fixture.home);
  assert.equal(allowed.reasons.some(item => item.code === 'linked_state_path'), false);
  fs.unlinkSync(path.join(directory, 'insights_curated_LATEST.md'));
  const outside = path.join(fixture.root, 'outside-insight.md');
  fs.writeFileSync(outside, 'outside\n');
  fs.symlinkSync(outside, path.join(directory, 'insights_curated_LATEST.md'));
  const refused = await inspectUpdateInventory(fixture.home);
  assert.equal(refused.reasons.some(item => item.code === 'linked_state_path'), true);
});

test('a folded in-home path keeps its volume name with spaces', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'Casey Jones', 'home');
  fs.mkdirSync(path.join(home, 'app/config'), { recursive: true });
  const inside = path.join(home, 'app/instances/milo');
  fs.writeFileSync(path.join(home, 'app/config/home.yaml'), `shell:\n  roots:\n    - >-\n      ${inside.split(' ').join('\n      ')}\n`, { mode: 0o600 });
  const result = await inspectUpdateInventory(home);
  assert.equal(result.reasons.some(item => item.code === 'external_reference'), false);
});

test('refusals happen before a journal or package change', async t => {
  const bad = homeFixture(t, { version: SUPPORTED_COORDINATION_SCHEMA + 1 });
  const refused = await applyProductUpdate({ homeRoot: bad.home, candidatePayload: bad.candidate, staging: bad.staging }, quiet);
  assert.equal(refused.reasons[0].code, 'unsupported_data_version');
  assert.equal(fs.existsSync(updateDirectoryFor(bad.home)), false);
  assert.equal(packageId(bad.home), bad.installed.packageId);
  assert.equal(preserved(bad.home).value, 'same-home');

  const unknown = homeFixture(t);
  fs.writeFileSync(path.join(unknown.home, 'notes.txt'), 'classify me');
  assert.equal((await applyProductUpdate({ homeRoot: unknown.home, candidatePayload: unknown.candidate, staging: unknown.staging }, quiet)).reasons.some(item => item.code === 'unknown_state'), true);
  assert.equal(packageId(unknown.home), unknown.installed.packageId);

  const linked = homeFixture(t);
  const outside = path.join(linked.root, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'poison'), 'POISON-BYTES');
  fs.rmSync(path.join(linked.home, 'app/instances/milo/brain'), { recursive: true });
  fs.symlinkSync(outside, path.join(linked.home, 'app/instances/milo/brain'));
  const linkedResult = await applyProductUpdate({ homeRoot: linked.home, candidatePayload: linked.candidate, staging: linked.staging }, quiet);
  assert.equal(linkedResult.reasons.some(item => item.code === 'linked_state_path'), true);
  assert.equal(JSON.stringify(linkedResult).includes('POISON-BYTES'), false);

  const external = homeFixture(t);
  fs.writeFileSync(path.join(external.home, 'app/config/home.yaml'), 'imports: /Volumes/Outside/photos\n', { mode: 0o600 });
  assert.equal((await applyProductUpdate({ homeRoot: external.home, candidatePayload: external.candidate, staging: external.staging }, quiet)).reasons.some(item => item.code === 'external_reference'), true);

  const tight = homeFixture(t);
  const space = await applyProductUpdate({ homeRoot: tight.home, candidatePayload: tight.candidate, staging: tight.staging }, { ...quiet, statfs: () => ({ bavail: 1n, bsize: 1n }) });
  assert.equal(space.reasons[0].code, 'insufficient_space');
  assert.equal(fs.existsSync(updateDirectoryFor(tight.home)), false);
  assert.equal((await applyProductUpdate({ homeRoot: tight.home, candidatePayload: tight.current, staging: path.join(tight.root, 'other-stage') }, quiet)).reasons[0].code, 'same_package');

  const root = tempRoot(t);
  const current = path.join(root, 'current'), candidate = path.join(root, 'candidate'), home = path.join(root, 'home');
  const installed = payload(current, { sourceCommit: 'a'.repeat(40) });
  payload(candidate, { sourceCommit: 'c'.repeat(40), extra: { 'app/dist/coordination/migrations/0001-coordination-spine.js': 'changed-migration\n' } });
  installProductPayload({ payloadPath: current, homeRoot: home });
  populate(home);
  const changed = await applyProductUpdate({ homeRoot: home, candidatePayload: candidate, staging: path.join(root, 'staging') }, quiet);
  assert.equal(changed.reasons.some(item => item.code === 'schema_assets_changed'), true);
  assert.equal(packageId(home), installed.packageId);

  const busy = homeFixture(t);
  const deferred = await applyProductUpdate({ homeRoot: busy.home, candidatePayload: busy.candidate, staging: busy.staging }, { ...quiet, listProcesses: async () => [{ name: 'home23-milo', status: 'online' }] });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.admission, 'wait');
  assert.equal(fs.existsSync(updateDirectoryFor(busy.home)), false);
  assert.equal(packageId(busy.home), busy.installed.packageId);
});

test('checkpoint headroom accounts for uncheckpointed coordination WAL bytes', async t => {
  const fixture = homeFixture(t);
  const file = path.join(fixture.home, 'app/instances/.house/coordination/home23-coordination.sqlite3');
  const database = new DatabaseSync(file);
  try {
    database.exec('PRAGMA journal_mode=WAL; INSERT INTO kept VALUES (\'wal-row\');');
    const wal = `${file}-wal`;
    assert.ok(fs.statSync(wal).size > 0);
    const available = fs.statSync(file).size + 64 * 1024 * 1024 + fs.statSync(wal).size - 1;
    const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
      staging: fixture.staging }, { ...quiet, statfs: () => ({ bavail: BigInt(available), bsize: 1n }) });
    assert.equal(result.reasons[0].code, 'insufficient_space');
    assert.equal(fs.existsSync(updateDirectoryFor(fixture.home)), false);
  } finally { database.close(); }
});

test('a stopped home updates in place and a running home waits until admission', async t => {
  const stopped = homeFixture(t);
  const before = preserved(stopped.home);
  let started = 0;
  const preview = previewProductUpdate({ homeRoot: stopped.home, candidatePayload: stopped.candidate });
  assert.equal(preview.canInstall, false);
  assert.equal(preview.publisherTrust, 'unverified');
  const result = await applyProductUpdate({ homeRoot: stopped.home, candidatePayload: stopped.candidate, staging: stopped.staging }, { ...quiet, start: async () => { started += 1; return { ok: true }; } });
  assert.equal(result.status, 'committed');
  assert.equal(result.ok, true);
  assert.equal(result.canInstall, false);
  assert.equal(result.networkInstall, false);
  assert.equal(result.publisherTrust, 'unverified');
  assert.equal(result.resumedRunning, false);
  assert.equal(started, 0);
  assert.equal(packageId(stopped.home), stopped.next.packageId);
  assert.equal(fs.readFileSync(path.join(stopped.home, 'app/cli/lib/update-marker.txt'), 'utf8'), 'schema-preserving-apply\n');
  assert.deepEqual(preserved(stopped.home), before);
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(stopped.home), 'controller/node')), true);
  const replay = await applyProductUpdate({ homeRoot: stopped.home, candidatePayload: stopped.candidate, staging: stopped.staging }, quiet);
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 'committed');

  const running = homeFixture(t, { desiredRunning: true, extra: { 'app/cli/lib/update-marker.txt': 'schema-preserving-apply\n', 'app/cli/lib/product-host.js': hostStub } });
  let online = true, quiesced = 0;
  const admitted = await applyProductUpdate({ homeRoot: running.home, candidatePayload: running.candidate, staging: running.staging, admit: true }, {
    ...quiet,
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    quiesce: async () => { quiesced += 1; online = false; return []; },
    start: async () => { started += 1; return { ok: true, status: 'ready' }; },
  });
  assert.equal(quiesced, 1);
  assert.equal(admitted.status, 'committed');
  assert.equal(admitted.resumedRunning, true);
  assert.equal(packageId(running.home), running.next.packageId);
  assert.equal(preserved(running.home).conversation, 'hello-milo');
  assert.equal(preserved(running.home).version, 20);
});

test('an admitted busy v21 database pins its reviewed version after owned writers stop', async t => {
  const v21Assets = Object.fromEntries(['index.js', '0021-notification-recovery-order.js'].map(name => [
    `app/dist/coordination/migrations/${name}`,
    fs.readFileSync(path.join(rootDir, 'dist/coordination/migrations', name)),
  ]));
  const fixture = homeFixture(t, { desiredRunning: true, version: 21, currentExtra: v21Assets,
    extra: { ...v21Assets, 'app/cli/lib/update-marker.txt': 'schema-preserving-apply\n', 'app/cli/lib/product-host.js': hostStub } });
  assert.equal(candidateCoordinationSchema(fixture.next), 21);
  let online = true;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    inspectUpdateInventory: async (...args) => {
      const inventory = await inspectUpdateInventory(...args);
      assert.deepEqual(inventory.reasons, []);
      return { ...inventory, databaseInspection: { present: true, version: null, busy: true, compatible: false },
        reasons: [{ code: 'database_busy', message: 'database is locked' }] };
    },
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    quiesce: async () => { online = false; return []; },
    afterPhase: async journal => {
      if (journal.phase === 'quiesced') {
        const probe = await inspectCoordinationDatabase(path.join(fixture.home, 'app/instances/.house/coordination/home23-coordination.sqlite3'));
        assert.equal(probe.compatible, true, JSON.stringify(probe));
      }
    },
    start: async () => ({ ok: true, status: 'ready' }),
  });
  assert.equal(result.status, 'committed', JSON.stringify(result.reasons));
  assert.equal(readUpdateJournal(fixture.home).coordinationSchemaVersion, 21);
  assert.equal(packageId(fixture.home), fixture.next.packageId);
  assert.equal(kept(fixture.home).version, 21);
});

test('a busy v21 database refuses a v20 candidate after owned writers stop', async t => {
  const fixture = homeFixture(t, { desiredRunning: true, version: 21 });
  let online = true, starts = 0;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    inspectUpdateInventory: async (...args) => {
      const inventory = await inspectUpdateInventory(...args);
      assert.equal(inventory.reasons.some(reason => reason.code === 'schema_assets_changed'), true);
      return { ...inventory, databaseInspection: { present: true, version: null, busy: true, compatible: false },
        reasons: [{ code: 'database_busy', message: 'database is locked' }] };
    },
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    quiesce: async () => { online = false; return []; },
    start: async () => { starts += 1; online = true; return { ok: true, status: 'ready' }; },
  });
  assert.equal(result.status, 'aborted');
  assert.equal(result.reasons[0].code, 'unsupported_data_version');
  assert.equal(result.runningRestored, true);
  assert.equal(starts, 1);
  assert.equal(online, true);
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.equal(kept(fixture.home).version, 21);
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(fixture.home), 'checkpoint')), false);
});

test('pre-switch restoration releases the real Host lock before Start', async t => {
  const fixture = homeFixture(t, { desiredRunning: true, version: 21 });
  let online = true, starts = 0;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, {
    inspectUpdateInventory: async (...args) => ({ ...(await inspectUpdateInventory(...args)),
      databaseInspection: { present: true, version: null, busy: true, compatible: false },
      reasons: [{ code: 'database_busy', message: 'database is locked' }] }),
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    quiesce: async () => { online = false; return []; },
    start: async () => {
      const lock = acquireHostLock(fixture.home);
      assert.ok(lock, 'the real Host Start lock must be available after update mutation');
      try { starts += 1; online = true; return { ok: true, status: 'ready' }; }
      finally { lock.release(); }
    },
  });
  assert.equal(result.status, 'aborted');
  assert.equal(result.runningRestored, true);
  assert.equal(starts, 1);
  assert.equal(online, true);
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.equal(kept(fixture.home).version, 21);
});

test('a failed pre-switch restoration stays fenced with a durable recovery result', async t => {
  const fixture = homeFixture(t, { desiredRunning: true, version: 21 });
  let online = true;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    inspectUpdateInventory: async (...args) => ({ ...(await inspectUpdateInventory(...args)),
      databaseInspection: { present: true, version: null, busy: true, compatible: false },
      reasons: [{ code: 'database_busy', message: 'database is locked' }] }),
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    quiesce: async () => { online = false; return []; },
    start: async () => ({ ok: false, status: 'failed' }),
  });
  assert.equal(result.status, 'recovery_required');
  assert.equal(result.runningRestored, false);
  assert.equal(result.reasons.some(reason => reason.code === 'running_restore_failed'), true);
  assert.equal(readUpdateJournal(fixture.home).phase, 'recovery_required');
  assert.equal(online, false);
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.equal(kept(fixture.home).version, 21);
  assert.equal(updateBlocksStart(readUpdateJournal(fixture.home)), true);
});

test('a database still busy after quiesce restores the previous running home', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  const databaseFile = path.join(fixture.home, 'app/instances/.house/coordination/home23-coordination.sqlite3');
  let online = true, lock, starts = 0;
  t.after(() => { if (lock?.isOpen) lock.close(); });
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    quiesce: async () => { online = false; return []; },
    afterPhase: async journal => {
      if (journal.phase === 'quiesced') {
        lock = new DatabaseSync(databaseFile);
        lock.exec('BEGIN EXCLUSIVE');
      }
    },
    start: async () => {
      starts += 1;
      lock.exec('ROLLBACK');
      lock.close();
      online = true;
      return { ok: true, status: 'ready' };
    },
  });
  assert.equal(result.status, 'aborted');
  assert.equal(result.reasons[0].code, 'database_busy');
  assert.equal(result.runningRestored, true);
  assert.equal(starts, 1);
  assert.equal(online, true);
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.equal(preserved(fixture.home).value, 'same-home');
});

test('an incomplete graceful stop is fenced without starting a second writer', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  let starts = 0;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    listProcesses: async () => [{ name: 'home23-milo', status: 'online' }],
    quiesce: async () => [{ name: 'home23-milo', status: 'online' }],
    start: async () => { starts += 1; return { ok: true, status: 'ready' }; },
  });
  assert.equal(result.status, 'recovery_required');
  assert.equal(result.reasons[0].code, 'writer_stop_incomplete');
  assert.equal(starts, 0);
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.equal(preserved(fixture.home).value, 'same-home');
});

test('checkpoint and resume fingerprint a read-only attachment without copying it', async t => {
  const fixture = homeFixture(t);
  const relative = 'app/instances/milo/conversations/readonly-attachment.txt';
  const original = path.join(fixture.home, relative);
  fs.writeFileSync(original, 'owner attachment\n');
  fs.chmodSync(original, 0o400);
  await assert.rejects(() => applyProductUpdate({ homeRoot: fixture.home,
    candidatePayload: fixture.candidate, staging: fixture.staging }, {
    ...quiet,
    afterPhase: async journal => {
      if (journal.phase === 'checkpointed') throw new Error('read-only-checkpoint-interrupt');
    },
  }), /read-only-checkpoint-interrupt/);
  assert.equal(readUpdateJournal(fixture.home).phase, 'checkpointed');
  const journal = readUpdateJournal(fixture.home);
  assert.equal(journal.stateRetention, 'in_place');
  assert.match(journal.identity[relative], /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(fixture.home), 'checkpoint/state')), false);
  assert.equal(journal.checkpointDatabase.present, true);
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(fixture.home), 'checkpoint/coordination.sqlite3')), true);
  const result = await resumeProductUpdate({ homeRoot: fixture.home }, quiet);
  assert.equal(result.status, 'committed');
  assert.equal(fs.readFileSync(original, 'utf8'), 'owner attachment\n');
  assert.equal(fs.statSync(original).mode & 0o777, 0o400);
});

test('checkpoint reads each quiesced state file once', async t => {
  const fixture = homeFixture(t);
  const target = path.join(fixture.home, 'app/instances/milo/conversations/session.txt');
  const originalOpen = fs.promises.open;
  let opens = 0;
  fs.promises.open = async (...args) => {
    if (args[0] === target) opens += 1;
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => applyProductUpdate({ homeRoot: fixture.home,
      candidatePayload: fixture.candidate, staging: fixture.staging }, {
      ...quiet,
      afterPhase: async journal => {
        if (journal.phase === 'checkpointed') throw new Error('stop-after-checkpoint');
      },
    }), /stop-after-checkpoint/);
    assert.equal(opens, 1);
    assert.equal(readUpdateJournal(fixture.home).phase, 'checkpointed');
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('checkpoint refuses a same-size write during its single fingerprint read', async t => {
  const fixture = homeFixture(t);
  const target = path.join(fixture.home, 'app/instances/milo/conversations/session.txt');
  const originalOpen = fs.promises.open;
  let changed = false;
  fs.promises.open = async (...args) => {
    const descriptor = await originalOpen(...args);
    if (args[0] === target) {
      const originalRead = descriptor.read.bind(descriptor);
      descriptor.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        if (!changed) {
          changed = true;
          fs.writeFileSync(target, 'changed123'); // same ten-byte length as hello-milo
        }
        return result;
      };
    }
    return descriptor;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => applyProductUpdate({ homeRoot: fixture.home,
      candidatePayload: fixture.candidate, staging: fixture.staging }, quiet), /Checkpoint file changed while hashing/);
    assert.equal(changed, true);
    assert.equal(readUpdateJournal(fixture.home).phase, 'quiesced');
    assert.equal(packageId(fixture.home), fixture.installed.packageId);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('unchanged state and database use checkpoint metadata through final acceptance', async t => {
  const fixture = homeFixture(t);
  const state = path.join(fixture.home, 'app/instances/milo/conversations/session.txt');
  const databaseFile = path.join(fixture.home, 'app/instances/.house/coordination/home23-coordination.sqlite3');
  const originalOpen = fs.promises.open;
  const opens = new Map([[state, 0], [databaseFile, 0]]);
  fs.promises.open = async (...args) => {
    if (opens.has(args[0])) opens.set(args[0], opens.get(args[0]) + 1);
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  try {
    const result = await applyProductUpdate({ homeRoot: fixture.home,
      candidatePayload: fixture.candidate, staging: fixture.staging }, quiet);
    assert.equal(result.status, 'committed');
    assert.equal(opens.get(state), 1);
    assert.equal(opens.get(databaseFile), 1);
    const journal = readUpdateJournal(fixture.home);
    assert.match(journal.identityMetadata['app/instances/milo/conversations/session.txt'].ctimeNs, /^\d+$/);
    assert.match(journal.identityMetadata['app/instances/.house/coordination/home23-coordination.sqlite3'].ino, /^\d+$/);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('a same-size state edit after checkpoint forces a fresh hash and refuses admission', async t => {
  const fixture = homeFixture(t);
  const state = path.join(fixture.home, 'app/instances/milo/conversations/session.txt');
  const result = await applyProductUpdate({ homeRoot: fixture.home,
    candidatePayload: fixture.candidate, staging: fixture.staging }, {
    ...quiet,
    afterPhase: async journal => {
      if (journal.phase === 'checkpointed') fs.writeFileSync(state, 'changed123');
    },
  });
  assert.equal(result.status, 'recovery_required');
  assert.equal(readUpdateJournal(fixture.home).identityPreserved, false);
  assert.equal(fs.readFileSync(state, 'utf8'), 'changed123');
});

test('an older checkpoint journal without metadata still hashes saved identity', async t => {
  const fixture = homeFixture(t);
  const state = path.join(fixture.home, 'app/instances/milo/conversations/session.txt');
  await assert.rejects(() => applyProductUpdate({ homeRoot: fixture.home,
    candidatePayload: fixture.candidate, staging: fixture.staging }, {
    ...quiet,
    afterPhase: async journal => {
      if (journal.phase === 'checkpointed') throw new Error('stop-after-checkpoint');
    },
  }), /stop-after-checkpoint/);
  const journalPath = path.join(updateDirectoryFor(fixture.home), 'journal.json');
  const legacyJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  delete legacyJournal.identityMetadata;
  fs.writeFileSync(journalPath, JSON.stringify(legacyJournal));
  const originalOpen = fs.promises.open;
  let opens = 0;
  fs.promises.open = async (...args) => {
    if (args[0] === state) opens += 1;
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  try {
    const result = await resumeProductUpdate({ homeRoot: fixture.home }, quiet);
    assert.equal(result.status, 'committed');
    assert.ok(opens >= 1);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('an interrupted old checkpoint resumes in place without touching partial copies', async t => {
  const fixture = homeFixture(t);
  const directory = path.join(fixture.home, 'app/instances/milo/conversations');
  for (const name of ['a-copy.txt', 'b-copy.txt', 'c-copy.txt', 'd-copy.txt', 'z-interrupt.txt']) {
    fs.writeFileSync(path.join(directory, name), name);
  }
  await assert.rejects(() => applyProductUpdate({ homeRoot: fixture.home,
    candidatePayload: fixture.candidate, staging: fixture.staging }, {
    ...quiet,
    checkpointBeforeCopy: async relative => {
      if (relative.endsWith('/z-interrupt.txt')) throw new Error('checkpoint-copy-interrupted');
    },
  }), /checkpoint-copy-interrupted/);
  assert.equal(readUpdateJournal(fixture.home).phase, 'quiesced');
  const checkpoint = path.join(updateDirectoryFor(fixture.home), 'checkpoint/state/app/instances/milo/conversations');
  fs.mkdirSync(checkpoint, { recursive: true });
  const partial = path.join(checkpoint, 'b-copy.txt');
  fs.writeFileSync(partial, 'old partial copy');
  const marker = path.join(updateDirectoryFor(fixture.home), 'checkpoint/owner.json');
  fs.writeFileSync(marker, JSON.stringify({ schema: 'home23.checkpoint-owner.v1', journalId: readUpdateJournal(fixture.home).id, homeRoot: fixture.home }));
  fs.writeFileSync(path.join(directory, 'a-copy.txt'), 'changed after partial checkpoint');
  const fingerprinted = [];
  const resumed = await resumeProductUpdate({ homeRoot: fixture.home }, {
    ...quiet, checkpointBeforeCopy: async relative => { fingerprinted.push(relative); },
  });
  assert.equal(resumed.status, 'committed');
  assert.ok(fingerprinted.some(relative => relative.endsWith('/a-copy.txt')));
  assert.ok(fingerprinted.some(relative => relative.endsWith('/z-interrupt.txt')));
  assert.equal(fs.readFileSync(partial, 'utf8'), 'old partial copy');
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).journalId, readUpdateJournal(fixture.home).id);
  assert.equal(fs.existsSync(path.join(checkpoint, 'a-copy.txt')), false);
  const journal = readUpdateJournal(fixture.home);
  assert.equal(journal.stateRetention, 'in_place');
});

test('checkpoint fingerprints a hardlinked source without changing either link', async t => {
  const fixture = homeFixture(t);
  const source = path.join(fixture.home, 'app/instances/milo/conversations/session.txt');
  fs.linkSync(source, path.join(fixture.root, 'other-link.txt'));
  const result = await applyProductUpdate({ homeRoot: fixture.home,
    candidatePayload: fixture.candidate, staging: fixture.staging }, quiet);
  assert.equal(result.status, 'committed');
  assert.equal(fs.statSync(source).nlink, 2);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'other-link.txt'), 'utf8'), 'hello-milo');
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(fixture.home), 'checkpoint/state')), false);
});

test('checkpoint stops admitting work after the first failed copy', async t => {
  const fixture = homeFixture(t);
  const directory = path.join(fixture.home, 'app/instances/milo/conversations');
  for (let index = 0; index < 8; index += 1) fs.writeFileSync(path.join(directory, `later-${index}.txt`), String(index));
  let entered = 0, release;
  const firstFour = new Promise(resolve => { release = resolve; });
  await assert.rejects(() => applyProductUpdate({ homeRoot: fixture.home,
    candidatePayload: fixture.candidate, staging: fixture.staging }, {
    ...quiet,
    checkpointBeforeCopy: async () => {
      entered += 1;
      const position = entered;
      if (entered === 4) release();
      await firstFour;
      if (position === 1) throw new Error('first-copy-failed');
      await new Promise(resolve => setTimeout(resolve, 20));
    },
  }), /first-copy-failed/);
  assert.equal(entered, 4);
  assert.equal(readUpdateJournal(fixture.home).phase, 'quiesced');
});

test('checkpoint file copies are bounded at four concurrent operations', async t => {
  const fixture = homeFixture(t);
  const directory = path.join(fixture.home, 'app/instances/milo/conversations');
  for (let index = 0; index < 8; index += 1) fs.writeFileSync(path.join(directory, `parallel-${index}.txt`), String(index));
  let active = 0, maximum = 0, release;
  const firstFour = new Promise(resolve => { release = resolve; });
  const result = await applyProductUpdate({ homeRoot: fixture.home,
    candidatePayload: fixture.candidate, staging: fixture.staging }, {
    ...quiet,
    checkpointBeforeCopy: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (active === 4) release();
      await firstFour;
      active -= 1;
    },
  });
  assert.equal(result.status, 'committed');
  assert.equal(maximum, 4);
});

test('mixed roots switch packaged software and retain operator siblings', async t => {
  const software = ['app/workspace/skills/index.js', 'app/configs/base-engine.yaml',
    'app/agency/charter.yaml', 'app/engine/config/image.json'];
  const currentExtra = Object.fromEntries(software.map(file => [file, 'version one\n']));
  const extra = Object.fromEntries(software.map(file => [file, 'version two\n']));
  const fixture = homeFixture(t, { currentExtra, extra });
  const operator = ['app/workspace/operator-note.md', 'app/configs/local.yaml',
    'app/agency/local.json', 'app/engine/config/local.json'];
  for (const file of operator) {
    fs.mkdirSync(path.dirname(path.join(fixture.home, file)), { recursive: true });
    fs.writeFileSync(path.join(fixture.home, file), 'kept operator state\n');
  }
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging }, quiet);
  assert.equal(result.status, 'committed');
  for (const file of software) assert.equal(fs.readFileSync(path.join(fixture.home, file), 'utf8'), 'version two\n');
  for (const file of operator) assert.equal(fs.readFileSync(path.join(fixture.home, file), 'utf8'), 'kept operator state\n');
});

test('an adopted external state link survives one software update by its exact receipt', async t => {
  const fixture = homeFixture(t);
  const external = path.join(fixture.root, 'retained-coding-state');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'work.txt'), 'authoritative\n');
  const relative = 'app/instances/milo/coding-state';
  fs.symlinkSync(external, path.join(fixture.home, relative));
  fs.mkdirSync(path.join(fixture.home, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(fixture.home, 'runtime/adoption-preservation.json'), JSON.stringify({
    schema: 'home23.adoption-preservation-receipt.v1', sourceRoot: path.join(fixture.root, 'source'),
    links: [{ path: relative, target: external, sourcePath: 'instances/milo/coding-state', sourceTarget: external, kind: 'retain-link' }],
    externalReferences: [], continuationServices: [],
  }), { mode: 0o600 });
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging }, quiet);
  assert.equal(result.status, 'committed', JSON.stringify(result.reasons));
  assert.equal(fs.readlinkSync(path.join(fixture.home, relative)), external);
  assert.equal(fs.readFileSync(path.join(external, 'work.txt'), 'utf8'), 'authoritative\n');
});

test('checkpoint fingerprints state under an approved retained source parent', async t => {
  const fixture = homeFixture(t);
  const external = path.join(fixture.root, 'retained-evobrew');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'config.json'), '{"kept":true}\n', { mode: 0o400 });
  const relative = 'app/evobrew';
  fs.symlinkSync(external, path.join(fixture.home, relative));
  fs.mkdirSync(path.join(fixture.home, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(fixture.home, 'runtime/adoption-preservation.json'), JSON.stringify({
    schema: 'home23.adoption-preservation-receipt.v1', sourceRoot: path.join(fixture.root, 'source'),
    links: [{ path: relative, target: external, sourcePath: 'app/evobrew', sourceTarget: external, kind: 'retain-authority' }],
    externalReferences: [], continuationServices: [],
  }), { mode: 0o600 });
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging }, quiet);
  assert.equal(result.status, 'committed', JSON.stringify(result.reasons));
  assert.equal(fs.readFileSync(path.join(external, 'config.json'), 'utf8'), '{"kept":true}\n');
  assert.equal(fs.statSync(path.join(external, 'config.json')).mode & 0o777, 0o400);
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(fixture.home), 'checkpoint/state')), false);
  assert.match(readUpdateJournal(fixture.home).identity['app/evobrew/config.json'], /^[a-f0-9]{64}$/);
});

test('continued services join the software update writer fence', async t => {
  const fixture = homeFixture(t);
  const file = path.join(fixture.home, '.home23-host.json');
  const host = JSON.parse(fs.readFileSync(file, 'utf8'));
  host.continuationServices = [{ name: 'home23-legacy-edge' }];
  fs.writeFileSync(file, JSON.stringify(host));
  fs.mkdirSync(path.join(fixture.home, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(fixture.home, 'runtime/adoption-preservation.json'), JSON.stringify({
    schema: 'home23.adoption-preservation-receipt.v1', sourceRoot: '/Users/jtr/retained-source',
    links: [], externalReferences: [], continuationServices: [{ name: 'home23-legacy-edge', run: { name: 'home23-legacy-edge' } }],
  }), { mode: 0o600 });
  const inventory = await inspectUpdateInventory(fixture.home, { installed: fixture.installed, candidate: fixture.next });
  assert.ok(inventory.writers.includes('home23-legacy-edge'));
  const deferred = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging }, { ...quiet, listProcesses: async () => [{ name: 'home23-legacy-edge', status: 'online' }] });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.admission, 'wait');
  assert.equal(fs.existsSync(updateDirectoryFor(fixture.home)), false);
});

test('a sealed external continuation binding does not block the next update inventory', async t => {
  const fixture = homeFixture(t);
  const service = { name: 'home23-coordination-edge', executable: '/opt/homebrew/bin/caddy',
    cwd: '/Users/jtr/external-caddy-state', args: ['run', '--config', '/Users/jtr/external-caddy-state/Caddyfile'],
    env: { HOME: '/Users/jtr' }, stateRoots: ['/Users/jtr/external-caddy-state'], startOnHomeStart: true };
  const hostPath = path.join(fixture.home, '.home23-host.json');
  const host = JSON.parse(fs.readFileSync(hostPath, 'utf8'));
  host.continuationServices = [service];
  fs.writeFileSync(hostPath, JSON.stringify(host), { mode: 0o600 });
  fs.mkdirSync(path.join(fixture.home, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(fixture.home, 'runtime/adoption-preservation.json'), JSON.stringify({
    schema: 'home23.adoption-preservation-receipt.v1', sourceRoot: '/Users/jtr/retained-source',
    links: [], externalReferences: [], continuationServices: [{ name: service.name, run: service }],
  }), { mode: 0o600 });
  const allowed = await inspectUpdateInventory(fixture.home, { installed: fixture.installed, candidate: fixture.next });
  assert.equal(allowed.reasons.some(item => item.code === 'external_reference' || item.code === 'continuation_receipt_mismatch'), false);
  host.continuationServices[0].cwd = '/Users/jtr/changed-caddy-state';
  fs.writeFileSync(hostPath, JSON.stringify(host));
  const changed = await inspectUpdateInventory(fixture.home, { installed: fixture.installed, candidate: fixture.next });
  assert.ok(changed.reasons.some(item => item.code === 'continuation_receipt_mismatch'));
});

test('failed candidate health restores previous software and leaves state in place', async t => {
  const fixture = homeFixture(t);
  const before = preserved(fixture.home);
  const failed = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging }, { ...quiet, verifyBehavior: async () => ({ ok: false, issues: ['health failed'] }) });
  assert.equal(failed.status, 'rolled_back');
  assert.equal(failed.ok, false);
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.equal(fs.existsSync(path.join(fixture.home, 'app/cli/lib/update-marker.txt')), false);
  assert.deepEqual(preserved(fixture.home), before);

  const broken = homeFixture(t);
  const state = preserved(broken.home);
  await assert.rejects(() => applyProductUpdate({ homeRoot: broken.home, candidatePayload: broken.candidate, staging: broken.staging }, {
    ...quiet,
    afterPhase: async journal => { if (journal.phase === 'accepted') throw new Error('stop-after-accepted'); },
  }), /stop-after-accepted/);
  assert.equal(packageId(broken.home), broken.next.packageId);
  const recovered = await resumeProductUpdate({ homeRoot: broken.home }, { ...quiet, verifyBehavior: async () => ({ ok: false, issues: ['later'] }) });
  assert.equal(recovered.status, 'recovery_required');
  assert.equal(recovered.recoveryRequired, true);
  assert.match(recovered.reasons[0].message, /not restored/);
  assert.equal(packageId(broken.home), broken.next.packageId);
  assert.deepEqual(preserved(broken.home), state);

  const tampered = homeFixture(t);
  const tamperedState = preserved(tampered.home);
  const rollback = await applyProductUpdate({ homeRoot: tampered.home, candidatePayload: tampered.candidate, staging: tampered.staging }, {
    ...quiet,
    afterPhase: async journal => {
      if (journal.phase === 'selected') fs.writeFileSync(path.join(updateDirectoryFor(tampered.home), 'previous/bin/node'), 'tampered');
    },
    verifyBehavior: async () => ({ ok: false, issues: ['health failed'] }),
  });
  assert.equal(rollback.status, 'recovery_required');
  assert.equal(fs.readFileSync(path.join(tampered.home, 'bin/node'), 'utf8').includes('tampered'), false);
  assert.deepEqual(preserved(tampered.home), tamperedState);
});

test('killing the controller before and after selection resumes without a second home', async t => {
  const retained = homeFixture(t);
  const before = preserved(retained.home);
  const killed = await run(process.execPath, ['scripts/product/host.mjs', 'update', '--home', retained.home, '--payload', retained.candidate, '--staging', retained.staging], { ...process.env, HOME23_UPDATE_INTERRUPT_AFTER: 'retained' });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(packageId(retained.home), retained.installed.packageId);
  const update = updateDirectoryFor(retained.home);
  const resumed = await run(path.join(update, 'controller/node'), [path.join(update, 'controller/lib/product-update-recover.mjs'), '--home', retained.home], { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: retained.root, TMPDIR: retained.root, LANG: 'en_US.UTF-8' });
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  const parsed = JSON.parse(resumed.stdout.trim());
  assert.equal(parsed.status, 'committed');
  assert.equal(parsed.resumedRunning, false);
  assert.equal(packageId(retained.home), retained.next.packageId);
  assert.deepEqual(preserved(retained.home), before);

  const selected = homeFixture(t, { desiredRunning: true, extra: { 'app/package.json': '{"type":"module"}\n', 'app/cli/lib/update-marker.txt': 'schema-preserving-apply\n', 'app/cli/lib/product-host.js': hostStub } });
  const selectedState = preserved(selected.home);
  const killedAfter = await run(process.execPath, ['scripts/product/host.mjs', 'update', '--home', selected.home, '--payload', selected.candidate, '--staging', selected.staging], { ...process.env, HOME23_UPDATE_INTERRUPT_AFTER: 'selected' });
  assert.equal(killedAfter.signal, 'SIGKILL', killedAfter.stderr);
  assert.equal(packageId(selected.home), selected.next.packageId);
  assert.equal(fs.existsSync(path.join(selected.home, 'runtime/started.txt')), false);
  const selectedUpdate = updateDirectoryFor(selected.home);
  const resumedAfter = await run(path.join(selectedUpdate, 'controller/node'), [path.join(selectedUpdate, 'controller/lib/product-update-recover.mjs'), '--home', selected.home], { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: selected.root, TMPDIR: selected.root, LANG: 'en_US.UTF-8' });
  assert.equal(resumedAfter.code, 0, resumedAfter.stderr + resumedAfter.stdout);
  assert.equal(JSON.parse(resumedAfter.stdout.trim()).status, 'committed');
  assert.equal(fs.readFileSync(path.join(selected.home, 'runtime/started.txt'), 'utf8'), 'start');
  assert.deepEqual(preserved(selected.home), selectedState);
});

test('real startup may rewrite lifecycle fields without losing canonical identity', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  const before = preserved(fixture.home);
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging, admit: true }, {
    ...quiet,
    start: async () => {
      const file = path.join(fixture.home, '.home23-host.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.phase = 'starting';
      state.startedAt = '2026-09-21T20:00:00.000Z';
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
      return { ok: true, status: 'ready' };
    },
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.identityPreserved, true);
  assert.equal(packageId(fixture.home), fixture.next.packageId);
  assert.equal(preserved(fixture.home).conversation, before.conversation);
  assert.equal(preserved(fixture.home).seed, before.seed);
  assert.equal(preserved(fixture.home).value, before.value);
  const host = JSON.parse(fs.readFileSync(path.join(fixture.home, '.home23-host.json'), 'utf8'));
  assert.equal(host.phase, 'starting');
  assert.equal(host.profile.name, 'milo');
  assert.equal(host.desiredRunning, true);
});

test('normal startup may change conversations, Work, settings, and credentials after admission', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  const conversations = path.join(fixture.home, 'app/instances/milo/conversations');
  const work = path.join(fixture.home, 'app/instances/milo/async-work');
  fs.writeFileSync(path.join(conversations, 'cron-jobs.json'), '[{"id":"before"}]\n');
  fs.mkdirSync(path.join(conversations, 'cron-scheduler.lock'), { recursive: true });
  fs.writeFileSync(path.join(conversations, 'cron-scheduler.lock/owner.json'), '{"ownerId":"old"}\n');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'aw_before.json'), '{"status":"queued"}\n');
  let fences = 0;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    start: async () => {
      fs.writeFileSync(path.join(conversations, 'cron-jobs.json'), '[{"id":"rescheduled"}]\n');
      fs.writeFileSync(path.join(conversations, 'cron-scheduler.lock/owner.json'), '{"ownerId":"new"}\n');
      fs.writeFileSync(path.join(conversations, 'session.txt'), 'new conversation');
      fs.writeFileSync(path.join(work, 'aw_before.json'), '{"status":"interrupted"}\n');
      fs.writeFileSync(path.join(fixture.home, 'app/config/home.yaml'), 'name: milo\nupdated: true\n');
      fs.writeFileSync(path.join(fixture.home, 'app/config/secrets.yaml'), 'providers: {rotated: true}\n');
      return { ok: true, status: 'ready', readiness: { ready: true } };
    },
    quiesce: async () => { fences += 1; return []; },
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.identityPreserved, true);
  assert.equal(fences, 0);
  assert.equal(fs.readFileSync(path.join(conversations, 'session.txt'), 'utf8'), 'new conversation');
});

test('immutable Seed birth receipt and saved Host profile still fail post-start identity verification', async t => {
  for (const damage of ['birth', 'profile']) {
    const fixture = homeFixture(t, { desiredRunning: true });
    const birth = path.join(fixture.home, 'app/instances/milo/substrate/seed-01/birth-receipt.json');
    fs.mkdirSync(path.dirname(birth), { recursive: true });
    fs.writeFileSync(birth, '{"seedId":"original"}\n');
    let fences = 0, online = false;
    const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
      staging: fixture.staging, admit: true }, { ...quiet,
      listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
      start: async () => {
        online = true;
        if (damage === 'birth') fs.writeFileSync(birth, '{"seedId":"different"}\n');
        else {
          const file = path.join(fixture.home, '.home23-host.json');
          const host = JSON.parse(fs.readFileSync(file, 'utf8'));
          host.profile = { ...host.profile, name: 'different' };
          fs.writeFileSync(file, JSON.stringify(host));
        }
        return { ok: true, status: 'ready', readiness: { ready: true } };
      },
      quiesce: async () => { fences += 1; online = false; return []; },
    });
    assert.equal(result.status, 'recovery_required', damage);
    assert.equal(result.identityPreserved, false, damage);
    assert.equal(fences, 1, damage);
  }
});

test('resident writes after startup keep seed lineage and do not restore software', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  const ledger = path.join(fixture.home, 'app/instances/milo/substrate/seed-01/seed-ledger.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, '{"seq":1}\n');
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging, admit: true }, {
    ...quiet,
    start: async () => {
      fs.appendFileSync(ledger, '{"seq":2}\n');
      fs.writeFileSync(path.join(fixture.home, 'app/instances/milo/brain/thoughts.jsonl'), 'live\n');
      return { ok: true, status: 'ready' };
    },
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.identityPreserved, true);
  assert.equal(fs.readFileSync(ledger, 'utf8'), '{"seq":1}\n{"seq":2}\n');
  const journal = readUpdateJournal(fixture.home);
  assert.equal(journal.stateRetention, 'in_place');
  assert.deepEqual(journal.substratePrefixes['app/instances/milo/substrate/seed-01/seed-ledger.jsonl'], {
    bytes: Buffer.byteLength('{"seq":1}\n'), sha256: journal.identity['app/instances/milo/substrate/seed-01/seed-ledger.jsonl'],
  });
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(fixture.home), 'checkpoint/state')), false);
  assert.equal(packageId(fixture.home), fixture.next.packageId);
});

test('a warming admitted candidate defers and later commits without restarting or fencing', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  let online = false, ready = false, starts = 0, fences = 0;
  const dependencies = {
    ...quiet,
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    start: async () => { starts += 1; online = true; return { ok: true, status: 'starting', readiness: { ready: false } }; },
    status: async () => ({ ok: true, status: 'recovery_required',
      processes: [{ name: 'home23-milo', status: 'online', owned: true }], readiness: { ready } }),
    quiesce: async () => { fences += 1; online = false; return []; },
    readinessWaitMs: 0,
  };
  const first = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, dependencies);
  assert.equal(first.status, 'deferred');
  assert.equal(first.reasons[0].code, 'candidate_starting');
  assert.equal(readUpdateJournal(fixture.home).phase, 'writers_admitted');
  assert.equal(readUpdateJournal(fixture.home).startStatus, 'starting');
  assert.equal(starts, 1);
  assert.equal(fences, 0);
  ready = true;
  const resumed = await resumeProductUpdate({ homeRoot: fixture.home }, dependencies);
  assert.equal(resumed.status, 'committed');
  assert.equal(readUpdateJournal(fixture.home).startOk, true);
  assert.equal(starts, 1);
  assert.equal(fences, 0);
});

test('a failed Host status probe defers healthy admitted writers without fencing', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  let online = false, fences = 0;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    start: async () => { online = true; return { ok: true, status: 'starting', readiness: { ready: false } }; },
    status: async () => ({ ok: false, status: 'recovery_required',
      error: { code: 'update_recovery_required' }, update: { phase: 'writers_admitted' } }),
    quiesce: async () => { fences += 1; online = false; return []; },
    readinessWaitMs: 0,
  });
  assert.equal(result.status, 'deferred');
  assert.equal(result.reasons[0].code, 'candidate_starting');
  assert.equal(readUpdateJournal(fixture.home).phase, 'writers_admitted');
  assert.equal(fences, 0);
});

test('transient readiness probe timeouts re-probe with bounded backoff and commit without deferring', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  let online = false, probes = 0, starts = 0, fences = 0;
  const slept = [];
  const timedOut = { ok: true, status: 'recovery_required', processes: [{ name: 'home23-milo', status: 'online', owned: true }],
    readiness: { ready: false, issues: ['Resident engine (milo) is not responding from this installation yet.'] } };
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    start: async () => { starts += 1; online = true; return { ok: true, status: 'starting', readiness: { ready: false } }; },
    status: async () => { probes += 1; return probes < 3 ? timedOut : { ...timedOut, readiness: { ready: true, issues: [] } }; },
    quiesce: async () => { fences += 1; online = false; return []; },
    sleep: async ms => { slept.push(ms); },
  });
  assert.equal(result.status, 'committed');
  assert.equal(probes, 3);
  assert.deepEqual(slept, [5000, 7500]);
  assert.equal(starts, 1);
  assert.equal(fences, 0);
  assert.equal(readUpdateJournal(fixture.home).startOk, true);
});

test('a candidate that never reads ready defers only at the readiness deadline and resumes without intervention', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  let online = false, probes = 0, fences = 0, ready = false, clock = 0;
  const slept = [];
  const dependencies = { ...quiet,
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    start: async () => { online = true; return { ok: true, status: 'starting', readiness: { ready: false } }; },
    status: async () => { probes += 1; return { ok: true, status: 'recovery_required',
      processes: [{ name: 'home23-milo', status: 'online', owned: true }],
      readiness: { ready, issues: ready ? [] : ['Resident engine (milo) is not responding from this installation yet.'] } }; },
    quiesce: async () => { fences += 1; online = false; return []; },
    clock: () => clock, sleep: async ms => { slept.push(ms); clock += ms; }, readinessWaitMs: 30000,
  };
  const first = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, dependencies);
  assert.equal(first.status, 'deferred');
  assert.equal(first.reasons[0].code, 'candidate_starting');
  assert.equal(probes, 5);
  assert.deepEqual(slept, [5000, 7500, 10000, 7500]);
  assert.equal(fences, 0);
  assert.equal(readUpdateJournal(fixture.home).phase, 'writers_admitted');
  ready = true;
  const resumed = await resumeProductUpdate({ homeRoot: fixture.home }, dependencies);
  assert.equal(resumed.status, 'committed');
  assert.equal(probes, 6);
  assert.equal(fences, 0);
  assert.equal(readUpdateJournal(fixture.home).startOk, true);
});

test('a hard readiness failure classifies the candidate as failed on the first probe', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  let failed = false, probes = 0, fences = 0;
  const slept = [];
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    listProcesses: async () => failed ? [{ name: 'home23-milo', status: 'errored' }] : [],
    start: async () => { failed = true; return { ok: true, status: 'starting', readiness: { ready: false } }; },
    status: async () => { probes += 1; return { ok: true, status: 'degraded',
      processes: [{ name: 'home23-milo', status: 'errored', owned: true }],
      readiness: { ready: false, issues: ['Resident engine (milo) is not responding from this installation yet.'] } }; },
    quiesce: async () => { fences += 1; failed = false; return []; },
    sleep: async ms => { slept.push(ms); },
  });
  assert.equal(result.status, 'recovery_required');
  assert.equal(probes, 1);
  assert.deepEqual(slept, []);
  assert.equal(fences, 1);
});

test('initial Start readiness wins over a still-starting status label', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  let online = false;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    start: async () => { online = true; return { ok: true, status: 'starting', readiness: { ready: true } }; },
    status: async () => { throw new Error('status should not be needed'); },
  });
  assert.equal(result.status, 'committed');
  assert.equal(readUpdateJournal(fixture.home).startOk, true);
});

test('a failed admitted process still fences the candidate', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  let failed = false, fences = 0;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    listProcesses: async () => failed ? [{ name: 'home23-milo', status: 'errored' }] : [],
    start: async () => { failed = true; return { ok: false, status: 'degraded', error: { code: 'host_process_failed' } }; },
    status: async () => ({ ok: true, status: 'degraded',
      processes: [{ name: 'home23-milo', status: 'errored', owned: true }], readiness: { ready: false } }),
    quiesce: async () => { fences += 1; failed = false; return []; },
  });
  assert.equal(result.status, 'recovery_required');
  assert.equal(fences, 1);
  assert.equal(readUpdateJournal(fixture.home).startErrorCode, 'host_process_failed');
});

test('an explicitly missing owned process is not treated as slow startup', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  let online = false, fences = 0;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    start: async () => { online = true; return { ok: true, status: 'starting', readiness: { ready: false } }; },
    status: async () => ({ ok: true, status: 'recovery_required',
      processes: [{ name: 'home23-milo', status: 'online', owned: true }],
      readiness: { ready: false, issues: ['home23-milo-seed is not running from this installation.'] } }),
    quiesce: async () => { fences += 1; online = false; return []; },
  });
  assert.equal(result.status, 'recovery_required');
  assert.equal(fences, 1);
});

test('legacy copied checkpoint journal verifies its substrate prefix after resume', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  const relative = 'app/instances/milo/substrate/seed-01/seed-ledger.jsonl';
  const ledger = path.join(fixture.home, relative);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, '{"seq":1}\n');
  await assert.rejects(() => applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
    staging: fixture.staging, admit: true }, { ...quiet,
    afterPhase: async journal => { if (journal.phase === 'checkpointed') throw new Error('legacy-checkpoint-interrupt'); },
  }), /legacy-checkpoint-interrupt/);
  const update = updateDirectoryFor(fixture.home);
  const previous = path.join(update, 'checkpoint/state', relative);
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  fs.copyFileSync(ledger, previous);
  const journalPath = path.join(update, 'journal.json');
  const legacy = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  delete legacy.stateRetention;
  delete legacy.substratePrefixes;
  fs.writeFileSync(journalPath, `${JSON.stringify(legacy)}\n`);
  const result = await resumeProductUpdate({ homeRoot: fixture.home }, { ...quiet,
    start: async () => { fs.appendFileSync(ledger, '{"seq":2}\n'); return { ok: true }; },
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.identityPreserved, true);
  assert.equal(fs.readFileSync(ledger, 'utf8'), '{"seq":1}\n{"seq":2}\n');
});

test('substrate prefix edits and truncation fail post-start identity verification', async t => {
  for (const changed of ['{"seq":9}\n{"seq":2}\n', '{"seq":']) {
    const fixture = homeFixture(t, { desiredRunning: true });
    const ledger = path.join(fixture.home, 'app/instances/milo/substrate/seed-01/seed-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, '{"seq":1}\n');
    const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate,
      staging: fixture.staging, admit: true }, { ...quiet,
      start: async () => { fs.writeFileSync(ledger, changed); return { ok: true }; },
    });
    assert.equal(result.status, 'recovery_required');
    assert.equal(result.identityPreserved, false);
    assert.equal(fs.readFileSync(ledger, 'utf8'), changed);
  }
});

test('a failed check after candidate startup fences writers and does not restore software', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  const before = preserved(fixture.home);
  let online = false, fenced = 0;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging, admit: true }, {
    ...quiet,
    listProcesses: async () => online ? [{ name: 'home23-milo', status: 'online' }] : [],
    start: async () => { online = true; return { ok: true, status: 'ready' }; },
    quiesce: async () => { fenced += 1; online = false; return []; },
    verifyBehavior: async () => ({ ok: false, issues: ['candidate unhealthy after start'] }),
  });
  assert.equal(result.status, 'recovery_required');
  assert.equal(result.recoveryRequired, true);
  assert.equal(fenced, 1);
  assert.equal(packageId(fixture.home), fixture.next.packageId);
  assert.deepEqual(preserved(fixture.home), before);
  assert.match(result.reasons[0].message, /not restored/);
});

test('fenced rollback of a running home restores previous software and starts it', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  const before = preserved(fixture.home);
  let started = 0;
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging, admit: true }, {
    ...quiet,
    afterPhase: async journal => {
      if (journal.phase === 'selected') fs.writeFileSync(path.join(fixture.home, 'bin/node'), '#!/bin/sh\nbroken\n');
    },
    start: async () => { started += 1; return { ok: true, status: 'ready' }; },
  });
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.runningRestored, true);
  assert.equal(started, 1);
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.deepEqual(preserved(fixture.home), before);
});

test('a forced health failure in the real controller restores the previous package', async t => {
  const fixture = homeFixture(t);
  const before = preserved(fixture.home);
  const previous = process.env.HOME23_UPDATE_VERIFY_RESULT;
  process.env.HOME23_UPDATE_VERIFY_RESULT = 'fail';
  try {
    const failed = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging }, quiet);
    assert.equal(failed.status, 'rolled_back');
    assert.equal(packageId(fixture.home), fixture.installed.packageId);
    assert.deepEqual(preserved(fixture.home), before);
  } finally {
    if (previous === undefined) delete process.env.HOME23_UPDATE_VERIFY_RESULT;
    else process.env.HOME23_UPDATE_VERIFY_RESULT = previous;
  }
});

test('unchanged trees reuse payload verification and tampering still fails', async t => {
  const { verifyProductPayload: realVerify } = await import('../../cli/lib/product-payload.js');
  const countVerify = counter => (payloadPath, options) => {
    counter.value += 1;
    return realVerify(payloadPath, options);
  };

  const uncached = homeFixture(t);
  const uncachedCalls = { value: 0 };
  const uncachedResult = await applyProductUpdate(
    { homeRoot: uncached.home, candidatePayload: uncached.candidate, staging: uncached.staging },
    { ...quiet, reusePayloadVerify: false, verifyProductPayload: countVerify(uncachedCalls) },
  );
  assert.equal(uncachedResult.status, 'committed');
  assert.equal(packageId(uncached.home), uncached.next.packageId);

  const cached = homeFixture(t);
  const cachedCalls = { value: 0 };
  const cachedResult = await applyProductUpdate(
    { homeRoot: cached.home, candidatePayload: cached.candidate, staging: cached.staging },
    { ...quiet, verifyProductPayload: countVerify(cachedCalls) },
  );
  assert.equal(cachedResult.status, 'committed');
  assert.equal(packageId(cached.home), cached.next.packageId);
  assert.ok(
    cachedCalls.value < uncachedCalls.value,
    `expected fewer verifies with reuse (${cachedCalls.value} < ${uncachedCalls.value})`,
  );

  const tampered = homeFixture(t);
  await assert.rejects(
    () => applyProductUpdate(
      { homeRoot: tampered.home, candidatePayload: tampered.candidate, staging: tampered.staging },
      {
        ...quiet,
        afterPhase: async journal => {
          if (journal.phase === 'claimed') {
            fs.appendFileSync(path.join(journal.stagedPayload, 'bin/node'), '#tampered\n');
          }
        },
      },
    ),
    /Product file changed|Staged package|Selected package does not match/,
  );
  assert.equal(packageId(tampered.home), tampered.installed.packageId);
  assert.equal(preserved(tampered.home).conversation, 'hello-milo');
});

test('retained unchanged files stay independent after live overwrite and chmod', async t => {
  const fixture = homeFixture(t);
  const relative = 'bin/node';
  const beforeBytes = fs.readFileSync(path.join(fixture.home, relative));
  const beforeMode = fs.lstatSync(path.join(fixture.home, relative)).mode & 0o777;
  assert.equal(beforeBytes.equals(fs.readFileSync(path.join(fixture.candidate, relative))), true);
  const result = await applyProductUpdate(
    { homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging },
    quiet,
  );
  assert.equal(result.status, 'committed');
  const previousFile = path.join(updateDirectoryFor(fixture.home), 'previous', relative);
  const liveFile = path.join(fixture.home, relative);
  assert.equal(fs.lstatSync(previousFile).isFile(), true);
  assert.notEqual(fs.lstatSync(previousFile).ino, fs.lstatSync(liveFile).ino);
  assert.deepEqual(fs.readFileSync(previousFile), beforeBytes);
  assert.equal(fs.lstatSync(previousFile).mode & 0o777, beforeMode);
  fs.writeFileSync(liveFile, 'live-overwrite-after-update\n', { mode: 0o600 });
  fs.chmodSync(liveFile, 0o600);
  assert.deepEqual(fs.readFileSync(previousFile), beforeBytes);
  assert.equal(fs.lstatSync(previousFile).mode & 0o777, beforeMode);
  assert.equal(fs.readFileSync(liveFile, 'utf8'), 'live-overwrite-after-update\n');
});

test('interrupted retention resumes by rebuilding previous without a second home', async t => {
  const fixture = homeFixture(t);
  const before = preserved(fixture.home);
  let attempts = 0;
  await assert.rejects(
    () => applyProductUpdate(
      { homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging },
      {
        ...quiet,
        retainPrevious(home, updateDirectory) {
          attempts += 1;
          const previous = path.join(updateDirectory, 'previous');
          fs.rmSync(previous, { recursive: true, force: true });
          fs.mkdirSync(previous, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(previous, 'incomplete'), 'partial-retention\n');
          throw new Error('injected retention interrupt');
        },
      },
    ),
    /injected retention interrupt/,
  );
  assert.equal(attempts, 1);
  assert.equal(readUpdateJournal(fixture.home).phase, 'checkpointed');
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(fixture.home), 'previous', 'incomplete')), true);
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  const resumed = await resumeProductUpdate({ homeRoot: fixture.home }, quiet);
  assert.equal(resumed.status, 'committed');
  assert.equal(packageId(fixture.home), fixture.next.packageId);
  assert.deepEqual(preserved(fixture.home), before);
  const previous = path.join(updateDirectoryFor(fixture.home), 'previous');
  assert.equal(fs.existsSync(path.join(previous, 'incomplete')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(previous, 'manifest.json'), 'utf8')).packageId, fixture.installed.packageId);
  assert.equal(fs.readFileSync(path.join(previous, 'bin/node'), 'utf8'), fs.readFileSync(path.join(fixture.current, 'bin/node'), 'utf8'));
  assert.equal(fs.readdirSync(fixture.root).filter(name => name === 'home').length, 1);
});

function bulkFixture(t, count) {
  // Many unchanged files inside one software unit, as in app/node_modules.
  const bulk = Object.fromEntries(Array.from({ length: count }, (_, index) => [`app/node_modules/pkg-${index % 7}/file-${index}.js`, `export const value = ${index};\n`]));
  const root = tempRoot(t);
  const current = path.join(root, 'current'), candidate = path.join(root, 'candidate'), home = path.join(root, 'home'), staging = path.join(root, 'staging');
  const installed = payload(current, { sourceCommit: 'a'.repeat(40), extra: bulk });
  const next = payload(candidate, { sourceCommit: 'b'.repeat(40), extra: { ...bulk, 'app/cli/lib/update-marker.txt': 'schema-preserving-apply\n' } });
  installProductPayload({ payloadPath: current, homeRoot: home });
  populate(home);
  return { root, current, candidate, home, staging, installed, next };
}
async function countedUpdate(fixture, dependencies = quiet) {
  // Staging (download) copies the candidate once beforehand; count only the install.
  stageProductPayload({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging });
  const counts = { copyFileSync: 0, fsyncSync: 0, renameSync: 0 };
  const originals = Object.fromEntries(Object.keys(counts).map(name => [name, fs[name]]));
  for (const name of Object.keys(counts)) fs[name] = (...args) => { counts[name] += 1; return originals[name](...args); };
  syncBuiltinESMExports();
  try {
    const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: path.join(fixture.staging, 'payload'), staging: fixture.staging, reuseVerifiedStage: true }, dependencies);
    return { result, counts };
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}
function sameBytesAndModes(root, manifest) {
  for (const entry of manifest.files.filter(item => item.type === 'file' && softwareUnits({ files: [item] }).length)) {
    const file = path.join(root, entry.path);
    assert.equal(fs.lstatSync(file).mode & 0o777, entry.mode, entry.path);
    assert.equal(fs.readFileSync(file).length, entry.size, entry.path);
  }
}

test('the version switch moves whole software units, so its work does not grow with file count', async t => {
  const small = bulkFixture(t, 20), large = bulkFixture(t, 400);
  const smallRun = await countedUpdate(small), largeRun = await countedUpdate(large);
  assert.equal(smallRun.result.status, 'committed');
  assert.equal(largeRun.result.status, 'committed');
  // Twenty times the unchanged files, the same copies, fsyncs and renames.
  assert.deepEqual(largeRun.counts, smallRun.counts);
  assert.ok(largeRun.counts.copyFileSync < 40, JSON.stringify(largeRun.counts));
  assert.equal(packageId(large.home), large.next.packageId);
  const previous = path.join(updateDirectoryFor(large.home), 'previous');
  sameBytesAndModes(large.home, large.next);
  sameBytesAndModes(previous, large.installed);
  // The retained version is its own tree: other inodes, unaffected by live writes.
  const live = path.join(large.home, 'app/node_modules/pkg-3/file-3.js'), kept = path.join(previous, 'app/node_modules/pkg-3/file-3.js');
  assert.notEqual(fs.lstatSync(live).ino, fs.lstatSync(kept).ino);
  fs.writeFileSync(live, 'changed after update\n');
  assert.equal(fs.readFileSync(kept, 'utf8'), 'export const value = 3;\n');
  assert.equal(preserved(large.home).conversation, 'hello-milo');
});

test('a later update sets the earlier previous version aside whole and releases it after commit', async t => {
  const fixture = homeFixture(t);
  assert.equal((await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging }, quiet)).status, 'committed');
  const third = path.join(fixture.root, 'third');
  const final = payload(third, { sourceCommit: 'c'.repeat(40), extra: { 'app/cli/lib/update-marker.txt': 'third\n' } });
  const released = [];
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: third, staging: path.join(fixture.root, 'staging-third') }, { ...quiet, removeDiscarded: paths => released.push(...paths) });
  assert.equal(result.status, 'committed');
  assert.equal(packageId(fixture.home), final.packageId);
  const update = updateDirectoryFor(fixture.home);
  assert.equal(JSON.parse(fs.readFileSync(path.join(update, 'previous/manifest.json'), 'utf8')).packageId, fixture.next.packageId);
  assert.equal(fs.readFileSync(path.join(update, 'previous/app/cli/lib/update-marker.txt'), 'utf8'), 'schema-preserving-apply\n');
  assert.equal(released.length, 1);
  assert.match(path.basename(released[0]), /^discarded-previous-/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(released[0], 'manifest.json'), 'utf8')).packageId, fixture.installed.packageId);
});

async function interruptAt(fixture, phase, extra = {}) {
  await assert.rejects(
    () => applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging }, {
      ...quiet, ...extra,
      afterPhase: async journal => { if (journal.phase === phase) throw new Error(`stop-at-${phase}`); },
    }),
    new RegExp(`stop-at-${phase}`),
  );
  assert.equal(readUpdateJournal(fixture.home).phase, phase);
}

test('an interrupted switch resumes from partial move-out and partial move-in', async t => {
  for (const moveIn of [false, true]) {
    const fixture = homeFixture(t);
    const before = preserved(fixture.home);
    await interruptAt(fixture, 'applying');
    const staged = readUpdateJournal(fixture.home).stagedPayload;
    const previous = path.join(updateDirectoryFor(fixture.home), 'previous');
    const units = softwareUnits(fixture.installed);
    // A crash after some renames: move-out partly done, or complete with move-in begun.
    for (const unit of moveIn ? units : units.slice(0, 2)) fs.renameSync(path.join(fixture.home, unit), path.join(previous, unit));
    if (moveIn) fs.renameSync(path.join(staged, units[0]), path.join(fixture.home, units[0]));
    const resumed = await resumeProductUpdate({ homeRoot: fixture.home }, quiet);
    assert.equal(resumed.status, 'committed', JSON.stringify(resumed));
    assert.equal(packageId(fixture.home), fixture.next.packageId);
    assert.deepEqual(preserved(fixture.home), before);
    for (const entry of fixture.installed.files.filter(item => item.type === 'file' && softwareUnits({ files: [item] }).length)) {
      assert.deepEqual(fs.readFileSync(path.join(previous, entry.path)), fs.readFileSync(path.join(fixture.current, entry.path)), entry.path);
    }
  }
});

test('a controller killed as the switch begins resumes through the recovery entry', async t => {
  const fixture = homeFixture(t);
  const before = preserved(fixture.home);
  const killed = await run(process.execPath, ['scripts/product/host.mjs', 'update', '--home', fixture.home, '--payload', fixture.candidate, '--staging', fixture.staging], { ...process.env, HOME23_UPDATE_INTERRUPT_AFTER: 'applying' });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(readUpdateJournal(fixture.home).phase, 'applying');
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  const resumed = await run(process.execPath, ['cli/lib/product-update-recover.mjs', '--home', fixture.home], { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: fixture.root, TMPDIR: fixture.root, LANG: 'en_US.UTF-8' });
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout.trim()).status, 'committed');
  assert.equal(packageId(fixture.home), fixture.next.packageId);
  assert.deepEqual(preserved(fixture.home), before);
});

test('an interrupted rollback resumes and restores the previous version', async t => {
  const fixture = homeFixture(t, { extra: { 'app/cli/lib/update-marker.txt': 'schema-preserving-apply\n', 'app/extra-tool/run.js': 'added\n' } });
  const before = preserved(fixture.home);
  await interruptAt(fixture, 'selected');
  const journal = readUpdateJournal(fixture.home);
  const update = updateDirectoryFor(fixture.home), previous = path.join(update, 'previous'), aside = path.join(update, `discarded-candidate-${journal.id}`);
  // A crash mid-restore: one unit already back, one candidate unit set aside.
  fs.mkdirSync(aside, { recursive: true });
  fs.renameSync(path.join(fixture.home, 'bin'), path.join(aside, 'bin'));
  fs.renameSync(path.join(previous, 'bin'), path.join(fixture.home, 'bin'));
  fs.mkdirSync(path.join(aside, 'app'), { recursive: true });
  fs.renameSync(path.join(fixture.home, 'app/extra-tool'), path.join(aside, 'app/extra-tool'));
  const released = [];
  const resumed = await resumeProductUpdate({ homeRoot: fixture.home }, { ...quiet, removeDiscarded: paths => released.push(...paths) });
  assert.equal(resumed.status, 'rolled_back', JSON.stringify(resumed));
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.equal(fs.existsSync(path.join(fixture.home, 'app/extra-tool')), false);
  assert.equal(fs.existsSync(path.join(fixture.home, 'app/cli/lib/update-marker.txt')), false);
  assert.deepEqual(preserved(fixture.home), before);
  assert.deepEqual(released, [aside]);
});

const SKILL = 'app/workspace/skills/x-research';
function skillFixture(t) {
  // A packaged skill keeps its runtime cache beside its code, inside the
  // app/workspace/skills software unit that the switch moves whole.
  const fixture = homeFixture(t, { currentExtra: { [`${SKILL}/index.js`]: 'version one\n' },
    extra: { [`${SKILL}/index.js`]: 'version two\n', 'app/cli/lib/update-marker.txt': 'schema-preserving-apply\n' } });
  const data = path.join(fixture.home, SKILL, 'data');
  fs.mkdirSync(path.join(data, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(data, 'cache/37cd32e1dc4e.json'), '{"cached":true}\n');
  fs.writeFileSync(path.join(data, 'index.json'), '{"entries":1}\n');
  return { ...fixture, data };
}
function skillState(home) {
  return { cache: fs.readFileSync(path.join(home, SKILL, 'data/cache/37cd32e1dc4e.json'), 'utf8'),
    index: fs.readFileSync(path.join(home, SKILL, 'data/index.json'), 'utf8'), code: fs.readFileSync(path.join(home, SKILL, 'index.js'), 'utf8') };
}

test('state nested inside a software unit stays in the home when that unit switches', async t => {
  const fixture = skillFixture(t);
  const before = preserved(fixture.home);
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging }, quiet);
  assert.equal(result.status, 'committed', JSON.stringify(result.reasons));
  assert.equal(packageId(fixture.home), fixture.next.packageId);
  assert.deepEqual(skillState(fixture.home), { cache: '{"cached":true}\n', index: '{"entries":1}\n', code: 'version two\n' });
  assert.deepEqual(preserved(fixture.home), before);
  const update = updateDirectoryFor(fixture.home);
  assert.equal(fs.existsSync(path.join(update, 'previous', SKILL, 'data')), false);
  assert.equal(fs.readFileSync(path.join(update, 'previous', SKILL, 'index.js'), 'utf8'), 'version one\n');
  assert.equal(fs.existsSync(path.join(update, 'nested-state')), false);
  assert.deepEqual(readUpdateJournal(fixture.home).nestedState, [`${SKILL}/data`]);
});

test('an interrupted switch resumes with set-aside nested state back inside the new unit', async t => {
  for (const shape of ['aside', 'aside-moved', 'carried']) {
    const fixture = skillFixture(t);
    const before = preserved(fixture.home);
    await interruptAt(fixture, 'applying');
    const journal = readUpdateJournal(fixture.home);
    assert.deepEqual(journal.nestedState, [`${SKILL}/data`], shape);
    const update = updateDirectoryFor(fixture.home), previous = path.join(update, 'previous'), aside = path.join(update, 'nested-state');
    const units = softwareUnits(fixture.installed);
    if (shape !== 'carried') {
      // The crash came after the state was set aside...
      fs.mkdirSync(path.join(aside, SKILL), { recursive: true });
      fs.renameSync(fixture.data, path.join(aside, SKILL, 'data'));
    }
    if (shape === 'aside-moved') {
      // ...and after every unit moved out and one moved in.
      for (const unit of units) fs.renameSync(path.join(fixture.home, unit), path.join(previous, unit));
      fs.renameSync(path.join(journal.stagedPayload, units[0]), path.join(fixture.home, units[0]));
    }
    if (shape === 'carried') {
      // An earlier controller moved the unit whole, with the state still inside.
      fs.renameSync(path.join(fixture.home, 'app/workspace/skills'), path.join(previous, 'app/workspace/skills'));
    }
    const resumed = await resumeProductUpdate({ homeRoot: fixture.home }, quiet);
    assert.equal(resumed.status, 'committed', `${shape}: ${JSON.stringify(resumed)}`);
    assert.equal(packageId(fixture.home), fixture.next.packageId, shape);
    assert.deepEqual(skillState(fixture.home), { cache: '{"cached":true}\n', index: '{"entries":1}\n', code: 'version two\n' }, shape);
    assert.deepEqual(preserved(fixture.home), before, shape);
    assert.equal(fs.existsSync(path.join(previous, SKILL, 'data')), false, shape);
    assert.equal(fs.existsSync(aside), false, shape);
  }
});

test('a rolled-back candidate returns nested state to the previous unit instead of discarding it', async t => {
  const fixture = skillFixture(t);
  const before = preserved(fixture.home);
  const released = [];
  const result = await applyProductUpdate({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging },
    { ...quiet, verifyBehavior: async () => ({ ok: false, issues: ['health failed'] }), removeDiscarded: paths => released.push(...paths) });
  assert.equal(result.status, 'rolled_back', JSON.stringify(result.reasons));
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.deepEqual(skillState(fixture.home), { cache: '{"cached":true}\n', index: '{"entries":1}\n', code: 'version one\n' });
  assert.deepEqual(preserved(fixture.home), before);
  assert.equal(released.length, 1);
  assert.equal(fs.existsSync(path.join(released[0], SKILL, 'data')), false);
  assert.equal(fs.readFileSync(path.join(released[0], SKILL, 'index.js'), 'utf8'), 'version two\n');
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(fixture.home), 'nested-state')), false);
});

test('an update journal from the earlier copy updater is not switched by this one', async t => {
  const fixture = homeFixture(t);
  await interruptAt(fixture, 'retained');
  const file = path.join(updateDirectoryFor(fixture.home), 'journal.json');
  const { retention, ...older } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(retention, 'switch');
  fs.writeFileSync(file, JSON.stringify(older), { mode: 0o600 });
  await assert.rejects(() => resumeProductUpdate({ homeRoot: fixture.home }, quiet), /earlier updater/);
  assert.equal(readUpdateJournal(fixture.home).phase, 'retained');
  assert.equal(packageId(fixture.home), fixture.installed.packageId);
  assert.equal(fs.existsSync(path.join(updateDirectoryFor(fixture.home), 'previous/bin')), false);
});

test('reuseVerifiedStage applies without a second payload copy into staging', async t => {
  const fixture = homeFixture(t);
  const staging = fixture.staging;
  stageProductPayload({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging });
  const { verifyProductPayload: realVerify } = await import('../../cli/lib/product-payload.js');
  let fullChecksDuringInstall = 0;
  const payloadFiles = JSON.parse(fs.readFileSync(path.join(staging, 'payload/manifest.json'), 'utf8'))
    .files.filter(entry => entry.type === 'file').length;
  let copiesIntoStaging = 0;
  const original = fs.copyFileSync;
  fs.copyFileSync = (source, destination, flags) => {
    const dest = String(destination);
    if (dest === staging || dest.startsWith(staging + path.sep)) copiesIntoStaging += 1;
    return original(source, destination, flags);
  };
  try {
    const result = await applyProductUpdate({
      homeRoot: fixture.home,
      candidatePayload: path.join(staging, 'payload'),
      staging,
      reuseVerifiedStage: true,
    }, { ...quiet, verifyProductPayload(payloadPath, options) {
      fullChecksDuringInstall += 1;
      return realVerify(payloadPath, options);
    } });
    assert.equal(result.status, 'committed');
    assert.equal(packageId(fixture.home), fixture.next.packageId);
    assert.equal(copiesIntoStaging, 0);
    assert.equal(fullChecksDuringInstall, 1, 'Install checks the selected tree once before writer admission');
    assert.equal(readUpdateJournal(fixture.home).reuseVerifiedStage, true);
    assert.equal(readUpdateJournal(fixture.home).stagedPayload, path.join(staging, 'payload'));
    assert.equal(fs.existsSync(`${staging}-apply`), false);
  } finally {
    fs.copyFileSync = original;
  }
  assert.ok(payloadFiles > 0);
});

test('reuseVerifiedStage refuses wrong home baseline candidate tampering and concurrent ownership', async t => {
  const fixture = homeFixture(t);
  const staging = fixture.staging;
  stageProductPayload({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging });

  const other = homeFixture(t);
  assert.throws(
    () => adoptVerifiedStage({ homeRoot: other.home, staging }),
    /claim|eligible|baseline/,
  );

  const claimPath = `${staging}.home23-stage.json`;
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  fs.writeFileSync(claimPath, JSON.stringify({ ...claim, currentPackageId: '0'.repeat(64) }));
  assert.throws(() => adoptVerifiedStage({ homeRoot: fixture.home, staging }), /claim/);
  fs.writeFileSync(claimPath, JSON.stringify(claim));

  fs.writeFileSync(claimPath, JSON.stringify({ ...claim, candidatePackageId: '1'.repeat(64) }));
  assert.throws(() => adoptVerifiedStage({ homeRoot: fixture.home, staging }), /claim/);
  fs.writeFileSync(claimPath, JSON.stringify(claim));

  fs.appendFileSync(path.join(staging, 'payload/bin/node'), '#tampered\n');
  assert.throws(() => adoptVerifiedStage({ homeRoot: fixture.home, staging }), /changed|integrity|Product file/);
  // Restore bytes from the original candidate so later checks stay meaningful.
  fs.copyFileSync(path.join(fixture.candidate, 'bin/node'), path.join(staging, 'payload/bin/node'));
  fs.chmodSync(path.join(staging, 'payload/bin/node'), 0o755);

  const release = acquireInstallLock(stageLockPath(staging));
  try {
    await assert.rejects(
      () => applyProductUpdate({
        homeRoot: fixture.home,
        candidatePayload: path.join(staging, 'payload'),
        staging,
        reuseVerifiedStage: true,
      }, quiet),
      /already in progress/,
    );
  } finally {
    release();
  }
});

test('staged Install repairs old software but still refuses unknown and linked home state', async t => {
  const fixture = homeFixture(t);
  stageProductPayload({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging: fixture.staging });
  const install = () => applyProductUpdate({
    homeRoot: fixture.home,
    candidatePayload: path.join(fixture.staging, 'payload'),
    staging: fixture.staging,
    reuseVerifiedStage: true,
  }, quiet);
  const before = preserved(fixture.home);
  const note = path.join(fixture.home, 'notes.txt');
  fs.writeFileSync(note, 'keep me');
  assert.equal((await install()).reasons.some(item => item.code === 'unknown_state'), true);
  fs.unlinkSync(note);
  const link = path.join(fixture.home, 'app/instances/milo/brain/outside');
  const outsideState = path.join(fixture.root, 'outside-home23-state');
  fs.mkdirSync(outsideState);
  fs.symlinkSync(outsideState, link);
  assert.equal((await install()).reasons.some(item => item.code === 'linked_state_path'), true);
  fs.unlinkSync(link);
  const cli = path.join(fixture.home, 'app/cli'), held = path.join(fixture.root, 'held-cli');
  fs.renameSync(cli, held);
  fs.symlinkSync('/tmp/outside-home23-software', cli);
  assert.equal((await install()).reasons.some(item => item.code === 'modified_installation'), true);
  fs.unlinkSync(cli);
  fs.renameSync(held, cli);
  fs.appendFileSync(path.join(fixture.home, 'app/cli/home23.js'), '// local edit\n');
  const result = await install();
  assert.equal(result.status, 'committed');
  assert.equal(packageId(fixture.home), fixture.next.packageId);
  assert.deepEqual(preserved(fixture.home), before);
});

test('interrupted reuseVerifiedStage resumes against the same valid stage', async t => {
  const fixture = homeFixture(t);
  const staging = fixture.staging;
  stageProductPayload({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging });
  const before = preserved(fixture.home);
  await assert.rejects(
    () => applyProductUpdate({
      homeRoot: fixture.home,
      candidatePayload: path.join(staging, 'payload'),
      staging,
      reuseVerifiedStage: true,
    }, {
      ...quiet,
      afterPhase: async journal => {
        if (journal.phase === 'retained') throw new Error('injected reuse interrupt');
      },
    }),
    /injected reuse interrupt/,
  );
  const journal = readUpdateJournal(fixture.home);
  assert.equal(journal.phase, 'retained');
  assert.equal(journal.reuseVerifiedStage, true);
  assert.equal(journal.stagedPayload, path.join(staging, 'payload'));
  assert.equal(journal.staging, staging);
  const resumed = await resumeProductUpdate({ homeRoot: fixture.home }, quiet);
  assert.equal(resumed.status, 'committed');
  assert.equal(packageId(fixture.home), fixture.next.packageId);
  assert.deepEqual(preserved(fixture.home), before);
  assert.equal(fs.existsSync(`${staging}-apply`), false);
});

test('committed reuseVerifiedStage replay succeeds when the reused stage is gone', async t => {
  const fixture = homeFixture(t);
  const staging = fixture.staging;
  stageProductPayload({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging });
  const result = await applyProductUpdate({
    homeRoot: fixture.home,
    candidatePayload: path.join(staging, 'payload'),
    staging,
    reuseVerifiedStage: true,
  }, quiet);
  assert.equal(result.status, 'committed');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(`${staging}.home23-stage.json`, { force: true });
  const replayed = await resumeProductUpdate({ homeRoot: fixture.home }, quiet);
  assert.equal(replayed.status, 'committed');
  assert.equal(replayed.replayed, true);
  assert.equal(packageId(fixture.home), fixture.next.packageId);
});

test('early reuseVerifiedStage resume refuses a missing stage and rolls back damaged bytes', async t => {
  async function interruptAtRetained(fixture, staging) {
    stageProductPayload({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging });
    await assert.rejects(
      () => applyProductUpdate({
        homeRoot: fixture.home,
        candidatePayload: path.join(staging, 'payload'),
        staging,
        reuseVerifiedStage: true,
      }, {
        ...quiet,
        afterPhase: async journal => {
          if (journal.phase === 'retained') throw new Error('injected early-phase interrupt');
        },
      }),
      /injected early-phase interrupt/,
    );
    assert.equal(readUpdateJournal(fixture.home).phase, 'retained');
  }

  const missingFixture = homeFixture(t);
  await interruptAtRetained(missingFixture, missingFixture.staging);
  fs.rmSync(missingFixture.staging, { recursive: true, force: true });
  fs.rmSync(`${missingFixture.staging}.home23-stage.json`, { force: true });
  const missing = await resumeProductUpdate({ homeRoot: missingFixture.home }, quiet);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'refused');
  assert.equal(missing.reasons[0].code, 'candidate_integrity_failed');
  assert.equal(readUpdateJournal(missingFixture.home).phase, 'retained');

  const damagedFixture = homeFixture(t);
  await interruptAtRetained(damagedFixture, damagedFixture.staging);
  fs.appendFileSync(path.join(damagedFixture.staging, 'payload/bin/node'), '#damaged-early\n');
  const damaged = await resumeProductUpdate({ homeRoot: damagedFixture.home }, quiet);
  assert.equal(damaged.ok, false);
  assert.equal(damaged.status, 'rolled_back');
  assert.equal(damaged.reasons[0].code, 'candidate_unhealthy');
  assert.equal(readUpdateJournal(damagedFixture.home).phase, 'rolled_back');
  assert.equal(packageId(damagedFixture.home), damagedFixture.installed.packageId);
  assert.equal(damaged.identityPreserved, true);
  assert.deepEqual(preserved(damagedFixture.home), {
    conversation: 'hello-milo', seed: '{"id":"seed-1"}\n', config: 'name: milo\n', value: 'same-home', version: 20,
  });
});

test('post-selection reuseVerifiedStage resume does not require the download stage', async t => {
  const fixture = homeFixture(t, { desiredRunning: true });
  const staging = fixture.staging;
  stageProductPayload({ homeRoot: fixture.home, candidatePayload: fixture.candidate, staging });
  await assert.rejects(
    () => applyProductUpdate({
      homeRoot: fixture.home,
      candidatePayload: path.join(staging, 'payload'),
      staging,
      reuseVerifiedStage: true,
      admit: true,
    }, {
      ...quiet,
      start: async () => ({ ok: true, status: 'ready' }),
      afterPhase: async journal => {
        if (journal.phase === 'writers_admitted') throw new Error('injected post-admission interrupt');
      },
    }),
    /injected post-admission interrupt/,
  );
  assert.equal(readUpdateJournal(fixture.home).phase, 'writers_admitted');
  assert.equal(readUpdateJournal(fixture.home).writersAdmitted, true);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(`${staging}.home23-stage.json`, { force: true });
  const resumed = await resumeProductUpdate({ homeRoot: fixture.home }, {
    ...quiet,
    start: async () => ({ ok: true, status: 'ready' }),
    verifyProductPayload: (root, options) => {
      assert.notEqual(root, fixture.home, 'admitted resume must not rehash the live selected tree');
      return verifyProductPayload(root, options);
    },
  });
  assert.equal(resumed.status, 'committed');
  assert.equal(packageId(fixture.home), fixture.next.packageId);
});
