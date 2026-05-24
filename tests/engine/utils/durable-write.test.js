import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeFileDurableSync, writeFileDurable } = require('../../../engine/src/utils/durable-write.js');

test('writeFileDurableSync writes, fsyncs, renames, and verifies bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-durable-sync-'));
  const target = join(dir, 'nested', 'artifact.txt');

  const receipt = writeFileDurableSync(target, 'VERIFIED\n');

  assert.equal(readFileSync(target, 'utf8'), 'VERIFIED\n');
  assert.equal(receipt.path, target);
  assert.equal(receipt.bytes, 9);
  assert.equal(receipt.exists, true);
  assert.equal(receipt.fileSynced, true);
  assert.equal(receipt.verified, true);
  assert.equal(readdirSync(join(dir, 'nested')).some((name) => name.includes('.tmp-')), false);
});

test('writeFileDurable writes, fsyncs, renames, and verifies bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-durable-async-'));
  const target = join(dir, 'artifact.json');

  const receipt = await writeFileDurable(target, '{"ok":true}\n');

  assert.equal(readFileSync(target, 'utf8'), '{"ok":true}\n');
  assert.equal(receipt.path, target);
  assert.equal(receipt.bytes, 12);
  assert.equal(receipt.exists, true);
  assert.equal(receipt.fileSynced, true);
  assert.equal(receipt.verified, true);
  assert.equal(existsSync(`${target}.tmp`), false);
});
