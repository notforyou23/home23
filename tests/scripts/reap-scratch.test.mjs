import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reapScratch } from '../../scripts/reap-scratch.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-scratch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratch = path.join(root, 'instances', 'jerry', 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  return scratch;
}

function backdate(filePath, daysAgo) {
  const ms = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  fs.utimesSync(filePath, ms / 1000, ms / 1000);
}

test('reapScratch removes only files past max age, and empty dirs left behind', (t) => {
  const scratch = fixture(t);
  const old = path.join(scratch, 'old-probe.mjs');
  const fresh = path.join(scratch, 'fresh-capture.txt');
  const nested = path.join(scratch, 'sub', 'old-nested.log');
  fs.writeFileSync(old, 'x'.repeat(10));
  fs.writeFileSync(fresh, 'y');
  fs.mkdirSync(path.dirname(nested));
  fs.writeFileSync(nested, 'z'.repeat(5));
  backdate(old, 10);
  backdate(nested, 10);

  const summary = reapScratch(scratch, 7);

  assert.equal(summary.filesRemoved, 2);
  assert.equal(summary.bytesFreed, 15);
  assert.equal(summary.dirsRemoved, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(nested), false);
  assert.equal(fs.existsSync(path.dirname(nested)), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(scratch), true, 'scratch root itself is never removed');
  assert.deepEqual(summary.errors, []);
});

test('reapScratch is a no-op on a missing directory', () => {
  const summary = reapScratch('/nonexistent/instances/jerry/scratch', 7);
  assert.equal(summary.filesRemoved, 0);
  assert.equal(summary.dirsRemoved, 0);
});

test('reapScratch refuses a path not literally named scratch', () => {
  assert.throws(() => reapScratch('/tmp/not-scratch', 7), /refusing to reap/);
});
