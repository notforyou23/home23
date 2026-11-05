'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeJsonlGzAtomic } = require('../../shared/memory-source');

const NODE_COUNT = 100_000;
const EDGE_COUNT = 300_000;

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-persistence-heap-')));
  const home23Root = path.join(root, 'home23');
  const brainDir = path.join(home23Root, 'instances', 'jerry', 'brain');
  const tempRoot = path.join(root, 'external-proof');
  await fs.mkdir(brainDir, { recursive: true });
  await fs.mkdir(tempRoot);
  try {
    await writeJsonlGzAtomic(
      path.join(brainDir, 'memory-nodes.jsonl.gz'),
      (async function* nodes() {
        for (let index = 0; index < NODE_COUNT; index += 1) {
          yield {
            id: `heap-node-${index}`,
            concept: `bounded streaming node ${index}`,
            cluster: index % 64,
            metadata: { source: 'heap-probe', ordinal: index },
          };
        }
      })(),
    );
    await writeJsonlGzAtomic(
      path.join(brainDir, 'memory-edges.jsonl.gz'),
      (async function* edges() {
        for (let index = 0; index < EDGE_COUNT; index += 1) {
          yield {
            source: `heap-node-${index % NODE_COUNT}`,
            target: `heap-node-${(index + 1) % NODE_COUNT}`,
            weight: 0.5,
          };
        }
      })(),
    );
    await fs.writeFile(path.join(brainDir, 'memory-delta.jsonl'), '');
    await fs.writeFile(path.join(brainDir, 'brain-snapshot.json'), `${JSON.stringify({
      nodeCount: NODE_COUNT,
      edgeCount: EDGE_COUNT,
      currentRevision: 0,
      generation: 'heap-probe-legacy',
      savedAt: new Date().toISOString(),
    })}\n`);

    const { verifyReadOnlyPersistence } = await import('../../scripts/verify-brain-persistence.mjs');
    const result = await verifyReadOnlyPersistence({
      home23Root,
      agent: 'jerry',
      brainDir,
      tempRoot,
      maxHeapUsedMiB: 80,
      maxRssMiB: 512,
    });
    assert.equal(result.streamed.nodes, NODE_COUNT);
    assert.equal(result.streamed.edges, EDGE_COUNT);
    assert.equal(result.fullMaterializerUsed, false);
    assert.equal(result.streamed.resources.peakHeapUsedMiB <= 80, true);
    assert.deepEqual(await fs.readdir(tempRoot), []);
    process.stdout.write(`${JSON.stringify({
      nodes: result.streamed.nodes,
      edges: result.streamed.edges,
      resources: result.streamed.resources,
    })}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
