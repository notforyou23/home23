'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VaultManifest, MANIFEST_SCHEMA } = require('../../scripts/vault/vault-manifest.cjs');

const SHA_A = 'a'.repeat(64);   // real digests: Task 5 seeds HashIndex straight from this
const SHA_Z = 'f'.repeat(64);   // manifest, and seed() rejects anything that isn't one.

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-manifest-'));
}

test('records a document with origin, hash, and type', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  m.record({ vaultPath: 'voice/voice-2026-03-04.md', sha256: SHA_A, type: 'voice', origins: ['/src/voice-2026-03-04.md'], bytes: 120 });
  const e = m.get('voice/voice-2026-03-04.md');
  assert.equal(e.sha256, SHA_A);
  assert.equal(e.type, 'voice');
  assert.deepEqual(e.origins, ['/src/voice-2026-03-04.md']);
});

test('a deduped document accumulates multiple origins', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  m.record({ vaultPath: 'voice/v.md', sha256: SHA_A, type: 'voice', origins: ['/a/v.md'], bytes: 10 });
  m.record({ vaultPath: 'voice/v.md', sha256: SHA_A, type: 'voice', origins: ['/b/v.md'], bytes: 10 });
  assert.deepEqual(m.get('voice/v.md').origins, ['/a/v.md', '/b/v.md']);
});

test('round-trips through disk with schema', () => {
  const p = path.join(tmpdir(), 'vault-manifest.json');
  const m = new VaultManifest(p);
  m.record({ vaultPath: 'notes/n.md', sha256: SHA_Z, type: 'notes', origins: ['/o/n.md'], bytes: 5 });
  m.save();
  const loaded = new VaultManifest(p);
  assert.equal(loaded.get('notes/n.md').sha256, SHA_Z);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).schema, MANIFEST_SCHEMA);
});

test('record() rejects a non-digest sha256', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: undefined, type: 'notes', origins: ['/o/n.md'], bytes: 5 }),
    TypeError
  );
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: 'not-a-hash', type: 'notes', origins: ['/o/n.md'], bytes: 5 }),
    TypeError
  );
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: SHA_A.toUpperCase(), type: 'notes', origins: ['/o/n.md'], bytes: 5 }),
    TypeError
  );
});

test('record() rejects a type outside TYPES', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: SHA_A, type: 'bogus', origins: ['/o/n.md'], bytes: 5 }),
    TypeError
  );
});

test('record() rejects empty or missing origins', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: SHA_A, type: 'notes', origins: [], bytes: 5 }),
    TypeError
  );
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: SHA_A, type: 'notes', origins: undefined, bytes: 5 }),
    TypeError
  );
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: SHA_A, type: 'notes', origins: [''], bytes: 5 }),
    TypeError
  );
});

test('record() rejects a non-integer or negative byte count', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: SHA_A, type: 'notes', origins: ['/o/n.md'], bytes: -1 }),
    TypeError
  );
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: SHA_A, type: 'notes', origins: ['/o/n.md'], bytes: '5' }),
    TypeError
  );
});

test('throws loudly when two different contents claim the same vault path', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  m.record({ vaultPath: 'notes/n.md', sha256: SHA_A, type: 'notes', origins: ['/a/n.md'], bytes: 5 });
  assert.throws(
    () => m.record({ vaultPath: 'notes/n.md', sha256: SHA_Z, type: 'notes', origins: ['/b/n.md'], bytes: 5 }),
    /collision/i
  );
  // the original entry must survive the rejected write untouched
  assert.deepEqual(m.get('notes/n.md').origins, ['/a/n.md']);
  assert.equal(m.get('notes/n.md').sha256, SHA_A);
});

test('get() returns a defensive copy -- mutating it must not corrupt the manifest', () => {
  const m = new VaultManifest(path.join(tmpdir(), 'vault-manifest.json'));
  m.record({ vaultPath: 'notes/n.md', sha256: SHA_A, type: 'notes', origins: ['/o/n.md'], bytes: 5 });
  const e = m.get('notes/n.md');
  e.origins.push('/tampered/path.md');
  e.sha256 = 'tampered';
  assert.deepEqual(m.get('notes/n.md').origins, ['/o/n.md']);
  assert.equal(m.get('notes/n.md').sha256, SHA_A);
});

test('refuses to load a manifest with a mismatched or missing schema', () => {
  const p = path.join(tmpdir(), 'vault-manifest.json');
  fs.writeFileSync(p, JSON.stringify({ schema: 'some.other.schema', entries: {} }));
  assert.throws(() => new VaultManifest(p), /schema/i);

  const p2 = path.join(tmpdir(), 'vault-manifest.json');
  fs.writeFileSync(p2, JSON.stringify({ entries: {} }));
  assert.throws(() => new VaultManifest(p2), /schema/i);
});

test('save() is atomic: a failed rename leaves the previous manifest intact', () => {
  const p = path.join(tmpdir(), 'vault-manifest.json');
  const m = new VaultManifest(p);
  m.record({ vaultPath: 'notes/n.md', sha256: SHA_A, type: 'notes', origins: ['/o/n.md'], bytes: 5 });
  m.save();
  const before = fs.readFileSync(p, 'utf8');

  m.record({ vaultPath: 'notes/n2.md', sha256: SHA_Z, type: 'notes', origins: ['/o/n2.md'], bytes: 6 });
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated crash mid-write'); };
  try {
    assert.throws(() => m.save());
  } finally {
    fs.renameSync = originalRename;
  }
  const after = fs.readFileSync(p, 'utf8');
  assert.equal(after, before, 'manifest on disk must be unchanged if the atomic rename fails');

  // no leaked temp file in the directory
  const leftovers = fs.readdirSync(path.dirname(p)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});
