import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceStatus } from '../../scripts/release/source-status.mjs';

test('source check distinguishes deployment drift from working edits without mutating either', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-source-authority-'));
  const write = (file, data) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data)); };
  try {
    for (const name of ['backend', 'apple']) {
      fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'source.txt'), 'original');
      write(`${name}.json`, [{ path: 'source.txt', sha256: createHash('sha256').update('original').digest('hex') }]);
    }
    write('instances/.house/source-authority.json', { schemaVersion: 1, deployedReleaseId: 'current', appleContractSHA256: 'pack', development: { backend: path.join(root, 'backend'), apple: path.join(root, 'apple') }, sourceManifests: { backend: path.join(root, 'backend.json'), apple: path.join(root, 'apple.json') }, preservation: root });
    write('instances/.house/coordination/active-release.json', { releaseId: 'current' });
    write('instances/.house/home23-ios.json', { sourceRoot: path.join(root, 'apple'), contractSHA256: 'pack', installedBuild: 119 });
    assert.equal(sourceStatus(root).ok, true);
    fs.writeFileSync(path.join(root, 'backend/source.txt'), 'working edit');
    assert.deepEqual(sourceStatus(root).changesSinceReconciledBaseline.backend, ['source.txt']);
    write('instances/.house/coordination/active-release.json', { releaseId: 'newer' });
    assert.equal(sourceStatus(root).ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'backend/source.txt'), 'utf8'), 'working edit');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
