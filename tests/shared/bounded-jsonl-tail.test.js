import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readRecentJsonlTail } = require('../../shared/bounded-jsonl-tail.cjs');

test('bounded JSONL tail reads only the recent byte window in newest-first order', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-jsonl-tail-'));
  const file = path.join(dir, 'thoughts.jsonl');
  await fsp.writeFile(file, `${JSON.stringify({ old: 'x'.repeat(1024 * 1024) })}\n`);
  await fsp.appendFile(file, `${JSON.stringify({ id: 1 })}\n${JSON.stringify({ id: 2 })}\n`);
  const rows = await readRecentJsonlTail(file, {
    limit: 2,
    maxBytes: 256,
    maxLineBytes: 128,
  });
  assert.deepEqual(rows, [{ id: 2 }, { id: 1 }]);
});

test('bounded JSONL tail rejects invalid limits, oversized recent records, and cancellation', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-jsonl-tail-'));
  const file = path.join(dir, 'thoughts.jsonl');
  await fsp.writeFile(file, `${JSON.stringify({ text: 'x'.repeat(512) })}\n`);
  await assert.rejects(
    () => readRecentJsonlTail(file, { limit: 0 }),
    { code: 'invalid_request', status: 400 },
  );
  await assert.rejects(
    () => readRecentJsonlTail(file, { limit: 1, maxBytes: 1024, maxLineBytes: 64 }),
    { code: 'result_too_large', status: 413 },
  );
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop'), { code: 'cancelled' });
  controller.abort(reason);
  await assert.rejects(
    () => readRecentJsonlTail(file, { signal: controller.signal }),
    (error) => error === reason,
  );
});
