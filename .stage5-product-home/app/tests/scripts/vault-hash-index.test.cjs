'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashFile, HashIndex } = require('../../scripts/vault/hash-index.cjs');

function tmpfile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-hash-'));
  const p = path.join(dir, 'f.md');
  fs.writeFileSync(p, content);
  return p;
}

test('hashFile is stable and content-addressed', () => {
  const a = tmpfile('hello jtr');
  const b = tmpfile('hello jtr');
  assert.equal(hashFile(a), hashFile(b));
  assert.match(hashFile(a), /^[0-9a-f]{64}$/);
});

test('different content hashes differently', () => {
  assert.notEqual(hashFile(tmpfile('a')), hashFile(tmpfile('b')));
});

test('index reports first-seen vs duplicate, and records every origin', () => {
  const h = 'f'.repeat(64);
  const idx = new HashIndex();
  assert.equal(idx.recordSighting(h, '/origin/one.md').firstSighting, true);
  assert.equal(idx.recordSighting(h, '/origin/two.md').firstSighting, false);
  assert.deepEqual(idx.origins(h), ['/origin/one.md', '/origin/two.md']);
});

test('hashFile throws on unreadable input rather than returning a falsy hash', () => {
  // LOAD-BEARING: if hashFile ever returns null instead of throwing, every
  // unreadable file shares one Map key and the walker treats N distinct
  // documents as duplicates of one -- copying 1 and silently losing N-1.
  assert.throws(() => hashFile('/nonexistent/definitely/not/here.md'), /ENOENT/);
  assert.throws(() => hashFile(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-dir-'))), /EISDIR/);
});

test('rejects a non-hash key instead of bucketing unrelated documents together', () => {
  const idx = new HashIndex();
  assert.throws(() => idx.recordSighting(undefined, '/a.md'), TypeError);
  assert.throws(() => idx.recordSighting(null, '/a.md'), TypeError);
  assert.throws(() => idx.recordSighting('short', '/a.md'), TypeError);
  assert.throws(() => idx.recordSighting('A'.repeat(64), '/a.md'), TypeError); // uppercase
  assert.throws(() => idx.recordSighting('a'.repeat(64), ''), TypeError);
});

test('origins() copy cannot corrupt internal provenance', () => {
  const h = 'a'.repeat(64);
  const idx = new HashIndex();
  idx.recordSighting(h, '/one.md');
  idx.origins(h).push('/FORGED.md');
  assert.deepEqual(idx.origins(h), ['/one.md']);
});

test('has() is read-only -- checking never forges an origin', () => {
  const h = 'b'.repeat(64);
  const idx = new HashIndex();
  idx.recordSighting(h, '/one.md');
  assert.equal(idx.has(h), true);
  assert.equal(idx.has('c'.repeat(64)), false);
  assert.deepEqual(idx.origins(h), ['/one.md']);
});

test('seed restores the FULL origin list from a prior run', () => {
  const h = 'd'.repeat(64);
  const idx = new HashIndex();
  idx.seed(h, ['/src1/a.md', '/src2/a.md', '/src3/a.md']);
  assert.deepEqual(idx.origins(h), ['/src1/a.md', '/src2/a.md', '/src3/a.md']);
  assert.equal(idx.recordSighting(h, '/src4/a.md').firstSighting, false);
  assert.equal(idx.origins(h).length, 4);
  assert.throws(() => idx.seed(h, []), TypeError);
  assert.throws(() => idx.seed(h, [undefined]), TypeError);
});

test('one content seen in three installs keeps all three origins', () => {
  // Real shape: cosmo-home + cosmo-home_2.3 + life all hold the same file.
  const h = 'e'.repeat(64);
  const idx = new HashIndex();
  assert.equal(idx.recordSighting(h, '/cosmo-home/a.md').firstSighting, true);
  assert.equal(idx.recordSighting(h, '/cosmo-home_2.3/a.md').firstSighting, false);
  assert.equal(idx.recordSighting(h, '/life/a.md').firstSighting, false);
  assert.deepEqual(idx.origins(h), ['/cosmo-home/a.md', '/cosmo-home_2.3/a.md', '/life/a.md']);
});

test('different hashes never cross-contaminate', () => {
  const idx = new HashIndex();
  idx.recordSighting('1'.repeat(64), '/x.md');
  idx.recordSighting('2'.repeat(64), '/y.md');
  assert.deepEqual(idx.origins('1'.repeat(64)), ['/x.md']);
  assert.deepEqual(idx.origins('2'.repeat(64)), ['/y.md']);
  assert.equal(idx.hashes().length, 2);
});
