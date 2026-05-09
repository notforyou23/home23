const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_GZIP_LEVEL,
  readJsonlGz,
  writeJsonlGz,
} = require('../../../engine/src/core/memory-sidecar');

test('writeJsonlGz supports overlapping writes to the same output path', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'memory-sidecar-overlap-'));
  const outPath = path.join(dir, 'memory-nodes.jsonl.gz');
  const first = Array.from({ length: 1500 }, (_, i) => ({ id: `a${i}`, value: 'first' }));
  const second = Array.from({ length: 1500 }, (_, i) => ({ id: `b${i}`, value: 'second' }));

  const results = await Promise.allSettled([
    writeJsonlGz(outPath, first),
    writeJsonlGz(outPath, second),
  ]);

  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);

  const readResult = await readJsonlGz(outPath, () => {});
  assert.equal(readResult.count, 1500);
  assert.equal(readResult.parseErrors, 0);

  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeJsonlGz defaults to speed-oriented gzip for hot engine saves', () => {
  assert.equal(DEFAULT_GZIP_LEVEL, 1);
});
