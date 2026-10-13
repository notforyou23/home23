const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MemoryIngest } = require('../../../engine/src/channels/memory-ingest.cjs');

test('MemoryIngest defaults to an active object cap when no explicit max is set', (t) => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ingest-default-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const previous = process.env.HOME23_MEMORY_OBJECTS_ACTIVE_LIMIT;
  delete process.env.HOME23_MEMORY_OBJECTS_ACTIVE_LIMIT;
  try {
    const ingest = new MemoryIngest({
      brainDir,
      logger: { warn() {} },
    });
    assert.equal(ingest.maxObjects, 2500);
  } finally {
    if (previous === undefined) delete process.env.HOME23_MEMORY_OBJECTS_ACTIVE_LIMIT;
    else process.env.HOME23_MEMORY_OBJECTS_ACTIVE_LIMIT = previous;
  }
});

test('MemoryIngest compacts oversized active store into append-only archive', (t) => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ingest-cap-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const ingest = new MemoryIngest({
    brainDir,
    logger: { warn() {} },
    maxObjects: 3,
  });
  const store = {
    objects: Array.from({ length: 5 }, (_, i) => ({
      memory_id: `mo-${i}`,
      created_at: `2026-05-09T00:0${i}:00.000Z`,
    })),
  };

  const archived = [];
  const compacted = ingest.compactActiveStoreForWrite(store, (object) => archived.push(object));

  assert.deepEqual(archived.map((object) => object.memory_id), ['mo-0', 'mo-1']);
  assert.deepEqual(compacted.objects.map((object) => object.memory_id), ['mo-2', 'mo-3', 'mo-4']);
});

test('MemoryIngest preserves durable owner facts and superseded history when archiving overflow', (t) => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ingest-owner-facts-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const ingest = new MemoryIngest({ brainDir, logger: { warn() {} }, maxObjects: 2 });
  const owner = (id, status) => ({
    memory_id: id, created_at: '2026-05-01T00:00:00.000Z', lifecycle_layer: 'durable', status,
    provenance: { generation_method: 'owner_conversation' },
  });
  const store = { objects: [owner('owner-old', 'superseded'), owner('owner-current', 'approved'),
    { memory_id: 'bus-old', created_at: '2026-05-02T00:00:00.000Z' },
    { memory_id: 'bus-new', created_at: '2026-05-03T00:00:00.000Z' }] };
  const archived = [];
  const compacted = ingest.compactActiveStoreForWrite(store, object => archived.push(object));
  assert.deepEqual(archived.map(object => object.memory_id), ['bus-old', 'bus-new']);
  assert.deepEqual(compacted.objects.map(object => object.memory_id), ['owner-old', 'owner-current']);
  assert.deepEqual(ingest.compactActiveStoreForWrite({ objects: [...compacted.objects, owner('owner-third', 'approved')] }).objects
    .map(object => object.memory_id), ['owner-old', 'owner-current', 'owner-third']);
});

test('MemoryIngest startup compaction rewrites active store and archives older objects', async () => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ingest-compact-'));
  const ingest = new MemoryIngest({
    brainDir,
    logger: { info() {}, warn() {} },
    maxObjects: 2,
  });
  const objects = Array.from({ length: 4 }, (_, i) => ({
    memory_id: `mo-${i}`,
    created_at: `2026-05-09T00:0${i}:00.000Z`,
  }));
  fs.writeFileSync(path.join(brainDir, 'memory-objects.json'), JSON.stringify({ objects }));

  const result = await ingest.compactActiveStore({ reason: 'startup-test' });
  const active = JSON.parse(fs.readFileSync(path.join(brainDir, 'memory-objects.json'), 'utf8'));
  const archiveLines = fs.readFileSync(path.join(brainDir, 'memory-objects.archive.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.deepEqual(result, { archived: 2, active: 2 });
  assert.deepEqual(active.objects.map((object) => object.memory_id), ['mo-2', 'mo-3']);
  assert.deepEqual(archiveLines.map((entry) => entry.object.memory_id), ['mo-0', 'mo-1']);
});
