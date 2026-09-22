import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { writeProductManifest, installProductPayload } from '../../cli/lib/product-payload.js';
import {
  adoptManagedSourceHome, holdAdoptionSupervisorLock, inspectProductInstallation,
  listSourceWriters, managedSupervisorEnvironment, planManagedSourceAdoption,
  previewProductUpdate, resolveAdoptionIdentity, sourceAdoptionSnapshot,
} from '../../cli/lib/product-update.js';
import { assertWritersIdle } from '../../cli/lib/product-backup.js';
import { acquireSupervisorLock } from '../../scripts/release/supervisor.mjs';
import { acquireManagedStartLocks } from '../../cli/lib/pm2-commands.js';
import {
  runHostAction, hostResidentNames, ownedProcessNamesForState, probeReadiness, residentPortsFor,
} from '../../cli/lib/product-host.js';

const require = createRequire(import.meta.url);
const Database = DatabaseSync;
const { agentProcessNames } = require('../../shared/agent-process-names.cjs');

function fixture(t, { sourceCommit = 'a'.repeat(40), platform = process.platform } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-preview-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload'), home = path.join(root, 'home');
  for (const [relative, contents] of Object.entries({ 'bin/node': '#!/bin/sh\n', 'app/cli/home23.js': 'export {};\n',
    'app/cli/lib/product-payload.js': 'export {};\n', 'app/scripts/product/host.mjs': 'export {};\n', 'tools/node_modules/pm2/bin/pm2': 'pm2\n',
    'app/dist/coordination/migrations/index.js': 'throw new Error("Candidate code must never execute in a preview");\n',
    'app/dist/coordination/migrations/0001-spine.js': 'throw new Error("Do not import migrations");\n',
    'app/dist/coordination/contracts/v1/pack-manifest.json': '{}\n',
    'app/dist/coordination/contracts/v1/schema.json': '{}\n',
  })) {
    const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  const manifest = writeProductManifest(payload, { sourceCommit, platform, arch: process.arch, nodeVersion: 'v22.19.0' });
  return { root, payload, home, manifest };
}

function tree(root) {
  const entries = [];
  const visit = relative => {
    const absolute = path.join(root, relative);
    for (const name of fs.readdirSync(absolute)) {
      const child = relative ? `${relative}/${name}` : name;
      const file = path.join(root, child), stat = fs.lstatSync(file);
      const item = { path: child, type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file', mode: stat.mode & 0o7777 };
      if (item.type === 'symlink') item.target = fs.readlinkSync(file);
      if (item.type === 'file') item.bytes = fs.readFileSync(file).toString('base64');
      entries.push(item); if (item.type === 'directory') visit(child);
    }
  };
  visit(''); return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function managedHome(root, {
  name = 'ada',
  recipeId = 'recipe-adopt-1',
  hostRecord = true,
  residents = { [name]: {} },
  writers = 'idle',
} = {}) {
  const home = path.join(root, 'managed-source');
  fs.mkdirSync(path.join(home, 'instances/.house/coordination'), { recursive: true });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'app'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tools/node_modules/pm2/bin'), { recursive: true });
  const release = { releaseId: 'ready', residents };
  fs.writeFileSync(path.join(home, 'instances/.house/coordination/active-release.json'), `${JSON.stringify(release)}\n`);
  fs.writeFileSync(path.join(home, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');
  fs.writeFileSync(path.join(home, 'config/home.yaml'), [
    'home:',
    `  primaryAgent: ${name}`,
    'name: ' + name,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(home, 'config/secrets.yaml'), 'secret: keep\n', { mode: 0o600 });
  const seeds = {};
  for (const resident of Object.keys(residents)) {
    fs.mkdirSync(path.join(home, 'instances', resident, 'substrate/seed-01'), { recursive: true });
    const birth = `{"seedId":"${resident}-seed"}\n`;
    const ledger = `{"event":"birth","seedId":"${resident}-seed"}\n`;
    fs.writeFileSync(path.join(home, 'instances', resident, 'substrate/seed-01/birth-receipt.json'), birth);
    fs.writeFileSync(path.join(home, 'instances', resident, 'substrate/seed-01/seed-ledger.jsonl'), ledger);
    fs.writeFileSync(path.join(home, 'instances', resident, 'config.yaml'), [
      `name: ${resident}`,
      'ports:',
      '  engine: 22002',
      '  dashboard: 22003',
      '  mcp: 22004',
      '  bridge: 22005',
      '',
    ].join('\n'));
    seeds[resident] = { birth, ledger };
  }
  fs.writeFileSync(path.join(home, 'runtime/semantic-prep.json'), JSON.stringify({
    schema: 'home23.semantic-prep.v1', homeRoot: home, recipeId, port: 21000, workerPid: 0, cacheDir: path.join(home, 'runtime/embedder-cache'),
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'bin/node'), '#!/bin/sh\nscript=$1; shift\nexec /bin/sh "$script" "$@"\n', { mode: 0o755 });
  const pm2Body = writers === 'busy'
    ? '#!/bin/sh\necho \'[{"name":"home23-ada","pm2_env":{"status":"online"}}]\'\n'
    : '#!/bin/sh\necho \'[]\'\n';
  fs.writeFileSync(path.join(home, 'tools/node_modules/pm2/bin/pm2'), pm2Body, { mode: 0o755 });
  const ports = {
    coordination: 21001, engine: 21002, dashboard: 21003, mcp: 21004, bridge: 21005, evobrew: 21006, observatory: 21007, embedder: 21000,
  };
  if (hostRecord) {
    fs.writeFileSync(path.join(home, '.home23-host.json'), JSON.stringify({
      schema: 'home23.host.v2', homeRoot: home, profile: { name }, fingerprint: 'source', ports,
      phase: 'stopped', desiredRunning: false, encoderRequired: true,
    }, null, 2) + '\n', { mode: 0o600 });
  }
  return { home, seeds, recipeId, name, ports };
}

const FIXED_PORTS = {
  coordination: 31001, engine: 31002, dashboard: 31003, mcp: 31004,
  bridge: 31005, evobrew: 31006, observatory: 31007, embedder: 31000,
};

function adoptionDeps(overrides = {}) {
  return {
    choosePortPlan: async () => ({ ...FIXED_PORTS }),
    rebindAdoptedHome: async () => null,
    // Default idle inventory — real listSourceWriters must not hit ambient PM2 during fixtures.
    listWriters: async () => [],
    ...overrides,
  };
}

test('preview distinguishes same and different intact candidates without changing either root', t => {
  const current = fixture(t), candidate = fixture(t, { sourceCommit: 'b'.repeat(40) });
  installProductPayload({ payloadPath: current.payload, homeRoot: current.home });
  fs.mkdirSync(path.join(current.home, 'app/instances/milo'), { recursive: true });
  fs.writeFileSync(path.join(current.home, 'app/instances/milo/lived.json'), 'keep');
  const beforeHome = tree(current.home), beforeCandidate = tree(candidate.payload);
  const same = previewProductUpdate({ homeRoot: current.home, candidatePayload: current.payload });
  assert.equal(same.canInstall, false); assert.ok(same.reasons.some(item => item.code === 'same_package'));
  assert.equal(same.publisherTrust, 'unverified'); assert.equal(same.stateMigrationCompatibility, 'unverified');
  assert.equal(same.preservation.complete, false);
  assert.equal(same.preservation.paths.find(item => item.path === 'app/instances').status, 'present');
  assert.equal(same.compatibility.groups.coordinationMigrations.status, 'unchanged');
  assert.equal(same.compatibility.groups.coordinationContracts.status, 'unchanged');
  const different = previewProductUpdate({ homeRoot: current.home, candidatePayload: candidate.payload });
  assert.ok(different.reasons.some(item => item.code === 'different_package'));
  assert.deepEqual(tree(current.home), beforeHome);
  assert.deepEqual(tree(candidate.payload), beforeCandidate);
});

test('preview reports corrupt receipts and unsupported layouts without exposing private contents', t => {
  const f = fixture(t);
  installProductPayload({ payloadPath: f.payload, homeRoot: f.home });
  fs.writeFileSync(path.join(f.home, '.home23-install.json'), '{broken');
  const corrupt = previewProductUpdate({ homeRoot: f.home, candidatePayload: f.payload });
  assert.ok(corrupt.reasons.some(item => item.code === 'invalid_private_receipt'));
  assert.doesNotMatch(JSON.stringify(corrupt), /broken/);
  const source = path.join(f.root, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'package.json'), '{}');
  assert.equal(inspectProductInstallation(source).layout, 'source');
  assert.equal(inspectProductInstallation(path.join(f.root, 'missing')).layout, 'absent');
  const dangling = path.join(f.root, 'dangling'); fs.mkdirSync(dangling); fs.symlinkSync('missing-receipt', path.join(dangling, '.home23-install.json'));
  assert.equal(inspectProductInstallation(dangling).reasons[0].code, 'invalid_private_receipt');
  const unsafe = path.join(f.root, 'unsafe'); fs.symlinkSync('missing-directory', unsafe);
  assert.throws(() => inspectProductInstallation(path.join(unsafe, 'home')), /real directory ancestors/);
  const managed = path.join(f.root, 'managed'); fs.mkdirSync(path.join(managed, 'instances/.house/coordination'), { recursive: true });
  fs.symlinkSync('missing-pointer', path.join(managed, 'instances/.house/coordination/active-release.json'));
  assert.equal(inspectProductInstallation(managed).layout, 'managed');
  const unknown = path.join(f.root, 'unknown'); fs.mkdirSync(unknown);
  assert.equal(inspectProductInstallation(unknown).layout, 'unknown');
});

test('preview reports candidate byte, mode, and platform failures and protocol stays read-only', t => {
  const f = fixture(t); installProductPayload({ payloadPath: f.payload, homeRoot: f.home });
  const changed = fixture(t); fs.appendFileSync(path.join(changed.payload, 'app/cli/home23.js'), 'changed');
  const integrity = previewProductUpdate({ homeRoot: f.home, candidatePayload: changed.payload });
  assert.ok(integrity.reasons.some(item => item.code === 'candidate_integrity_failed'));
  const modeChanged = fixture(t); fs.chmodSync(path.join(modeChanged.payload, 'app/cli/home23.js'), 0o755);
  assert.ok(previewProductUpdate({ homeRoot: f.home, candidatePayload: modeChanged.payload }).reasons.some(item => item.code === 'candidate_integrity_failed'));
  const foreign = fixture(t, { platform: process.platform === 'darwin' ? 'linux' : 'darwin' });
  const platform = previewProductUpdate({ homeRoot: f.home, candidatePayload: foreign.payload });
  assert.ok(platform.reasons.some(item => item.code === 'candidate_platform_unsupported'));
  const receipt = JSON.parse(fs.readFileSync(path.join(f.home, '.home23-install.json')));
  receipt.sourceCommit = 'c'.repeat(40); fs.writeFileSync(path.join(f.home, '.home23-install.json'), JSON.stringify(receipt), { mode: 0o600 });
  assert.ok(inspectProductInstallation(f.home).reasons.some(item => item.code === 'receipt_mismatch'));
  receipt.sourceCommit = f.manifest.sourceCommit; fs.writeFileSync(path.join(f.home, '.home23-install.json'), JSON.stringify(receipt), { mode: 0o600 });
  fs.mkdirSync(path.join(f.home, 'app/instances/.house/coordination'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'app/instances/.house/coordination/active-release.json'), '{}');
  assert.ok(inspectProductInstallation(f.home).reasons.some(item => item.code === 'mixed_managed_layout'));
  assert.throws(() => inspectProductInstallation('relative-home'), /absolute directory/);
  const beforeHome = tree(f.home), beforeCandidate = tree(f.payload);
  const reply = JSON.parse(execFileSync(process.execPath,
    ['scripts/product/host.mjs', 'preview', '--home', f.home, '--payload', f.payload], { encoding: 'utf8' }));
  assert.equal(reply.canInstall, false); assert.equal(reply.status, 'preview');
  assert.equal(fs.existsSync(path.join(f.home, 'runtime')), false);
  assert.deepEqual(tree(f.home), beforeHome); assert.deepEqual(tree(f.payload), beforeCandidate);
  fs.appendFileSync(path.join(f.home, 'app/cli/home23.js'), 'changed installed code');
  assert.equal(inspectProductInstallation(f.home).reasons[0].code, 'modified_installation');
});

test('managed and source adoption plans stay fail-closed and never write', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-adoption-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const managed = path.join(root, 'managed');
  fs.mkdirSync(path.join(managed, 'instances/.house/coordination'), { recursive: true });
  fs.writeFileSync(path.join(managed, 'instances/.house/coordination/active-release.json'), '{"releaseId":"fixture"}\n');
  const markerOnly = planManagedSourceAdoption(managed);
  assert.equal(markerOnly.layout, 'managed');
  assert.equal(markerOnly.canAdopt, false);
  assert.ok(markerOnly.reasons.some(item => item.code === 'unsupported_layout' || item.code === 'inventory_incomplete'));
  assert.equal(markerOnly.plan.homeBirth, 'not_run');
  assert.equal(markerOnly.plan.seedLedgers, 'preserve');
  assert.equal(markerOnly.plan.encoderRecipe, 'unchanged');

  fs.writeFileSync(path.join(managed, 'instances/.house/coordination/active-release.json'), JSON.stringify({
    releaseId: 'fixture', residents: { ada: {} },
  }));
  fs.mkdirSync(path.join(managed, 'instances/ada'), { recursive: true });
  fs.writeFileSync(path.join(managed, 'instances/ada/note.json'), '{}\n');
  fs.writeFileSync(path.join(managed, 'stray.bin'), 'unclassified');
  const blocked = planManagedSourceAdoption(managed);
  assert.equal(blocked.canAdopt, false);
  assert.ok(blocked.reasons.some(item => item.code === 'unknown_state' && item.path === 'stray.bin'));

  const ready = path.join(root, 'ready');
  fs.mkdirSync(path.join(ready, 'instances/.house/coordination'), { recursive: true });
  fs.mkdirSync(path.join(ready, 'instances/ada/substrate/seed-01'), { recursive: true });
  fs.mkdirSync(path.join(ready, 'config'), { recursive: true });
  fs.mkdirSync(path.join(ready, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ready, 'instances/.house/coordination/active-release.json'), JSON.stringify({
    releaseId: 'ready', residents: { ada: {} },
  }));
  fs.writeFileSync(path.join(ready, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(ready, 'config/home.yaml'), 'name: ada\n');
  fs.writeFileSync(path.join(ready, 'config/secrets.yaml'), 'secret: must-not-be-read\n', { mode: 0o600 });
  fs.writeFileSync(path.join(ready, 'config/session.token'), 'token-bytes', { mode: 0o600 });
  const seedBytes = '{"event":"birth"}\n';
  const birthPath = path.join(ready, 'instances/ada/substrate/seed-01/birth-receipt.json');
  const ledgerPath = path.join(ready, 'instances/ada/substrate/seed-01/seed-ledger.jsonl');
  fs.writeFileSync(birthPath, '{"seedId":"ada"}\n');
  fs.writeFileSync(ledgerPath, seedBytes);
  const beforeLedger = fs.readFileSync(ledgerPath);
  const beforeTree = tree(ready);
  fs.chmodSync(path.join(ready, 'config/secrets.yaml'), 0o000);
  fs.chmodSync(path.join(ready, 'config/session.token'), 0o000);
  const adopted = planManagedSourceAdoption(ready);
  assert.equal(adopted.layout, 'managed');
  assert.equal(adopted.canAdopt, true);
  assert.equal(adopted.inventory.complete, true);
  assert.equal(adopted.plan.homeBirth, 'not_run');
  assert.equal(adopted.plan.seedLedgers, 'preserve');
  assert.equal(adopted.plan.encoderRecipe, 'unchanged');
  assert.ok(adopted.inventory.paths.some(item => item.path.endsWith('birth-receipt.json') && item.role === 'preserve'));
  assert.ok(adopted.inventory.paths.some(item => item.path.endsWith('seed-ledger.jsonl') && item.role === 'preserve'));
  assert.ok(adopted.inventory.paths.some(item => item.path === 'config/secrets.yaml' && item.contents === 'unopened'));
  assert.ok(adopted.inventory.paths.some(item => item.path === 'config/session.token' && item.contents === 'unopened'));
  assert.doesNotMatch(JSON.stringify(adopted), /must-not-be-read|token-bytes/);
  assert.ok(adopted.inventory.paths.some(item => item.path === 'ecosystem.config.cjs' && item.role === 'rebind'));
  assert.ok(adopted.inventory.paths.some(item => item.path === 'logs' && item.role === 'rebuildable'));
  assert.equal(fs.existsSync(birthPath), true);
  assert.deepEqual(fs.readFileSync(ledgerPath), beforeLedger);
  fs.chmodSync(path.join(ready, 'config/secrets.yaml'), 0o600);
  fs.chmodSync(path.join(ready, 'config/session.token'), 0o600);
  assert.deepEqual(tree(ready), beforeTree);
  assert.equal(fs.existsSync(path.join(ready, '.home23-install.json')), false);

  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), '{}');
  const sourceOnly = planManagedSourceAdoption(source);
  assert.equal(sourceOnly.layout, 'source');
  assert.equal(sourceOnly.canAdopt, false);
  assert.ok(sourceOnly.reasons.some(item => item.code === 'unsupported_layout' || item.code === 'inventory_incomplete'));
  fs.writeFileSync(path.join(source, 'orphan.txt'), 'no');
  assert.ok(planManagedSourceAdoption(source).reasons.some(item => item.code === 'unknown_state' || item.code === 'unsupported_layout'));

  const product = fixture(t);
  installProductPayload({ payloadPath: product.payload, homeRoot: product.home });
  const productPlan = planManagedSourceAdoption(product.home);
  assert.equal(productPlan.layout, 'product');
  assert.equal(productPlan.canAdopt, false);
  assert.ok(productPlan.reasons.some(item => item.code === 'product_layout'));

  assert.throws(
    () => installProductPayload({ payloadPath: product.payload, homeRoot: ready }),
    /Refusing to adopt an existing directory as a Home23 installation/,
  );
  assert.deepEqual(fs.readFileSync(ledgerPath), beforeLedger);
});

test('adoption refuses external preserve links and does not create the destination', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  const linked = path.join(source.home, 'instances', source.name, 'substrate/seed-01/birth-receipt.json');
  fs.rmSync(linked);
  fs.symlinkSync('/tmp/home23-missing-birth-receipt', linked);
  const destination = path.join(pack.root, 'destination');
  const plan = planManagedSourceAdoption(source.home);
  assert.equal(plan.canAdopt, false);
  assert.ok(plan.reasons.some(item => item.code === 'external_state'));
  assert.ok(plan.inventory.paths.some(item => item.path.endsWith('birth-receipt.json') && item.external === true));
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps());
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.destinationCreated, false);
  assert.equal(fs.existsSync(destination), false);
});

test('adoption refuses when the managed supervisor lock is already held', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, { writers: 'idle' });
  const maintenance = path.join(source.home, 'instances/.house/maintenance');
  fs.mkdirSync(maintenance, { recursive: true, mode: 0o700 });
  const held = acquireSupervisorLock(maintenance, Database, { purpose: 'restart-managed', writers: ['home23-ada'] });
  t.after(() => held());
  const destination = path.join(pack.root, 'destination');
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps());
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'refused');
  assert.ok(refused.reasons.some(item => item.code === 'supervisor_lock_unavailable'));
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(path.join(pack.root, '.destination.home23-adoption.json')), false);
  assert.throws(
    () => installProductPayload({ payloadPath: pack.payload, homeRoot: source.home }),
    /Refusing to adopt an existing directory as a Home23 installation/,
  );
});

