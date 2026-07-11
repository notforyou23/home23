'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const {
  createOperationScratchQuota,
  projectLegacyResidentSidecars,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

const RECORDS = 750;
const ID_PADDING_BYTES = 64 * 1024;

async function main() {
  if (typeof global.gc !== 'function') {
    throw new Error('heap probe requires --expose-gc');
  }
  const targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-legacy-heap-target-'));
  const operationRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-legacy-heap-operation-'));
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 512 * 1024 * 1024,
  });
  try {
    const padding = 'x'.repeat(ID_PADDING_BYTES);
    await writeJsonlGzAtomic(
      path.join(targetRoot, 'memory-nodes.jsonl.gz'),
      (async function* baseNodes() {
        for (let index = 0; index < 10; index += 1) {
          yield { id: `node-${String(index).padStart(4, '0')}-${padding}`, value: -1 };
        }
      })(),
    );
    await writeJsonlGzAtomic(path.join(targetRoot, 'memory-edges.jsonl.gz'), []);
    const delta = await fsp.open(path.join(targetRoot, 'memory-delta.jsonl'), 'wx', 0o600);
    try {
      for (let index = 0; index < RECORDS; index += 1) {
        const row = {
          op: 'upsert_node',
          record: { id: `node-${String(index).padStart(4, '0')}-${padding}`, value: index },
        };
        await delta.writeFile(`${JSON.stringify(row)}\n`);
      }
      await delta.sync();
    } finally {
      await delta.close();
    }

    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      maxOverlayMemoryBytes: 1024,
      maxOverlayDiskBytes: 256 * 1024 * 1024,
    });
    assert.equal(projected.manifest.summary.nodeCount, RECORDS);
    global.gc();
    assert.equal(
      process.memoryUsage().heapUsed < 32 * 1024 * 1024,
      true,
      `heap remained above bounded target: ${process.memoryUsage().heapUsed}`,
    );
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
