'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { consolidate } = require('../../scripts/vault/consolidate.cjs');
const { coverageReport } = require('../../scripts/vault/coverage-report.cjs');

test('every source document is accounted for in the vault manifest', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cov-')));
  const src = path.join(root, 'src', 'voice');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'aaa');
  fs.writeFileSync(path.join(src, 'b.md'), 'bbb');
  const vault = path.join(root, 'vault');
  consolidate({ sources: [path.join(root, 'src')], vaultRoot: vault });

  const rep = coverageReport({ sources: [path.join(root, 'src')], vaultRoot: vault });
  assert.equal(rep.sourceDocs, 2);
  assert.equal(rep.accountedFor, 2);
  assert.deepEqual(rep.missing, []);
});

test('an unconsolidated document is reported as missing, not ignored', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cov2-')));
  const src = path.join(root, 'src', 'voice');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'aaa');
  const vault = path.join(root, 'vault');
  consolidate({ sources: [path.join(root, 'src')], vaultRoot: vault });
  fs.writeFileSync(path.join(src, 'late.md'), 'arrived after consolidation');

  const rep = coverageReport({ sources: [path.join(root, 'src')], vaultRoot: vault });
  assert.equal(rep.missing.length, 1);
  assert.match(rep.missing[0], /late\.md$/);
});

test('a deliberately excluded document (event exhaust) is counted as excluded, never as missing', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cov3-')));
  const src = path.join(root, 'src');
  const persist = path.join(src, 'workspace', 'persist');
  fs.mkdirSync(persist, { recursive: true });
  fs.writeFileSync(path.join(persist, 'sync-state.md'), 'scheduled-sync-state auto sync, 1 file changed');
  const vault = path.join(root, 'vault');
  consolidate({ sources: [src], vaultRoot: vault });

  const rep = coverageReport({ sources: [src], vaultRoot: vault });
  assert.equal(rep.sourceDocs, 1);
  assert.equal(rep.excluded, 1);
  assert.equal(rep.accountedFor, 0);
  assert.deepEqual(rep.missing, [], 'excluded material must never appear in missing');
});

test('a hash match alone does not certify coverage -- only a recorded origin does', () => {
  // Constructs a manifest by hand (bypassing consolidate()) where a vault
  // file's bytes match a source document's content, but that document's
  // OWN origin was never recorded. A pure content-hash fallback would call
  // this "accounted for"; it must not, because the document's provenance
  // was genuinely never captured.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cov4-')));
  const src = path.join(root, 'src', 'voice');
  fs.mkdirSync(src, { recursive: true });
  const originPath = path.join(src, 'orphan.md');
  fs.writeFileSync(originPath, 'shared content, unrecorded origin');

  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, 'voice'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'voice', 'other-origin.md'), 'shared content, unrecorded origin');
  const { VaultManifest } = require('../../scripts/vault/vault-manifest.cjs');
  const { hashFile } = require('../../scripts/vault/hash-index.cjs');
  const manifest = new VaultManifest(path.join(vault, 'vault-manifest.json'));
  manifest.record({
    vaultPath: 'voice/other-origin.md',
    sha256: hashFile(path.join(vault, 'voice', 'other-origin.md')),
    type: 'voice',
    origins: [path.join(src, 'some-other-file-that-really-produced-this.md')],
    bytes: fs.statSync(path.join(vault, 'voice', 'other-origin.md')).size,
  });
  manifest.save();

  const rep = coverageReport({ sources: [path.join(root, 'src')], vaultRoot: vault });
  assert.equal(rep.missing.length, 1, 'orphan.md must be reported missing despite matching vault bytes elsewhere');
  assert.match(rep.missing[0], /orphan\.md$/);
});

test('a vault file deleted after consolidation is flagged, not silently absent from the report', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cov5-')));
  const src = path.join(root, 'src', 'voice');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'aaa');
  const vault = path.join(root, 'vault');
  consolidate({ sources: [src], vaultRoot: vault });
  fs.rmSync(path.join(vault, 'voice', 'a.md'));

  const rep = coverageReport({ sources: [src], vaultRoot: vault });
  assert.deepEqual(rep.vaultFilesMissing, ['voice/a.md']);
});

test('a vault file whose bytes were altered after consolidation is flagged as corrupted', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-cov6-')));
  const src = path.join(root, 'src', 'voice');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'aaa');
  const vault = path.join(root, 'vault');
  consolidate({ sources: [src], vaultRoot: vault });
  fs.writeFileSync(path.join(vault, 'voice', 'a.md'), 'tampered bytes');

  const rep = coverageReport({ sources: [src], vaultRoot: vault });
  assert.deepEqual(rep.vaultFilesCorrupted, ['voice/a.md']);
});
