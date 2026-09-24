const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { markCuratorObjectsReviewed } = require('../../../engine/src/core/curator-memory-objects');

test('curator merges only unchanged reviewed candidates into the current shared store', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-curator-objects-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory-objects.json');
  const candidate = id => ({ memory_id: id, lifecycle_layer: 'working', status: 'candidate', review_state: 'unreviewed', statement: id });
  const first = candidate('first');
  const changed = candidate('changed');
  const concurrent = candidate('concurrent');
  const current = { schema: 'keep-this-field', objects: [first, { ...changed, statement: 'new evidence' }, concurrent] };
  fs.writeFileSync(file, JSON.stringify(current));

  assert.equal(await markCuratorObjectsReviewed(file, [first, changed]), 1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schema, current.schema);
  assert.equal(saved.objects.length, 3);
  assert.equal(saved.objects[0].status, 'self_reviewed');
  assert.equal(saved.objects[0].review_state, 'self_reviewed');
  assert.equal(saved.objects[1].status, 'candidate');
  assert.equal(saved.objects[1].statement, 'new evidence');
  assert.equal(saved.objects[2].status, 'candidate');
});
