const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { StateCompression } = require('../../../engine/src/core/state-compression');

test('saveCompressed supports overlapping writes to the same state path', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'state-compression-overlap-'));
  const statePath = path.join(dir, 'state.json');

  const results = await Promise.allSettled([
    StateCompression.saveCompressed(statePath, { marker: 'first', memory: { nodes: [], edges: [] } }),
    StateCompression.saveCompressed(statePath, { marker: 'second', memory: { nodes: [], edges: [] } }),
  ]);

  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);

  const loaded = await StateCompression.loadCompressed(statePath);
  assert.ok(['first', 'second'].includes(loaded.marker));

  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});
