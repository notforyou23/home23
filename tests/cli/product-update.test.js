import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeProductManifest, installProductPayload } from '../../cli/lib/product-payload.js';
import { adoptManagedSourceHome, inspectProductInstallation, planManagedSourceAdoption, previewProductUpdate } from '../../cli/lib/product-update.js';

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
  fs.mkdirSync(path.join(home, 'instances', name, 'substrate/seed-01'), { recursive: true });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'app'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tools/node_modules/pm2/bin'), { recursive: true });
  const release = { releaseId: 'ready', residents };
  fs.writeFileSync(path.join(home, 'instances/.house/coordination/active-release.json'), `${JSON.stringify(release)}\n`);
  fs.writeFileSync(path.join(home, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');
  fs.writeFileSync(path.join(home, 'config/home.yaml'), `name: ${name}\n`);
  fs.writeFileSync(path.join(home, 'config/secrets.yaml'), 'secret: keep\n', { mode: 0o600 });
  const birth = '{"seedId":"ada-seed"}\n';
  const ledger = '{"event":"birth","seedId":"ada-seed"}\n';
  fs.writeFileSync(path.join(home, 'instances', name, 'substrate/seed-01/birth-receipt.json'), birth);
  fs.writeFileSync(path.join(home, 'instances', name, 'substrate/seed-01/seed-ledger.jsonl'), ledger);
  fs.writeFileSync(path.join(home, 'runtime/semantic-prep.json'), JSON.stringify({
    schema: 'home23.semantic-prep.v1', homeRoot: home, recipeId, port: 21000, workerPid: 0, cacheDir: path.join(home, 'runtime/embedder-cache'),
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'bin/node'), '#!/bin/sh\nscript=$1; shift\nexec /bin/sh "$script" "$@"\n', { mode: 0o755 });
  const pm2Body = writers === 'busy'
    ? '#!/bin/sh\necho \'[{"name":"home23-ada","pm2_env":{"status":"online"}}]\'\n'
    : '#!/bin/sh\necho \'[]\'\n';
  fs.writeFileSync(path.join(home, 'tools/node_modules/pm2/bin/pm2'), pm2Body, { mode: 0o755 });
  if (hostRecord) {
    fs.writeFileSync(path.join(home, '.home23-host.json'), JSON.stringify({
      schema: 'home23.host.v2', homeRoot: home, profile: { name }, fingerprint: 'source', ports: {
        coordination: 21001, engine: 21002, dashboard: 21003, mcp: 21004, bridge: 21005, evobrew: 21006, observatory: 21007, embedder: 21000,
      }, phase: 'stopped', desiredRunning: false, encoderRequired: true,
    }, null, 2) + '\n', { mode: 0o600 });
  }
  return { home, birth, ledger, recipeId, name };
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
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.destinationCreated, false);
  assert.equal(fs.existsSync(destination), false);
});

test('adoption installs a new product home without birth and preserves Seed and recipe', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  const destination = path.join(pack.root, 'destination');
  const beforeLedger = fs.readFileSync(path.join(source.home, 'instances', source.name, 'substrate/seed-01/seed-ledger.jsonl'));
  const beforeBirth = fs.readFileSync(path.join(source.home, 'instances', source.name, 'substrate/seed-01/birth-receipt.json'));
  let birthCalls = 0;
  const result = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, { afterPreserve: () => { birthCalls += 0; } });
  assert.equal(result.ok, true);
  assert.equal(result.homeBirth, 'not_run');
  assert.equal(result.phase, 'stopped');
  assert.equal(result.desiredRunning, false);
  assert.equal(result.profile.name, source.name);
  assert.equal(birthCalls, 0);
  assert.equal(fs.existsSync(path.join(source.home, '.home23-install.json')), false);
  assert.equal(fs.readFileSync(path.join(destination, 'app/instances', source.name, 'substrate/seed-01/birth-receipt.json'), 'utf8'), beforeBirth.toString());
  assert.deepEqual(fs.readFileSync(path.join(destination, 'app/instances', source.name, 'substrate/seed-01/seed-ledger.jsonl')), beforeLedger);
  assert.deepEqual(fs.readFileSync(path.join(source.home, 'instances', source.name, 'substrate/seed-01/seed-ledger.jsonl')), beforeLedger);
  const prep = JSON.parse(fs.readFileSync(path.join(destination, 'runtime/semantic-prep.json'), 'utf8'));
  assert.equal(prep.recipeId, source.recipeId);
  const host = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8'));
  assert.equal(host.phase, 'stopped');
  assert.equal(host.desiredRunning, false);
  assert.throws(
    () => installProductPayload({ payloadPath: pack.payload, homeRoot: source.home }),
    /Refusing to adopt an existing directory as a Home23 installation/,
  );
});

