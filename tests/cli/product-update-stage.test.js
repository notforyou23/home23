import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeProductManifest, installProductPayload } from '../../cli/lib/product-payload.js';
import { stageProductPayload } from '../../cli/lib/product-update-stage.js';

function fixture(t, commit = 'a'.repeat(40)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-stage-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload'), home = path.join(root, 'home');
  for (const [relative, contents] of Object.entries({ 'bin/node': '#!/bin/sh\n', 'app/cli/home23.js': 'export {};\n', 'app/cli/lib/product-payload.js': 'export {};\n', 'app/scripts/product/host.mjs': 'export {};\n', 'tools/node_modules/pm2/bin/pm2': 'pm2\n' })) {
    const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  fs.mkdirSync(path.join(payload, 'tools/node_modules/.bin'), { mode: 0o755 });
  fs.symlinkSync('../pm2/bin/pm2', path.join(payload, 'tools/node_modules/.bin/pm2'));
  fs.symlinkSync('pm2', path.join(payload, 'tools/node_modules/.bin/alias'));
  const manifest = writeProductManifest(payload, { sourceCommit: commit, platform: process.platform, arch: process.arch, nodeVersion: 'v22.19.0' });
  installProductPayload({ payloadPath: payload, homeRoot: home });
  return { root, payload, home, manifest };
}
function tree(root) {
  const result = [];
  const visit = relative => { const directory = path.join(root, relative); for (const name of fs.readdirSync(directory)) {
    const child = relative ? `${relative}/${name}` : name, file = path.join(root, child), stat = fs.lstatSync(file);
    const item = { path: child, type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file', mode: stat.mode & 0o7777 };
    if (item.type === 'file') item.bytes = fs.readFileSync(file).toString('base64'); if (item.type === 'symlink') item.target = fs.readlinkSync(file);
    result.push(item); if (item.type === 'directory') visit(child);
  } };
  visit(''); return result.sort((a, b) => a.path.localeCompare(b.path));
}

test('stages an exact candidate, retries idempotently, and preserves both inputs', t => {
  const f = fixture(t), candidate = fixture(t, 'b'.repeat(40)), staging = path.join(f.root, 'staging'), beforeHome = tree(f.home), beforePayload = tree(candidate.payload);
  const first = stageProductPayload({ homeRoot: f.home, candidatePayload: candidate.payload, staging });
  assert.equal(first.status, 'staged'); assert.equal(first.canInstall, false); assert.equal(first.publisherTrust, 'unverified');
  assert.equal(first.receipt.currentPackageId, f.manifest.packageId); assert.equal(first.receipt.candidatePackageId, candidate.manifest.packageId);
  const replay = stageProductPayload({ homeRoot: f.home, candidatePayload: candidate.payload, staging });
  assert.equal(replay.status, 'staged'); assert.equal(replay.replayed, true); assert.equal(replay.receipt.id, first.receipt.id);
  assert.deepEqual(tree(path.join(staging, 'payload')), beforePayload);
  assert.deepEqual(tree(f.home), beforeHome); assert.deepEqual(tree(candidate.payload), beforePayload);
  assert.ok(fs.existsSync(path.join(staging, 'payload/manifest.json'))); assert.ok(fs.existsSync(`${staging}.home23-stage.json`));
  assert.equal(fs.existsSync(path.join(staging, 'payload/.home23-install.json')), false);
  const cliStage = path.join(f.root, 'cli-stage');
  const reply = JSON.parse(execFileSync(process.execPath, ['scripts/product/host.mjs', 'stage', '--home', f.home, '--payload', candidate.payload, '--staging', cliStage], { encoding: 'utf8' }));
  assert.equal(reply.status, 'staged'); assert.equal(reply.canInstall, false);
  assert.deepEqual(tree(f.home), beforeHome); assert.deepEqual(tree(candidate.payload), beforePayload);
});

function interruptCopy(t, args) {
  const original = fs.copyFileSync; let copies = 0;
  fs.copyFileSync = (source, destination, flags) => {
    if (++copies === 2) { fs.writeFileSync(destination, 'partial', { flag: 'wx' }); throw new Error('Simulated copy interruption'); }
    return original(source, destination, flags);
  };
  try { assert.throws(() => stageProductPayload(args), /Simulated copy interruption/); }
  finally { fs.copyFileSync = original; }
  const claim = JSON.parse(fs.readFileSync(`${args.staging}.home23-stage.json`, 'utf8'));
  assert.equal(claim.status, 'copying'); assert.ok(fs.existsSync(path.join(args.staging, 'copy.tmp')));
  return claim;
}

test('resumes a simulated copy interruption with the same claim and rejects a changed candidate or baseline', t => {
  const f = fixture(t), staging = path.join(f.root, 'staging');
  const args = { homeRoot: f.home, candidatePayload: f.payload, staging };
  const claim = interruptCopy(t, args), before = tree(staging), changed = fixture(t, 'b'.repeat(40));
  assert.throws(() => stageProductPayload({ ...args, candidatePayload: changed.payload }), /claim/);
  assert.deepEqual(tree(staging), before);
  const resumed = stageProductPayload(args);
  assert.equal(resumed.status, 'staged'); assert.equal(resumed.receipt.id, claim.id);
  assert.equal(fs.existsSync(path.join(staging, 'copy.tmp')), false);
  assert.deepEqual(tree(path.join(staging, 'payload')), tree(f.payload));
  // A valid metadata-only installed release change is still a new baseline.
  const { packageId, ...body } = f.manifest; body.sourceCommit = 'c'.repeat(40);
  const newId = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(path.join(f.home, 'manifest.json'), JSON.stringify({ ...body, packageId: newId }));
  const receiptPath = path.join(f.home, '.home23-install.json'), receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, sourceCommit: body.sourceCommit, packageId: newId }));
  assert.throws(() => stageProductPayload(args), /baseline/);
  fs.appendFileSync(path.join(f.home, 'app/cli/home23.js'), 'local change');
  assert.throws(() => stageProductPayload(args), /eligible/);
});