test('two-resident adoption holds the fence, keeps both Seed identities, and blocks start', async t => {
  const pack = fixture(t);
  // Key order is intentional: zed before ada — adoption must not pick alphabetically.
  const source = managedHome(pack.root, {
    hostRecord: false,
    name: 'ada',
    residents: { zed: { release: true }, ada: { release: true } },
  });
  const destination = path.join(pack.root, 'destination');
  const recipeBefore = fs.readFileSync(path.join(source.home, 'runtime/semantic-prep.json'));
  let startBlocked = false;
  const adopted = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps({
    beforePreserveCopy: async ({ source: home }) => {
      const maintenance = path.join(home, 'instances/.house/maintenance');
      assert.throws(
        () => acquireSupervisorLock(maintenance, Database, { purpose: 'restart-managed' }),
        /Another maintenance supervisor owns the service lock/,
      );
      assert.throws(
        () => acquireManagedStartLocks(home, { Database }),
        (error) => error.code === 'supervisor_lock_unavailable',
      );
      startBlocked = true;
    },
  }));
  assert.equal(startBlocked, true);
  assert.equal(adopted.ok, true);
  assert.equal(adopted.status, 'adopted');
  assert.deepEqual(adopted.residents, ['zed', 'ada']);
  assert.ok(adopted.residentMap);
  assert.deepEqual(Object.keys(adopted.residentMap), ['zed', 'ada']);
  assert.deepEqual(
    adopted.residentMap.zed.processNames,
    agentProcessNames({ home23Root: source.home, agentName: 'zed' }),
  );
  assert.deepEqual(
    adopted.residentMap.ada.processNames,
    agentProcessNames({ home23Root: source.home, agentName: 'ada' }),
  );
  const host = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8'));
  assert.equal(host.encoderRequired, false);
  assert.ok(host.residentMap.zed.ports);
  assert.ok(host.residentMap.ada.ports);
  assert.notEqual(host.residentMap.zed.ports.engine, host.residentMap.ada.ports.engine);
  assert.equal(host.fingerprint, undefined);
  assert.equal(host.desiredRunning, false);
  assert.equal(host.phase, 'stopped');
  assert.equal(
    fs.readFileSync(path.join(destination, 'app/instances/zed/substrate/seed-01/seed-ledger.jsonl'), 'utf8'),
    source.seeds.zed.ledger,
  );
  assert.equal(
    fs.readFileSync(path.join(destination, 'app/instances/ada/substrate/seed-01/seed-ledger.jsonl'), 'utf8'),
    source.seeds.ada.ledger,
  );
  assert.equal(
    fs.readFileSync(path.join(destination, 'app/instances/zed/substrate/seed-01/birth-receipt.json'), 'utf8'),
    source.seeds.zed.birth,
  );
  assert.equal(
    fs.readFileSync(path.join(destination, 'app/instances/ada/substrate/seed-01/birth-receipt.json'), 'utf8'),
    source.seeds.ada.birth,
  );
  assert.deepEqual(fs.readFileSync(path.join(destination, 'runtime/semantic-prep.json')), recipeBefore);
});

