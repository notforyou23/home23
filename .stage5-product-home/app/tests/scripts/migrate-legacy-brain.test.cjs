'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promises: fsp } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { writeJsonlGzAtomic } = require('../../shared/memory-source');

const execFileAsync = promisify(execFile);
const script = path.resolve(__dirname, '../../scripts/migrate-legacy-brain.mjs');

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-migrate-cli-'));
  const brain = path.join(root, 'instances', 'jerry', 'brain');
  await fsp.mkdir(brain, { recursive: true });
  await writeJsonlGzAtomic(path.join(brain, 'memory-nodes.jsonl.gz'), [
    { id: 'n1', concept: 'cli canary', cluster: 1 },
  ]);
  await writeJsonlGzAtomic(path.join(brain, 'memory-edges.jsonl.gz'), []);
  await fsp.writeFile(path.join(brain, 'memory-delta.jsonl'), '');
  return { root, brain };
}

async function run(fx, extra = []) {
  const result = await execFileAsync(process.execPath, [
    script,
    '--home23-root', fx.root,
    '--agent', 'jerry',
    '--min-free-bytes', '0',
    ...extra,
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout);
}

test('dry-run reports legacy readiness without writing migration targets', async () => {
  const fx = await fixture();
  const before = (await fsp.readdir(fx.brain)).sort();
  const receipt = await run(fx, ['--dry-run']);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.authority, 'legacy-resident-sidecars');
  assert.equal(receipt.activeOperations, 0);
  assert.deepEqual((await fsp.readdir(fx.brain)).sort(), before);
});

test('apply emits a bounded manifest-v1 receipt', async () => {
  const fx = await fixture();
  const receipt = await run(fx);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.dryRun, false);
  assert.equal(receipt.migrated, true);
  assert.equal(receipt.authority, 'manifest-v1');
  assert.equal(receipt.summary.nodeCount, 1);
  assert.equal(typeof receipt.generation, 'string');
  assert.equal(Buffer.byteLength(JSON.stringify(receipt)) < 64 * 1024, true);
  assert.equal(await fsp.stat(path.join(fx.brain, 'memory-manifest.json')).then(() => true), true);
});

test('dry-run refuses a split operation filesystem without scratch reserve', async () => {
  const fx = await fixture();
  const { runLegacyBrainMigration } = await import('../../scripts/migrate-legacy-brain.mjs');
  await assert.rejects(
    runLegacyBrainMigration({
      home23Root: fx.root,
      agent: 'jerry',
      dryRun: true,
      minFreeBytes: 0,
      commandRunner: async () => ({ operations: [], count: 0 }),
      statfsImpl: async (candidate) => path.basename(candidate) === 'brain'
        ? { bavail: 1024n * 1024n, bsize: 1n }
        : { bavail: 1n, bsize: 1n },
      deviceImpl: async (candidate) => path.basename(candidate) === 'brain' ? 1n : 2n,
    }),
    (error) => error?.code === 'insufficient_disk' && error?.capacityDomain === 'scratch',
  );
  assert.equal(await fsp.stat(path.join(fx.brain, 'memory-manifest.json'))
    .then(() => true, () => false), false);
});
