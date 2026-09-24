import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashFile } from '../../cli/lib/product-update-inventory.js';

test('update hashes read-only state beyond the whole-file Buffer limit', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-large-state-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.bin');
  const zeroBytes = 2 ** 31;
  const tail = Buffer.from('Home23 large state');
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    // A sparse fixture exercises the actual size limit without allocating 2 GiB.
    fs.ftruncateSync(descriptor, zeroBytes);
    fs.writeSync(descriptor, tail, 0, tail.length, zeroBytes);
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(file, 0o400);
  const expected = createHash('sha256');
  const zeros = Buffer.alloc(1024 * 1024);
  for (let count = 0; count < zeroBytes / zeros.length; count++) expected.update(zeros);
  expected.update(tail);
  assert.equal(hashFile(file), expected.digest('hex'));
  assert.equal(fs.statSync(file).size, zeroBytes + tail.length);
  assert.equal(fs.statSync(file).mode & 0o777, 0o400);
});