test('real rebind and host status keep distinct resident ports; Start refuses under the lock', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, {
    hostRecord: false,
    name: 'ada',
    residents: { zed: {}, ada: {} },
  });
  const destination = path.join(pack.root, 'destination');
  const adopted = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, {
    // Real rebindAdoptedHome and real choosePortPlan — do not stub either.
    Database,
    listWriters: async () => [],
  });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.status, 'adopted');
  const host = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8'));
  assert.equal(host.encoderRequired, false);
  assert.deepEqual(Object.keys(host.residentMap), ['zed', 'ada']);
  assert.notEqual(host.residentMap.zed.ports.engine, host.residentMap.ada.ports.engine);
  assert.notEqual(host.residentMap.zed.ports.dashboard, host.residentMap.ada.ports.dashboard);
  const zedConfig = fs.readFileSync(path.join(destination, 'app/instances/zed/config.yaml'), 'utf8');
  const adaConfig = fs.readFileSync(path.join(destination, 'app/instances/ada/config.yaml'), 'utf8');
  assert.match(zedConfig, new RegExp(`engine: ${host.residentMap.zed.ports.engine}`));
  assert.match(adaConfig, new RegExp(`engine: ${host.residentMap.ada.ports.engine}`));

  const status = await runHostAction('status', { homeRoot: destination });
  assert.equal(status.ok, true);
  assert.deepEqual(status.residents, ['zed', 'ada']);
  assert.ok(status.residentMap);
  assert.deepEqual(hostResidentNames({ residentMap: status.residentMap, profile: status.profile }), ['zed', 'ada']);
  // Primary (ada) dashboard URL must use residentMap ports, not the shared Host dashboard port.
  assert.equal(
    status.connection.dashboardURL,
    `http://127.0.0.1:${host.residentMap.ada.ports.dashboard}`,
  );
  assert.notEqual(status.connection.dashboardURL, `http://127.0.0.1:${host.ports.dashboard}`);
  assert.deepEqual(residentPortsFor(host, 'ada').engine, host.residentMap.ada.ports.engine);
  assert.deepEqual(residentPortsFor(host, 'zed').dashboard, host.residentMap.zed.ports.dashboard);

  const { privateJSON } = await import('../../cli/lib/product-environment.js');
  fs.mkdirSync(path.join(destination, 'runtime'), { recursive: true, mode: 0o700 });
  privateJSON(path.join(destination, 'runtime/host-session.json'), {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const probed = [];
  const online = ownedProcessNamesForState(host).map((name, index) => ({
    name, status: 'online', pid: 4000 + index, owned: true,
  }));
  host.birth = { home: { id: 'home-adopt-fixture' }, coordination: { botId: 'bot-adopt-fixture' } };
  const readiness = await probeReadiness(destination, host, online, {
    request: async (url) => {
      probed.push(url);
      if (url.endsWith('/api/v1/capabilities')) {
        return { pairingAvailable: true, capabilities: { bootstrap: true, messageSubmission: true } };
      }
      if (url.endsWith('/api/v1/bootstrap')) {
        return {
          home: { id: 'home-adopt-fixture' },
          snapshot: { bots: [{ id: 'bot-adopt-fixture', availability: 'available', conversationId: 'c1' }] },
        };
      }
      if (url.includes('/home23/process.json')) {
        const name = url.includes(String(host.residentMap.ada.ports.dashboard)) ? 'ada' : 'zed';
        return { pid: online.find(row => row.name === `home23-${name}-dash`).pid };
      }
      if (url.endsWith('/healthz')) return 'ok';
      return { ok: true };
    },
  });
  assert.equal(readiness.ready, true, readiness.issues?.join('; '));
  assert.ok(probed.some(url => url.includes(`:${host.residentMap.ada.ports.engine}/`)));
  assert.ok(probed.some(url => url.includes(`:${host.residentMap.zed.ports.engine}/`)));
  assert.ok(probed.some(url => url.includes(`:${host.residentMap.ada.ports.dashboard}/`)));
  assert.ok(probed.some(url => url.includes(`:${host.residentMap.zed.ports.dashboard}/`)));
  assert.equal(probed.some(url => url.includes(`:${host.ports.engine}/`)), false);
  assert.equal(probed.some(url => url.includes(`:${host.ports.dashboard}/`)), false);

  // Fence proof: the same acquireManagedStartLocks call runStart uses before spawn.
  // Hold the product maintenance path Start acquires for installed homes.
  const maintenance = path.join(destination, 'app/instances/.house/maintenance');
  fs.mkdirSync(maintenance, { recursive: true, mode: 0o700 });
  const held = acquireSupervisorLock(maintenance, Database, { purpose: 'adoption', writers: ownedProcessNamesForState(host) });
  t.after(() => held());
  assert.throws(
    () => acquireManagedStartLocks(destination, { Database, writers: ownedProcessNamesForState(host) }),
    (error) => error.code === 'supervisor_lock_unavailable',
  );
  const locked = await runHostAction('start', { homeRoot: destination }, {
    execute: async () => {
      throw new Error('Start must not spawn writers while the supervisor lock is held.');
    },
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.error?.code, 'supervisor_lock_unavailable');
});

test('listSourceWriters inventories PATH pm2 with product PM2 sockets stripped', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, { hostRecord: false, name: 'ada', residents: { ada: {} } });
  const calls = [];
  const rows = await listSourceWriters(source.home, {
    pm2Command: 'pm2-fixture',
    env: managedSupervisorEnvironment({
      PATH: '/bin',
      PM2_HOME: path.join(source.home, 'runtime/pm2'),
      PM2_DAEMON_RPC_PORT: '/tmp/product-rpc.sock',
      PM2_DAEMON_PUB_PORT: '/tmp/product-pub.sock',
      HOME23_PRODUCT_HOST: 'true',
      HOME23_AGENT: 'should-strip',
    }),
    executeFile: async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return { stdout: '[]\n' };
    },
  });
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pm2-fixture');
  assert.deepEqual(calls[0].args, ['jlist', '--silent']);
  assert.equal(calls[0].env.PM2_HOME, undefined);
  assert.equal(calls[0].env.PM2_DAEMON_RPC_PORT, undefined);
  assert.equal(calls[0].env.HOME23_PRODUCT_HOST, undefined);
  assert.equal(calls[0].env.HOME23_AGENT, undefined);
});

