import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertProductNodeVersion, installProductPayload, readProductManifest, verifyProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import { inspectProductNode } from '../../scripts/product/package.mjs';
import { previewProductUpdate } from '../../cli/lib/product-update-preview.js';
import { adoptVerifiedStage, stageProductPayload } from '../../cli/lib/product-update-stage.js';
import { applyProductUpdate, readUpdateJournal } from '../../cli/lib/product-update-apply.js';

function legacyManifest(root) {
  const file = path.join(root, 'manifest.json');
  const { packageId, ...body } = JSON.parse(fs.readFileSync(file, 'utf8'));
  body.nodeVersion = 'v22.19.0';
  const manifest = { ...body, packageId: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  fs.writeFileSync(file, JSON.stringify(manifest));
  return manifest;
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-node-floor-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload'), home = path.join(root, 'home'), staging = path.join(root, 'stage');
  for (const name of ['bin/node', 'app/cli/home23.js', 'app/cli/lib/product-payload.js', 'app/scripts/product/host.mjs', 'tools/node_modules/pm2/bin/pm2']) {
    const file = path.join(payload, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, 'fixture\n', { mode: name === 'bin/node' ? 0o755 : 0o644 });
  }
  writeProductManifest(payload, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.4' });
  installProductPayload({ payloadPath: payload, homeRoot: home });
  return { root, payload, home, staging };
}

test('new product Node requires a stable patched Node 22 version', () => {
  for (const version of ['v22.23.4', 'v22.23.10', 'v22.24.0']) assert.doesNotThrow(() => assertProductNodeVersion(version));
  for (const version of ['v22.19.0', 'v22.23.3', 'v22.9.99', 'v24.22.1', 'v22.23.4-rc.1', 'v22.23.4junk', 'v22.023.4', null]) {
    assert.throws(() => assertProductNodeVersion(version), { code: 'candidate_node_unsupported' }, String(version));
  }
});

test('packager checks the actual binary version and manifest creation refuses before writing', t => {
  const f = fixture(t), node = path.join(f.root, 'old-node');
  const metadata = JSON.stringify({ platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.3' });
  fs.writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' '${metadata}'\n`, { mode: 0o755 });
  assert.throws(() => inspectProductNode(node), { code: 'candidate_node_unsupported' });
  const missing = path.join(f.root, 'not-created');
  assert.throws(() => writeProductManifest(missing, { nodeVersion: 'v22.19.0' }), { code: 'candidate_node_unsupported' });
  assert.equal(fs.existsSync(missing), false);
});

test('historical manifests remain readable but cannot become new installations or stages', t => {
  const f = fixture(t), legacy = legacyManifest(f.payload);
  assert.equal(readProductManifest(f.payload).packageId, legacy.packageId);
  assert.equal(verifyProductPayload(f.payload).nodeVersion, 'v22.19.0');
  const nextHome = path.join(f.root, 'new-home');
  assert.throws(() => installProductPayload({ payloadPath: f.payload, homeRoot: nextHome }), { code: 'candidate_node_unsupported' });
  assert.equal(fs.existsSync(nextHome), false);
  assert.equal(previewProductUpdate({ homeRoot: f.home, candidatePayload: f.payload }, { verifyFiles: false }).reasons[0].code, 'candidate_node_unsupported');
  assert.throws(() => stageProductPayload({ homeRoot: f.home, candidatePayload: f.payload, staging: f.staging }), /not eligible/);
  assert.equal(fs.existsSync(f.staging), false);
});

test('trusted stages and update admission cannot bypass the runtime floor', async t => {
  const f = fixture(t);
  stageProductPayload({ homeRoot: f.home, candidatePayload: f.payload, staging: f.staging });
  const candidate = path.join(f.staging, 'payload');
  const legacy = legacyManifest(candidate);
  const claimFile = `${f.staging}.home23-stage.json`, claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
  fs.writeFileSync(claimFile, JSON.stringify({ ...claim, candidatePackageId: legacy.packageId }), { mode: 0o600 });
  assert.throws(() => adoptVerifiedStage({ homeRoot: f.home, staging: f.staging, trustStagedReceipt: true }), /not eligible/);
  for (const reuseVerifiedStage of [false, true]) {
    const result = await applyProductUpdate({ homeRoot: f.home, candidatePayload: candidate,
      staging: reuseVerifiedStage ? f.staging : path.join(f.root, 'another-stage'), reuseVerifiedStage }, {
      listProcesses: async () => { throw new Error('Must reject before checking or stopping services'); },
    });
    assert.equal(result.status, 'refused');
    assert.equal(result.reasons[0].code, 'candidate_node_unsupported');
    assert.equal(readUpdateJournal(f.home), null);
  }
});
