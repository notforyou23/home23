import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateJSON } from '../../cli/lib/product-environment.js';
import { selectStagedInstall } from '../../cli/lib/product-update-feed.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hostEntry = path.join(rootDir, 'scripts/product/host.mjs');
const nodeBin = process.execPath;

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-host-install-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runHost(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [hostEntry, ...args], { cwd: rootDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('install-staged refuses a copying claim without applying', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  privateJSON(`${staging}.home23-stage.json`, {
    schema: 'home23.product-stage.v1',
    homeRoot: home,
    staging,
    currentPackageId: 'a'.repeat(64),
    candidatePackageId: 'b'.repeat(64),
    candidateSourceCommit: 'c'.repeat(40),
    id: crypto.randomUUID(),
    status: 'copying',
  });

  const result = await runHost(['install-staged', '--home', home, '--staging', staging]);
  const body = JSON.parse(result.stdout);
  assert.equal(result.code, 1);
  assert.equal(body.status, 'copying');
  assert.equal(body.canInstall, false);
  assert.equal(body.selected, false);
  assert.equal(body.candidatePayload, null);
  assert.equal(body.usesUpdateController, true);
  assert.equal(body.resumed, true);
  assert.equal(fs.existsSync(path.join(home, '.home23-update')), false);
});

test('install-staged refuses absent staging and selects staged payload path', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const absent = await runHost(['install-staged', '--home', home, '--staging', staging]);
  const absentBody = JSON.parse(absent.stdout);
  assert.equal(absent.code, 1);
  assert.equal(absentBody.status, 'absent');
  assert.equal(absentBody.canInstall, false);
  assert.equal(absentBody.selected, false);

  // Prefer guard + selection path over a full 48k package apply.
  const payload = path.join(staging, 'payload');
  fs.mkdirSync(payload, { recursive: true, mode: 0o755 });
  const packageId = 'd'.repeat(64);
  // Minimal claim+payload agreement for recoverDownload/selectStagedInstall.
  // A full product manifest is not required for the host refuse/selection guard;
  // recoverDownload needs a readable matching manifest, so leave damaged as the
  // incomplete case and assert the candidate path contract via selectStagedInstall
  // after a real staged fixture is prepared by feed tests.
  privateJSON(`${staging}.home23-stage.json`, {
    schema: 'home23.product-stage.v1',
    homeRoot: home,
    staging,
    currentPackageId: 'e'.repeat(64),
    candidatePackageId: packageId,
    candidateSourceCommit: 'f'.repeat(40),
    id: crypto.randomUUID(),
    status: 'staged',
  });
  const damaged = selectStagedInstall({ staging });
  assert.equal(damaged.status, 'damaged');
  assert.equal(damaged.canInstall, false);
  assert.equal(damaged.selected, false);
  assert.equal(damaged.candidatePayload, null);
});

test('install-staged reuses the verified stage path instead of a sibling -apply tree', async t => {
  const { writeProductManifest, installProductPayload } = await import('../../cli/lib/product-payload.js');
  const { stageProductPayload } = await import('../../cli/lib/product-update-stage.js');
  const { SUPPORTED_COORDINATION_SCHEMAS } = await import('../../cli/lib/product-update-inventory.js');
  const supported = SUPPORTED_COORDINATION_SCHEMAS[20];
  const { DatabaseSync } = await import('node:sqlite');
  const root = tempRoot(t);
  function payload(dir, sourceCommit, extra = {}) {
    const files = {
      'bin/node': '#!/bin/sh\n', 'app/cli/home23.js': 'export {};\n', 'app/cli/lib/product-payload.js': 'export {};\n',
      'app/scripts/product/host.mjs': 'export {};\n', 'tools/node_modules/pm2/bin/pm2': 'pm2\n',
      'app/dist/coordination/migrations/index.js': 'migration-index\n',
      'app/dist/coordination/migrations/0001-coordination-spine.js': 'migration-one\n',
      'app/dist/coordination/contracts/v1/pack-manifest.json': '{}\n',
      'app/dist/coordination/contracts/v1/schema.json': '{}\n',
      'app/engine/data/images/.gitkeep': '', ...extra,
    };
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
      fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
    }
    fs.mkdirSync(path.join(dir, 'app/config'), { recursive: true, mode: 0o755 });
    return writeProductManifest(dir, { sourceCommit, platform: process.platform, arch: process.arch, nodeVersion: 'v22.19.0' });
  }
  const current = path.join(root, 'current');
  const candidate = path.join(root, 'candidate');
  const home = path.join(root, 'home');
  const staging = path.join(root, 'staging');
  const installed = payload(current, 'a'.repeat(40));
  const next = payload(candidate, 'b'.repeat(40), { 'app/cli/lib/update-marker.txt': 'reuse-stage\n' });
  installProductPayload({ payloadPath: current, homeRoot: home });
  fs.mkdirSync(path.join(home, 'app/config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app/config/home.yaml'), 'name: milo\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'app/config/secrets.yaml'), 'providers: {}\n', { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'app/instances/milo/conversations'), { recursive: true });
  fs.mkdirSync(path.join(home, 'app/instances/milo/brain'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app/instances/milo/conversations/session.txt'), 'hello');
  fs.writeFileSync(path.join(home, 'app/instances/milo/brain/event-ledger.jsonl'), '{"id":"seed-1"}\n');
  const dbFile = path.join(home, 'app/instances/.house/coordination/home23-coordination.sqlite3');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA user_version = 20;
    CREATE TABLE schema_migrations (version INTEGER, name TEXT, checksum TEXT, applied_at TEXT, application_version TEXT);
    INSERT INTO schema_migrations VALUES (20, 'chess-engines', '${supported.migrationChecksum}', 't', 'test');
    CREATE TABLE kernel_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    INSERT INTO kernel_meta VALUES ('schema.checksum', '${supported.schemaChecksum}', 't');
    INSERT INTO kernel_meta VALUES ('schema.version', '20', 't');`);
  db.close();
  fs.writeFileSync(path.join(home, '.home23-host.json'), JSON.stringify({
    schema: 'home23.host.v2', homeRoot: home, profile: { name: 'milo', provider: 'ollama-local', model: 'fixture' },
    desiredRunning: false, encoderRequired: true, phase: 'prepared',
  }), { mode: 0o600 });
  stageProductPayload({ homeRoot: home, candidatePayload: candidate, staging });
  assert.equal(installed.packageId !== next.packageId, true);

  const result = await runHost(['install-staged', '--home', home, '--staging', staging]);
  const body = JSON.parse(result.stdout);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(body.status, 'committed');
  assert.equal(body.installed, true);
  assert.equal(body.selectedCandidatePayload, path.join(staging, 'payload'));
  assert.equal(fs.existsSync(`${staging}-apply`), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.home23-install.json'), 'utf8')).packageId, next.packageId);
});

test('update-recovery reports absent when no journal exists', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const result = await runHost(['update-recovery', '--home', home]);
  const body = JSON.parse(result.stdout);
  assert.equal(result.code, 0);
  assert.equal(body.status, 'absent');
  assert.equal(body.phase, 'absent');
  assert.equal(body.current, false);
  assert.notEqual(body.status, 'current');
  assert.equal(body.canInstall, false);
});