test('listSourceWriters ignores processes that belong to another home', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, { hostRecord: false, name: 'ada', residents: { ada: {} } });
  const rows = await listSourceWriters(source.home, {
    executeFile: async () => ({
      stdout: JSON.stringify([
        { name: 'home23-jerry', pm2_env: { status: 'online', pm_cwd: '/Users/jtr/_JTR23_/release/home23/engine' } },
        { name: 'home23-ada', pm2_env: { status: 'online', pm_cwd: source.home } },
      ]),
    }),
  });
  assert.deepEqual(rows, [{ name: 'home23-ada', status: 'online' }]);
});

test('listSourceWriters refuses an active expected writer with no path metadata', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, { hostRecord: false, name: 'ada', residents: { ada: {} } });
  const rows = await listSourceWriters(source.home, {
    expectedWriters: ['home23-ada'],
    executeFile: async () => ({
      stdout: JSON.stringify([
        { name: 'home23-ada', pm2_env: { status: 'online' } },
        { name: 'home23-jerry', pm2_env: { status: 'online', pm_cwd: '/Users/jtr/_JTR23_/release/home23/engine' } },
      ]),
    }),
  });
  assert.deepEqual(rows, [{ name: 'home23-ada', status: 'online' }]);
  assert.throws(() => assertWritersIdle(rows), /Writers are still running/);
});