test('refuses foreign, overlapping, linked, and locked stage destinations before copying', t => {
  const f = fixture(t), before = tree(f.home), args = { homeRoot: f.home, candidatePayload: f.payload };
  const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep'), 'keep');
  assert.throws(() => stageProductPayload({ ...args, staging: foreign }), /claim/);
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(`${foreign}.home23-stage.json`), false);
  fs.writeFileSync(`${foreign}.home23-stage.json`, 'private malformed contents', { mode: 0o600 });
  assert.throws(() => stageProductPayload({ ...args, staging: foreign }), error => error.message === 'Staging claim is unreadable or invalid.');
  assert.throws(() => stageProductPayload({ ...args, staging: path.join(f.home, 'stage') }), /separate/);
  const locked = path.join(f.root, 'locked-stage'); fs.writeFileSync(`${locked}.home23-stage.lock`, JSON.stringify({ pid: process.pid }));
  assert.throws(() => stageProductPayload({ ...args, staging: locked }), /already in progress/);
  assert.equal(fs.existsSync(`${locked}.home23-stage.json`), false); assert.equal(fs.existsSync(locked), false);
  const linked = path.join(f.root, 'linked'); fs.symlinkSync('missing', linked);
  assert.throws(() => stageProductPayload({ ...args, staging: path.join(linked, 'stage') }), /real directory/);
  assert.deepEqual(tree(f.home), before);
});

test('refuses tampered partial files and staged directories that redirect writes into the home', t => {
  const f = fixture(t), staging = path.join(f.root, 'staging'), args = { homeRoot: f.home, candidatePayload: f.payload, staging };
  interruptCopy(t, args);
  const before = tree(f.home);
  fs.appendFileSync(path.join(staging, 'payload/app/cli/home23.js'), 'tampered');
  assert.throws(() => stageProductPayload(args), /content changed/);
  fs.rmSync(path.join(staging, 'payload/app'), { recursive: true });
  fs.symlinkSync(path.join(f.home, 'app'), path.join(staging, 'payload/app'));
  assert.throws(() => stageProductPayload(args), /symlink|directory/);
  assert.deepEqual(tree(f.home), before);
});

test('capacity preflight leaves an owned retryable claim without copying package bytes', t => {
  const f = fixture(t), staging = path.join(f.root, 'staging'), args = { homeRoot: f.home, candidatePayload: f.payload, staging };
  const before = tree(f.home), statfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0n, bsize: 4096n });
  try { assert.throws(() => stageProductPayload(args), /Insufficient free space/); }
  finally { fs.statfsSync = statfs; }
  assert.deepEqual(fs.readdirSync(path.join(staging, 'payload')), []);
  assert.equal(JSON.parse(fs.readFileSync(`${staging}.home23-stage.json`, 'utf8')).status, 'copying');
  assert.equal(stageProductPayload(args).status, 'staged');
  assert.deepEqual(tree(f.home), before);
});
