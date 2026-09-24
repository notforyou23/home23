'use strict';

const fs = require('node:fs').promises;
const lockfile = require('proper-lockfile');

const LOCK_OPTIONS = {
  stale: 30_000,
  update: 5_000,
  retries: { retries: 60, minTimeout: 50, maxTimeout: 500 },
};

// The curator reads candidates before rendering workspace surfaces. Other
// writers can update that shared store during the render, so merge only the
// exact candidates the curator saw back into the current file under its lock.
async function markCuratorObjectsReviewed(objectsPath, processedObjects) {
  if (!processedObjects.length) return 0;
  const expected = new Map(processedObjects.map(object => [object.memory_id, JSON.stringify(object)]));
  const release = await lockfile.lock(objectsPath, LOCK_OPTIONS);
  try {
    const store = JSON.parse(await fs.readFile(objectsPath, 'utf8'));
    if (!Array.isArray(store.objects)) throw new Error('memory object store has no objects array');
    let marked = 0;
    for (const object of store.objects) {
      if (object.status !== 'candidate' || object.lifecycle_layer !== 'working') continue;
      if (expected.get(object.memory_id) !== JSON.stringify(object)) continue;
      object.status = 'self_reviewed';
      object.review_state = 'self_reviewed';
      marked++;
    }
    if (marked) await fs.writeFile(objectsPath, JSON.stringify(store, null, 2));
    return marked;
  } finally {
    await release();
  }
}

module.exports = { markCuratorObjectsReviewed };
