import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { installProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import { previewProductUpdate } from '../../cli/lib/product-update.js';
import { applyProductUpdate, readUpdateJournal, resumeProductUpdate, softwareUnits, updateBlocksStart, updateDirectoryFor } from '../../cli/lib/product-update-apply.js';
import { inspectUpdateInventory, SUPPORTED_COORDINATION_MIGRATION_CHECKSUM, SUPPORTED_COORDINATION_SCHEMA, SUPPORTED_COORDINATION_SCHEMA_CHECKSUM, ownedWriterNames } from '../../cli/lib/product-update-inventory.js';
import { adoptVerifiedStage, stageLockPath, stageProductPayload } from '../../cli/lib/product-update-stage.js';
import { acquireInstallLock } from '../../cli/lib/product-payload.js';

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
function database(file, version = SUPPORTED_COORDINATION_SCHEMA) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${version};
    CREATE TABLE schema_migrations (version INTEGER, name TEXT, checksum TEXT, applied_at TEXT, application_version TEXT);
    INSERT INTO schema_migrations VALUES (${version}, 'chess-engines', '${SUPPORTED_COORDINATION_MIGRATION_CHECKSUM}', 't', 'test');
    CREATE TABLE kernel_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    INSERT INTO kernel_meta VALUES ('schema.checksum', '${SUPPORTED_COORDINATION_SCHEMA_CHECKSUM}', 't');
    INSERT INTO kernel_meta VALUES ('schema.version', '${version}', 't');
    CREATE TABLE kept (value TEXT);
    INSERT INTO kept VALUES ('same-home');`);
  db.close();
}
function populate(home, { desiredRunning = false, version = SUPPORTED_COORDINATION_SCHEMA } = {}) {
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
  const installed = payload(current, { sourceCommit: 'a'.repeat(40) });
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
  assert.deepEqual(ownedWriterNames('milo', { encoderRequired: true }), ['home23-coordination', 'home23-milo', 'home23-milo-dash', 'home23-milo-harness', 'home23-milo-seed', 'home23-milo-shipper', 'home23-seed-observatory', 'home23-evobrew', 'home23-embedder']);
  assert.equal(updateBlocksStart({ phase: 'applying', ownerToken: 'token' }, 'token'), true);
  assert.equal(updateBlocksStart({ phase: 'selected', ownerToken: 'token' }, 'token'), false);
  assert.equal(updateBlocksStart({ phase: 'committed' }), false);
  assert.equal(updateBlocksStart({ phase: 'rolled_back' }), false);
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
  fs.symlinkSync('/tmp/outside-insight.md', path.join(directory, 'insights_curated_LATEST.md'));
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
  assert.equal(preserved(running.home).version, SUPPORTED_COORDINATION_SCHEMA);
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
  assert.equal(packageId(fixture.home), fixture.next.packageId);
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
  fs.symlinkSync('/tmp/outside-home23-state', link);
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
    conversation: 'hello-milo', seed: '{"id":"seed-1"}\n', config: 'name: milo\n', value: 'same-home', version: SUPPORTED_COORDINATION_SCHEMA,
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
  });
  assert.equal(resumed.status, 'committed');
  assert.equal(packageId(fixture.home), fixture.next.packageId);
});
