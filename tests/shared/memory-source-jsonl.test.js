import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readJsonlRange } = require('../../shared/memory-source');

test('readJsonlRange reads only a complete byte interval', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-jsonl-range-'));
  const file = path.join(dir, 'delta.jsonl');
  const first = `${JSON.stringify({ sequence: 1 })}\n`;
  const second = `${JSON.stringify({ sequence: 2 })}\n`;
  await fsp.writeFile(file, first + second);

  const rows = [];
  for await (const row of readJsonlRange(file, {
    confinedRoot: dir,
    startByte: Buffer.byteLength(first),
    endByte: Buffer.byteLength(first + second),
  })) rows.push(row);

  assert.deepEqual(rows, [{ sequence: 2 }]);
});

test('readJsonlRange rejects a mid-record boundary', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-jsonl-range-'));
  const file = path.join(dir, 'delta.jsonl');
  await fsp.writeFile(file, '{"sequence":1}\n');
  await assert.rejects(async () => {
    for await (const _row of readJsonlRange(file, {
      confinedRoot: dir,
      startByte: 3,
      endByte: 15,
    })) {}
  }, { code: 'source_unavailable' });
});