test('adoption resumes after install interrupt without a second birth or Seed rewrite', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, { recipeId: 'recipe-resume-9' });
  const destination = path.join(pack.root, 'destination');
  const beforeLedger = fs.readFileSync(path.join(source.home, 'instances', source.name, 'substrate/seed-01/seed-ledger.jsonl'));
  const beforeBirth = fs.readFileSync(path.join(source.home, 'instances', source.name, 'substrate/seed-01/birth-receipt.json'));
  let installs = 0;
  await assert.rejects(() => adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, {
    installProductPayload: (...args) => { installs += 1; return installProductPayload(...args); },
    afterInstall: () => { throw new Error('interrupt after install'); },
  }), /interrupt after install/);
  assert.equal(installs, 1);
  assert.equal(fs.existsSync(path.join(destination, '.home23-install.json')), true);
  const journal = JSON.parse(fs.readFileSync(path.join(pack.root, `.destination.home23-adoption.json`), 'utf8'));
  assert.equal(journal.phase, 'preserving');
  assert.equal(journal.homeBirth, 'not_run');
  let birthInvoked = false;
  const resumed = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, {
    installProductPayload: (...args) => { installs += 1; birthInvoked = true; return installProductPayload(...args); },
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);
  assert.equal(installs, 1);
  assert.equal(birthInvoked, false);
  assert.equal(resumed.homeBirth, 'not_run');
  const birthFiles = [];
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.lstatSync(file).isDirectory()) walk(file);
      else if (name === 'birth-receipt.json') birthFiles.push(file);
    }
  };
  walk(path.join(destination, 'app/instances'));
  assert.equal(birthFiles.length, 1);
  assert.equal(fs.readFileSync(birthFiles[0], 'utf8'), beforeBirth.toString());
  assert.deepEqual(fs.readFileSync(path.join(destination, 'app/instances', source.name, 'substrate/seed-01/seed-ledger.jsonl')), beforeLedger);
  assert.deepEqual(fs.readFileSync(path.join(source.home, 'instances', source.name, 'substrate/seed-01/seed-ledger.jsonl')), beforeLedger);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'runtime/semantic-prep.json'), 'utf8')).recipeId, 'recipe-resume-9');
});

test('adoption refuses busy writers before creating the destination', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, { writers: 'busy' });
  const destination = path.join(pack.root, 'destination');
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  });
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.some(item => item.code === 'writers_active'));
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(path.join(pack.root, '.destination.home23-adoption.json')), false);
});

test('adoption refuses missing process inventory before creating the destination', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  fs.rmSync(path.join(source.home, 'bin/node'));
  const destination = path.join(pack.root, 'no-supervisor-dest');
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  });
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.some(item => item.code === 'process_inventory_unavailable'));
  assert.equal(fs.existsSync(destination), false);
});

test('adoption without a Host record uses exactly one active-release resident', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root, { hostRecord: false, name: 'ada', residents: { ada: { release: true } } });
  assert.equal(fs.existsSync(path.join(source.home, '.home23-host.json')), false);
  const destination = path.join(pack.root, 'destination');
  const result = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  });
  assert.equal(result.ok, true);
  const host = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8'));
  assert.equal(host.profile.name, 'ada');
  assert.equal(Object.hasOwn(host, 'fingerprint'), false);
  assert.equal(host.phase, 'stopped');

  const multi = managedHome(path.join(pack.root, 'multi'), {
    hostRecord: false, name: 'ada', residents: { ada: {}, forrest: {} },
  });
  const multiPlan = planManagedSourceAdoption(multi.home);
  assert.equal(multiPlan.canAdopt, false);
  assert.ok(multiPlan.reasons.some(item => item.code === 'unsupported_layout'));
  const multiDest = path.join(pack.root, 'multi-dest');
  const multiRefused = await adoptManagedSourceHome({
    sourceHome: multi.home, destinationRoot: multiDest, payloadPath: pack.payload,
  });
  assert.equal(multiRefused.ok, false);
  assert.equal(fs.existsSync(multiDest), false);
});

test('adoption plans refuse unmapped root preserve paths', t => {
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
  const plan = planManagedSourceAdoption(home);
  assert.equal(plan.canAdopt, true);
  assert.ok(plan.inventory.paths.some(item => item.path === 'birth-receipt.json' && item.mapping?.destination === 'app/instances/ada/substrate/seed-01/birth-receipt.json'));
  assert.ok(plan.inventory.paths.some(item => item.path === 'seed-ledger.jsonl' && item.mapping?.action === 'copy'));
});

test('interrupted adoption refuses when preserved source bytes change', async t => {
  const pack = fixture(t);
  const source = managedHome(pack.root);
  const destination = path.join(pack.root, 'destination');
  await assert.rejects(() => adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  }, { afterInstall: () => { throw new Error('interrupt after install'); } }), /interrupt after install/);
  const ledger = path.join(source.home, 'instances', source.name, 'substrate/seed-01/seed-ledger.jsonl');
  fs.appendFileSync(ledger, '{"event":"edited-after-interrupt"}\n');
  const refused = await adoptManagedSourceHome({
    sourceHome: source.home, destinationRoot: destination, payloadPath: pack.payload,
  });
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.some(item => item.code === 'source_identity_changed'));
  assert.equal(fs.existsSync(path.join(destination, '.home23-host.json')), false);
});