test('adoption refuses when the managed supervisor inventory is unavailable', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  const destination = path.join(pack.root, 'destination');
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps({
    listWriters: async () => {
      throw Object.assign(new Error('Home process inventory is unavailable.'), { code: 'process_inventory_unavailable' });
    },
  }));
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'refused');
  assert.ok(refused.reasons.some(item => item.code === 'process_inventory_unavailable'));
  assert.equal(fs.existsSync(destination), false);
});

test('writeStoppedHost copies birth from the create-home receipt authority', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, { hostRecord: false, name: 'ada', residents: { ada: {} } });
  fs.writeFileSync(path.join(source.home, 'instances/.house/creation.json'), `${JSON.stringify({
    schema: 'home23.create-home.v1',
    status: 'prepared',
    home: { id: 'home_from_creation', name: "Ada's Home" },
    receipt: {
      schema: 'home23.create-home.v1',
      status: 'prepared',
      home: { id: 'home_from_creation', name: "Ada's Home" },
      coordination: { botId: 'bot_from_creation' },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const identity = resolveAdoptionIdentity(source.home);
  assert.equal(identity.ok, true);
  assert.equal(identity.birth.home.id, 'home_from_creation');
  assert.equal(identity.birth.coordination.botId, 'bot_from_creation');
  const destination = path.join(pack.root, 'destination');
  const adopted = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps());
  assert.equal(adopted.ok, true);
  const host = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8'));
  assert.equal(host.birth.home.id, 'home_from_creation');
  assert.equal(host.birth.coordination.botId, 'bot_from_creation');
  assert.equal(host.encoderRequired, false);
});

test('a new preserve file during the copy window cannot finish as adopted', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  const destination = path.join(pack.root, 'destination');
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps({
    beforePreserveCopy: async ({ source: home }) => {
      fs.writeFileSync(path.join(home, 'instances', source.name, 'late-note.json'), '{"late":true}\n');
    },
  }));
  assert.equal(refused.ok, false);
  assert.notEqual(refused.status, 'adopted');
  assert.ok(refused.reasons.some(item => item.code === 'source_identity_changed'));
});

function interruptedJournal(sourceHome, destination, payloadPath) {
  const source = fs.realpathSync(sourceHome);
  const payload = fs.realpathSync(payloadPath);
  const plan = planManagedSourceAdoption(source);
  const identity = resolveAdoptionIdentity(source);
  const snapshot = sourceAdoptionSnapshot(source, plan.inventory.paths, identity);
  const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'manifest.json'), 'utf8'));
  const journal = {
    schema: 'home23.managed-source-adoption-journal.v1',
    sourceHome: source,
    destinationRoot: path.resolve(destination),
    payloadPath: payload,
    packageId: manifest.packageId,
    sourceSnapshot: snapshot,
    phase: 'preserving',
    homeBirth: 'not_run',
  };
  fs.writeFileSync(path.join(path.dirname(destination), `.${path.basename(destination)}.home23-adoption.json`), `${JSON.stringify(journal, null, 2)}\n`);
  return journal;
}

test('a pre-existing completed adoption journal is not success', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  const destination = path.join(pack.root, 'destination');
  const journal = interruptedJournal(source.home, destination, pack.payload);
  journal.phase = 'completed';
  fs.writeFileSync(
    path.join(pack.root, '.destination.home23-adoption.json'),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps());
  assert.equal(refused.ok, false);
  assert.notEqual(refused.status, 'adopted');
  assert.equal(refused.status, 'refused');
  assert.ok(refused.reasons.some(item => item.code === 'supervisor_fence_unavailable'));
  assert.equal(fs.existsSync(destination), false);
});

test('resume refuses candidate byte substitution without packageId change', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  const destination = path.join(pack.root, 'destination');
  interruptedJournal(source.home, destination, pack.payload);
  fs.appendFileSync(path.join(pack.payload, 'app/cli/home23.js'), 'substituted-runtime-bytes');
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps());
  assert.equal(refused.ok, false);
  assert.notEqual(refused.status, 'adopted');
  assert.ok(refused.reasons.some(item => item.code === 'package_integrity_failed'));
});

test('resume refuses when host or release identity inputs change', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  const destination = path.join(pack.root, 'destination');
  interruptedJournal(source.home, destination, pack.payload);
  const hostPath = path.join(source.home, '.home23-host.json');
  const host = JSON.parse(fs.readFileSync(hostPath, 'utf8'));
  host.fingerprint = 'redirected-identity';
  fs.writeFileSync(hostPath, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps());
  assert.equal(refused.ok, false);
  assert.notEqual(refused.status, 'adopted');
  assert.ok(refused.reasons.some(item => item.code === 'source_identity_changed'));
  assert.equal(fs.existsSync(path.join(destination, '.home23-host.json')), false);
});

test('single-resident Host record stays valid; multi-resident plans keep every name', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, { hostRecord: false, name: 'ada', residents: { ada: { release: true } } });
  assert.equal(fs.existsSync(path.join(source.home, '.home23-host.json')), false);
  const plan = planManagedSourceAdoption(source.home);
  assert.equal(plan.canAdopt, true);
  assert.equal(plan.identity.profile.name, 'ada');
  assert.equal(plan.identity.residentMap, null);
  const destination = path.join(pack.root, 'destination');
  const adopted = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps());
  assert.equal(adopted.ok, true);
  assert.equal(adopted.status, 'adopted');
  assert.equal(adopted.profile.name, 'ada');
  assert.equal(adopted.residentMap, null);
  const host = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8'));
  assert.equal(host.profile.name, 'ada');
  assert.equal(host.residentMap, undefined);

  const multi = managedHome(path.join(pack.root, 'multi'), {
    hostRecord: false, name: 'ada', residents: { ada: {}, forrest: {} },
  });
  const multiPlan = planManagedSourceAdoption(multi.home);
  assert.equal(multiPlan.canAdopt, true);
  assert.deepEqual(multiPlan.identity.residents, ['ada', 'forrest']);
  assert.ok(multiPlan.identity.residentMap.ada);
  assert.ok(multiPlan.identity.residentMap.forrest);
});

test('adoption plans map root preserve paths explicitly', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-unmap-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'instances/.house/coordination'), { recursive: true });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'instances/.house/coordination/active-release.json'), JSON.stringify({
    releaseId: 'x', residents: { ada: {} },
  }));
  fs.writeFileSync(path.join(home, 'config/home.yaml'), 'name: ada\n');
  fs.writeFileSync(path.join(home, 'birth-receipt.json'), '{"seedId":"root"}\n');
  fs.writeFileSync(path.join(home, 'seed-ledger.jsonl'), '{"event":"birth"}\n');
  // Root birth/ledger map needs instance state for the single resident as well.
  fs.mkdirSync(path.join(home, 'instances/ada/substrate/seed-01'), { recursive: true });
  fs.writeFileSync(path.join(home, 'instances/ada/substrate/seed-01/note.json'), '{}\n');
  const plan = planManagedSourceAdoption(home);
  assert.equal(plan.canAdopt, true);
  assert.ok(plan.inventory.paths.some(item => item.path === 'birth-receipt.json' && item.mapping?.destination === 'app/instances/ada/substrate/seed-01/birth-receipt.json'));
  assert.ok(plan.inventory.paths.some(item => item.path === 'seed-ledger.jsonl' && item.mapping?.action === 'copy'));
});

test('interrupted adoption refuses when preserved source bytes change', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  const destination = path.join(pack.root, 'destination');
  interruptedJournal(source.home, destination, pack.payload);
  const ledger = path.join(source.home, 'instances', source.name, 'substrate/seed-01/seed-ledger.jsonl');
  fs.appendFileSync(ledger, '{"event":"edited-after-interrupt"}\n');
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, adoptionDeps());
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.some(item => item.code === 'source_identity_changed'));
  assert.equal(fs.existsSync(path.join(destination, '.home23-host.json')), false);
});

test('holdAdoptionSupervisorLock records writers for every resident', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-fence-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = managedHome(root, {
    hostRecord: false,
    residents: { zed: {}, ada: {} },
  });
  const identity = resolveAdoptionIdentity(source.home);
  const release = holdAdoptionSupervisorLock(source.home, identity, { Database });
  t.after(() => release());
  assert.ok(identity.writers.includes('home23-zed'));
  assert.ok(identity.writers.includes('home23-ada'));
  assert.throws(
    () => acquireSupervisorLock(path.join(source.home, 'instances/.house/maintenance'), Database),
    /Another maintenance supervisor/,
  );
});
