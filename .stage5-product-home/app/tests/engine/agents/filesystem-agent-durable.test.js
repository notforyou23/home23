import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileSystemAgent } = require('../../../engine/src/agents/execution/filesystem-agent.js');

const logger = { info() {}, error() {}, debug() {} };

test('FileSystemAgent writeFile returns durable verified receipt metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-fs-agent-'));
  const target = join(dir, 'artifact.txt');
  const agent = new FileSystemAgent(null, logger);

  const result = await agent.writeFile(target, 'one\n');

  assert.equal(result.success, true);
  assert.equal(readFileSync(target, 'utf8'), 'one\n');
  assert.equal(result.length, 4);
  assert.equal(result.durability?.verified, true);
  assert.equal(result.durability?.fileSynced, true);
  assert.equal(result.durability?.bytes, 4);
});

test('FileSystemAgent append mode is durable and reports final byte count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-fs-agent-append-'));
  const target = join(dir, 'artifact.txt');
  const agent = new FileSystemAgent(null, logger);

  await agent.writeFile(target, 'one\n');
  const result = await agent.writeFile(target, 'two\n', 'append');

  assert.equal(result.success, true);
  assert.equal(readFileSync(target, 'utf8'), 'one\ntwo\n');
  assert.equal(result.length, 8);
  assert.equal(result.durability?.verified, true);
  assert.equal(result.durability?.bytes, 8);
});
