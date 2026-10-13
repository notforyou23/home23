import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { reembedBrain, runBrainReembedCommand } from '../../cli/lib/brain-reembed.js';

const require = createRequire(import.meta.url);
const TARGET = 'gemini:gemini-embedding-2:3';
const { OWNED_EMBEDDING_PROFILE, OWNED_EMBEDDING_RECIPE_ID, LEGACY_EMBEDDING_RECIPE_ID } = require('../../shared/semantic-encoder-contract.cjs');
const OWNED_TARGET = `owned-onnx:${OWNED_EMBEDDING_PROFILE}:768`;
async function fixture(t, { directory = false, sidecars = false, tuples = false } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'home23-reembed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nodes = [
    { id: 1, concept: 'abcd', embedding: [1, 0, 0], embedding_recipe_id: 'old', metadata: { owner: true }, weight: 0.7 },
    { id: 2, concept: 'efghijkl', embedding: [0, 1, 0], evidence: ['keep'] },
    { id: 3, concept: '', embedding: [0, 0, 1], tags: ['keep'] },
  ];
  const memory = { nodes: tuples ? nodes.map(node => [node.id, node]) : nodes, edges: [], clusters: [], nextNodeId: 4, metadata: { privateField: 'kept' } };
  const source = path.join(root, directory ? 'source' : 'source.json');
  if (directory) {
    await fs.mkdir(source);
    const state = { cycleCount: 41, goals: { keep: true }, memory: { ...memory, ...(sidecars ? { nodes: [] } : {}) } };
    await fs.writeFile(path.join(source, 'state.json.gz'), gzipSync(JSON.stringify(state)));
    await fs.writeFile(path.join(source, 'engine.pid'), '999999999');
    await fs.writeFile(path.join(source, 'notes.txt'), 'preserve ancillary file');
    if (sidecars) {
      await fs.writeFile(path.join(source, 'memory-nodes.jsonl.gz'), gzipSync(nodes.map(node => JSON.stringify(node)).join('\n') + '\n'));
      await fs.writeFile(path.join(source, 'memory-edges.jsonl.gz'), gzipSync(''));
      await fs.writeFile(path.join(source, 'memory-delta.jsonl'), JSON.stringify({ op: 'upsert_node', record: { ...nodes[1], concept: 'delta text' } }) + '\n');
      await fs.writeFile(path.join(source, 'brain-snapshot.json'), JSON.stringify({ nodeCount: 3, edgeCount: 0, cycle: 41 }));
      await fs.writeFile(path.join(source, 'memory-ann.index'), 'old index');
    }
  } else await fs.writeFile(source, JSON.stringify(memory));
  const output = path.join(root, directory ? 'output' : 'output.json');
  const options = { homeRoot: root, provider: 'gemini', model: 'gemini-embedding-2', dimensions: 3, batchSize: 1, requestsPerMinute: 60, output };
  const calls = [], delays = [];
  const deps = {
    env: {},
    createProvider: config => ({ id: `${config.provider}:${config.model}:${config.dimensions}`, embedBatch: async (texts, { recordedId }) => { assert.equal(recordedId, TARGET); calls.push(texts); return texts.map(() => [3, 4, 0]); } }),
    sleep: async ms => delays.push(ms),
    listProcesses: async () => [], isPidRunning: async () => false,
  };
  return { root, source, output, options, deps, calls, delays, nodes };
}
async function readOutput(f) {
  const data = f.output.endsWith('.json') ? JSON.parse(await fs.readFile(f.output, 'utf8')) : JSON.parse(gunzipSync(await fs.readFile(path.join(f.output, 'state.json.gz'))));
  return data.memory ?? data;
}

test('dry-run defaults to characters / 4 and $0.20 per million without provider calls or output', async t => {
  const f = await fixture(t);
  const receipt = await reembedBrain(f.source, f.options, f.deps);
  assert.equal(receipt.status, 'dry-run'); assert.equal(receipt.nodes, 3); assert.equal(receipt.nodesToEmbed, 2);
  assert.equal(receipt.characters, 12); assert.equal(receipt.estimatedInputTokens, 3);
  assert.equal(receipt.pricePerMillion, 0.20); assert.ok(Math.abs(receipt.estimatedCost - 0.0000006) < 1e-15);
  assert.equal(receipt.estimatedSeconds, 2); assert.equal(receipt.sourceId, 'ollama:nomic-embed-text:768');
  assert.deepEqual(f.calls, []); await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  assert.ok(Math.abs((await reembedBrain(f.source, { ...f.options, pricePerMillion: 0.4 }, f.deps)).estimatedCost - 0.0000012) < 1e-15);
});

test('run publishes a normalized independent copy and preserves tuples and nonembedding fields', async t => {
  const f = await fixture(t, { tuples: true });
  const original = await fs.readFile(f.source);
  const receipt = await reembedBrain(f.source, { ...f.options, run: true }, f.deps);
  assert.equal(receipt.status, 'completed'); assert.deepEqual(await fs.readFile(f.source), original);
  const result = await readOutput(f);
  assert.equal(result.metadata.embedderId, TARGET); assert.equal(result.metadata.privateField, 'kept');
  assert.deepEqual(result.nodes[0][1].embedding, [0.6, 0.8, 0]);
  assert.equal(result.nodes[0][1].embedding_recipe_id, undefined);
  assert.equal(result.nodes[0][0], 1); assert.deepEqual(result.nodes[0][1].metadata, { owner: true });
  assert.deepEqual(result.nodes[1][1].evidence, ['keep']); assert.equal(result.nodes[2][1].embedding, undefined);
  assert.deepEqual(f.delays, [1000]);
  await assert.rejects(reembedBrain(f.source, { ...f.options, output: f.source, run: true }, f.deps), /separate path/);
  await assert.rejects(reembedBrain(f.source, { ...f.options, run: true }, f.deps), /already exists/);
});

test('resume reuses checkpoint batches and refuses changed source or target', async t => {
  const f = await fixture(t);
  let requests = 0;
  const broken = { ...f.deps, createProvider: config => ({ id: TARGET, embedBatch: async texts => { if (++requests === 2) throw new Error('temporary unavailable'); return texts.map(() => [3, 4, 0]); } }) };
  await assert.rejects(reembedBrain(f.source, { ...f.options, run: true }, broken), /temporary unavailable/);
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  const clean = JSON.parse(await fs.readFile(path.join(`${f.output}.reembed-work`, path.basename(f.output)), 'utf8'));
  assert.ok(clean.nodes.every(node => !node.embedding), 'old vectors removed before embedding');
  await assert.rejects(reembedBrain(f.source, { ...f.options, run: true, resume: true, model: 'another-model' }, f.deps), /checkpoint/);
  await reembedBrain(f.source, { ...f.options, run: true, resume: true }, f.deps);
  assert.deepEqual(f.calls, [['efghijkl']]); assert.equal((await readOutput(f)).metadata.embedderId, TARGET);
});

test('resume fails closed when source changes', async t => {
  const f = await fixture(t);
  const deps = { ...f.deps, createProvider: () => ({ id: TARGET, embedBatch: async () => { throw new Error('pause'); } }) };
  await assert.rejects(reembedBrain(f.source, { ...f.options, run: true }, deps), /pause/);
  const changed = JSON.parse(await fs.readFile(f.source, 'utf8')); changed.nodes[0].concept = 'changed';
  await fs.writeFile(f.source, JSON.stringify(changed));
  await assert.rejects(reembedBrain(f.source, { ...f.options, run: true, resume: true }, f.deps), /checkpoint/);
});

test('engine sidecars fold deltas, retain state and ancillary files, and discard old ANN vectors', async t => {
  const f = await fixture(t, { directory: true, sidecars: true });
  const original = await fs.readFile(path.join(f.source, 'memory-nodes.jsonl.gz'));
  await assert.rejects(reembedBrain(path.join(f.source, 'state.json.gz'), f.options, f.deps), /Pass its directory/);
  await reembedBrain(f.source, { ...f.options, run: true }, f.deps);
  assert.deepEqual(f.calls, [['abcd'], ['delta text']]);
  assert.deepEqual(await fs.readFile(path.join(f.source, 'memory-nodes.jsonl.gz')), original);
  assert.equal(await fs.readFile(path.join(f.output, 'notes.txt'), 'utf8'), 'preserve ancillary file');
  const shell = JSON.parse(gunzipSync(await fs.readFile(path.join(f.output, 'state.json.gz'))));
  assert.equal(shell.cycleCount, 41); assert.deepEqual(shell.goals, { keep: true }); assert.deepEqual(shell.memory.nodes, []);
  const records = gunzipSync(await fs.readFile(path.join(f.output, 'memory-nodes.jsonl.gz'))).toString().trim().split('\n').map(JSON.parse);
  assert.deepEqual(records[0].embedding, [0.6, 0.8, 0]); assert.equal(records[2].embedding, undefined);
  await assert.rejects(fs.stat(path.join(f.output, 'memory-delta.jsonl')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.output, 'memory-ann.index')), { code: 'ENOENT' });
});

test('swap is separate, requires stopped engine evidence, verifies ids, and backs up the old brain', async t => {
  const f = await fixture(t, { directory: true });
  await assert.rejects(reembedBrain(f.source, { ...f.options, run: true, swap: true }, f.deps), /separate steps/);
  await reembedBrain(f.source, { ...f.options, run: true }, f.deps);
  await assert.rejects(reembedBrain(f.source, { ...f.options, swap: true, model: 'wrong' }, f.deps), /ids do not match/);
  const running = { ...f.deps, listProcesses: async () => [{ pid: 999, command: `node engine/src/index.js --logs ${f.source}` }] };
  await assert.rejects(reembedBrain(f.source, { ...f.options, swap: true }, running), /appears running/);
  await assert.rejects(reembedBrain(f.source, { ...f.options, swap: true }, { ...f.deps, isPidRunning: () => true }), /PID is still running/);
  const receipt = await reembedBrain(f.source, { ...f.options, swap: true }, f.deps);
  assert.equal(receipt.status, 'swapped');
  const activated = JSON.parse(gunzipSync(await fs.readFile(path.join(f.source, 'state.json.gz'))));
  const backup = JSON.parse(gunzipSync(await fs.readFile(path.join(receipt.backup, 'state.json.gz'))));
  assert.equal(activated.memory.metadata.embedderId, TARGET); assert.equal(backup.memory.metadata.embedderId, undefined);
});

test('swap rejects missing PID evidence, unknown inspection, changed source and changed output', async t => {
  const f = await fixture(t, { directory: true });
  await reembedBrain(f.source, { ...f.options, run: true }, f.deps);
  await assert.rejects(reembedBrain(f.source, { ...f.options, swap: true }, { ...f.deps, listProcesses: async () => { throw new Error('unavailable'); } }), /Cannot verify/);
  await assert.rejects(reembedBrain(f.source, { ...f.options, swap: true, enginePidFile: path.join(f.root, 'missing.pid') }, f.deps), /PID evidence/);
  await fs.writeFile(path.join(f.output, 'state.json.gz'), gzipSync(JSON.stringify({ memory: { nodes: [], edges: [] } })));
  await assert.rejects(reembedBrain(f.source, { ...f.options, swap: true }, f.deps), /output changed/);
  await fs.writeFile(path.join(f.source, 'notes.txt'), 'source changed');
  await assert.rejects(reembedBrain(f.source, { ...f.options, swap: true }, f.deps), /Source changed/);
});

test('command dispatch parses explicit config pricing and reports JSON estimates', async t => {
  const f = await fixture(t);
  const config = path.join(f.root, 'embedding.yaml');
  await fs.writeFile(config, 'architecture:\n  memory:\n    embedding:\n      provider: gemini\n      model: gemini-embedding-2\n      dimensions: 3\n      batchSize: 2\n      pricePerMillionTokens: 0.40\n      requestsPerMinute: 30\n');
  let output = '';
  await runBrainReembedCommand(f.root, [f.source, '--config', config], { ...f.deps, stdout: { write: value => { output += value; } } });
  const receipt = JSON.parse(output);
  assert.equal(receipt.pricePerMillion, 0.40); assert.equal(receipt.estimatedSeconds, 2);
  await assert.rejects(runBrainReembedCommand(f.root, [f.source, '--output'], f.deps), /Missing value/);
  await assert.rejects(runBrainReembedCommand(f.root, [f.source, '--unknown'], f.deps), /Unknown/);
});

test('owned ONNX copy and swap use the sidecar protocol without changing source vectors', async t => {
  const f = await fixture(t, { directory: true, sidecars: true });
  const original = await fs.readFile(path.join(f.source, 'memory-nodes.jsonl.gz'));
  const config = path.join(f.root, 'owned-embedding.yaml');
  await fs.writeFile(config, `provider: home23-owned\nmodel: ${OWNED_EMBEDDING_PROFILE}\ndimensions: 768\nendpoint: http://127.0.0.1:24005/api/embeddings\nbatchSize: 2\n`);
  const requests = [];
  const deps = { ...f.deps, createProvider: undefined, providerDeps: {
    fetch: async (url, request) => {
      const body = JSON.parse(request.body);
      requests.push({ url, body });
      return { ok: true, json: async () => ({ data: body.input.map((_text, index) => ({ index, embedding: [3, 4, ...Array(766).fill(0)] })) }) };
    },
  } };
  const options = { homeRoot: f.root, config, output: f.output };
  assert.equal((await reembedBrain(f.source, options, deps)).targetId, OWNED_TARGET);
  assert.deepEqual(requests, []);
  const receipt = await reembedBrain(f.source, { ...options, run: true }, deps);
  assert.equal(receipt.targetId, OWNED_TARGET);
  assert.deepEqual(await fs.readFile(path.join(f.source, 'memory-nodes.jsonl.gz')), original);
  assert.deepEqual(requests.map(row => row.url), ['http://127.0.0.1:24005/v1/embeddings']);
  assert.equal(requests[0].body.model, OWNED_EMBEDDING_PROFILE);
  const rows = gunzipSync(await fs.readFile(path.join(f.output, 'memory-nodes.jsonl.gz'))).toString().trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].embedder_id, OWNED_TARGET);
  assert.equal(rows[0].embedding_recipe_id, OWNED_EMBEDDING_RECIPE_ID);
  assert.equal(rows[0].embedding_encoder, OWNED_EMBEDDING_PROFILE);
  assert.ok(Math.abs(rows[0].embedding[0] - 0.6) < 1e-12);
  assert.ok(Math.abs(rows[0].embedding[1] - 0.8) < 1e-12);
  const swapped = await reembedBrain(f.source, { ...options, swap: true }, deps);
  assert.equal(swapped.status, 'swapped');
  assert.deepEqual(await fs.readFile(path.join(swapped.backup, 'memory-nodes.jsonl.gz')), original);
  const activated = JSON.parse(gunzipSync(await fs.readFile(path.join(f.source, 'state.json.gz'))));
  assert.equal(activated.memory.metadata.embedderId, OWNED_TARGET);
});

test('Host-root settings resolve its owned catalog, while explicit memory settings take precedence', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'app/config'), { recursive: true });
  await fs.mkdir(path.join(f.root, 'app/configs'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'app/configs/base-engine.yaml'), 'architecture:\n  memory:\n    embedding:\n      provider: ollama\n      model: nomic-embed-text\n      dimensions: 768\n');
  const homeFile = path.join(f.root, 'app/config/home.yaml');
  const catalog = `embeddings:\n  providers:\n    - provider: home23-owned\n      model: ${OWNED_EMBEDDING_PROFILE}\n      dimensions: 768\n      endpoint: http://127.0.0.1:24005/api/embeddings\n`;
  await fs.writeFile(homeFile, catalog);
  assert.equal((await reembedBrain(f.source, { homeRoot: f.root }, f.deps)).targetId, OWNED_TARGET);
  await fs.writeFile(homeFile, catalog + 'architecture:\n  memory:\n    embedding:\n      provider: gemini\n      model: gemini-embedding-2\n      dimensions: 3\n');
  assert.equal((await reembedBrain(f.source, { homeRoot: f.root }, f.deps)).targetId, TARGET);
});

test('re-embed refuses mixed provider ids, unstamped owned vectors, and conflicting owned recipes before requests', async t => {
  for (const corruption of ['missing-id', 'different-id', 'different-recipe']) {
    const f = await fixture(t);
    const source = JSON.parse(await fs.readFile(f.source, 'utf8'));
    source.metadata.embedderId = OWNED_TARGET;
    for (const node of source.nodes) {
      node.embedder_id = OWNED_TARGET;
      node.embedding_recipe_id = OWNED_EMBEDDING_RECIPE_ID;
    }
    if (corruption === 'missing-id') delete source.nodes[1].embedder_id;
    if (corruption === 'different-id') source.nodes[1].embedder_id = 'ollama:nomic-embed-text:768';
    if (corruption === 'different-recipe') source.nodes[1].embedding_recipe_id = LEGACY_EMBEDDING_RECIPE_ID;
    await fs.writeFile(f.source, JSON.stringify(source));
    await assert.rejects(reembedBrain(f.source, { ...f.options, run: true }, f.deps), /mixed/);
    assert.deepEqual(f.calls, []);
    await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  }
});

test('CLI accepts an explicit owned sidecar address override', async t => {
  const f = await fixture(t);
  let configured;
  const deps = { ...f.deps, stdout: { write() {} }, createProvider: config => {
    configured = config;
    return { id: OWNED_TARGET, embedBatch: async texts => texts.map(() => [1, ...Array(767).fill(0)]) };
  } };
  await runBrainReembedCommand(f.root, [f.source, '--provider', 'owned-onnx', '--model', OWNED_EMBEDDING_PROFILE, '--dimensions', '768', '--base-url', 'http://127.0.0.1:24005/v1', '--output', f.output, '--run'], deps);
  assert.equal(configured.baseUrl, 'http://127.0.0.1:24005/v1');
});

test('revisioned manifest graph uses committed deltas and becomes a clean independent sidecar graph', async t => {
  const f = await fixture(t, { directory: true });
  const { rewriteMemoryBase, appendMemoryRevision } = require('../../shared/memory-source');
  const summary = { nodeCount: 3, edgeCount: 0, clusterCount: 0 };
  const lockRoot = path.join(f.root, 'locks');
  await rewriteMemoryBase(f.source, { nodes: f.nodes, edges: [], summary }, { lockRoot });
  await appendMemoryRevision(f.source, { nodes: [{ ...f.nodes[0], concept: 'revisioned fact' }], edges: [], removedNodeIds: [], removedEdgeKeys: [] }, { lockRoot, summary });
  await reembedBrain(f.source, { ...f.options, run: true }, f.deps);
  assert.ok(f.calls.some(texts => texts[0] === 'revisioned fact'));
  await assert.rejects(fs.stat(path.join(f.output, 'memory-manifest.json')), { code: 'ENOENT' });
  const nodes = gunzipSync(await fs.readFile(path.join(f.output, 'memory-nodes.jsonl.gz'))).toString().trim().split('\n').map(JSON.parse);
  const fact = nodes.find(node => node.concept === 'revisioned fact');
  assert.ok(fact); assert.equal(fact.embedder_id, TARGET);
  assert.equal(fact.id, 1, 'stored numeric identity survives canonical source lookup');
});

test('resume recovers a published copy whose receipt write was interrupted without provider calls', async t => {
  const f = await fixture(t);
  await reembedBrain(f.source, { ...f.options, run: true }, f.deps);
  const checkpointFile = path.join(`${f.output}.reembed-work`, 'checkpoint.json');
  const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
  checkpoint.status = 'publishing';
  await fs.writeFile(checkpointFile, JSON.stringify(checkpoint));
  await fs.rm(`${f.output}.reembed-receipt.json`);
  const before = f.calls.length;
  const receipt = await reembedBrain(f.source, { ...f.options, run: true, resume: true }, f.deps);
  assert.equal(receipt.status, 'completed'); assert.equal(f.calls.length, before);
  assert.equal(JSON.parse(await fs.readFile(`${f.output}.reembed-receipt.json`, 'utf8')).targetId, TARGET);
});

test('resume rejects tampered batch vectors and provider ids before publication', async t => {
  const f = await fixture(t);
  let count = 0;
  const interrupted = { ...f.deps, createProvider: () => ({ id: TARGET, embedBatch: async () => { if (++count === 2) throw new Error('interrupted'); return [[1, 0, 0]]; } }) };
  await assert.rejects(reembedBrain(f.source, { ...f.options, run: true }, interrupted), /interrupted/);
  await fs.writeFile(path.join(`${f.output}.reembed-work`, 'batches/0.json'), '[{"index":0,"id":"wrong","vector":[1,0,0]}]');
  await assert.rejects(reembedBrain(f.source, { ...f.options, run: true, resume: true }, f.deps), /batch changed/);
  const otherOutput = path.join(f.root, 'wrong-provider.json');
  await assert.rejects(reembedBrain(f.source, { ...f.options, output: otherOutput, run: true }, { ...f.deps, createProvider: () => ({ id: 'wrong' }) }), /Provider id differs/);
});

test('home embedding overrides base configuration while inheriting pricing and rate', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'configs')); await fs.mkdir(path.join(f.root, 'config'));
  await fs.writeFile(path.join(f.root, 'configs/base-engine.yaml'), 'architecture:\n  memory:\n    embedding:\n      provider: ollama\n      model: nomic-embed-text\n      batchSize: 2\n      requestsPerMinute: 30\n      pricePerMillionTokens: 0.5\n');
  await fs.writeFile(path.join(f.root, 'config/home.yaml'), 'architecture:\n  memory:\n    embedding:\n      provider: gemini\n      model: gemini-embedding-2\n      dimensions: 3\n');
  const receipt = await reembedBrain(f.source, { homeRoot: f.root }, f.deps);
  assert.equal(receipt.targetId, TARGET); assert.equal(receipt.pricePerMillion, 0.5); assert.equal(receipt.requestsPerMinute, 30); assert.equal(receipt.batches, 1);
});

test('derived receipt and checkpoint paths cannot equal or contain the source', async t => {
  const receiptFixture = await fixture(t);
  const receiptSource = `${receiptFixture.output}.reembed-receipt.json`;
  await fs.rename(receiptFixture.source, receiptSource);
  const original = await fs.readFile(receiptSource);
  await assert.rejects(reembedBrain(receiptSource, { ...receiptFixture.options, run: true }, receiptFixture.deps), /separate paths/);
  assert.deepEqual(await fs.readFile(receiptSource), original);
  await assert.rejects(fs.stat(receiptFixture.output), { code: 'ENOENT' });
  const nested = await fixture(t);
  const work = `${nested.output}.reembed-work`;
  await fs.mkdir(work);
  const nestedSource = path.join(work, 'checkpoint.json');
  await fs.rename(nested.source, nestedSource);
  const nestedOriginal = await fs.readFile(nestedSource);
  await assert.rejects(reembedBrain(nestedSource, { ...nested.options, run: true, resume: true }, nested.deps), /separate paths|overlap/);
  assert.deepEqual(await fs.readFile(nestedSource), nestedOriginal);
});

test('derived receipts and resumed checkpoints reject hard links and work symlinks to source', async t => {
  const hardlink = await fixture(t);
  await fs.link(hardlink.source, `${hardlink.output}.reembed-receipt.json`);
  const original = await fs.readFile(hardlink.source);
  await assert.rejects(reembedBrain(hardlink.source, { ...hardlink.options, run: true }, hardlink.deps), /hard link/);
  assert.deepEqual(await fs.readFile(hardlink.source), original);
  const linkedWork = await fixture(t);
  await fs.symlink(linkedWork.root, `${linkedWork.output}.reembed-work`);
  await assert.rejects(reembedBrain(linkedWork.source, { ...linkedWork.options, run: true, resume: true }, linkedWork.deps), /symbolic link/);
  const resumed = await fixture(t);
  await assert.rejects(reembedBrain(resumed.source, { ...resumed.options, run: true }, { ...resumed.deps, createProvider: () => ({ id: TARGET, embedBatch: async () => { throw new Error('pause'); } }) }), /pause/);
  const checkpoint = path.join(`${resumed.output}.reembed-work`, 'checkpoint.json');
  await fs.rm(checkpoint); await fs.link(resumed.source, checkpoint);
  const resumedOriginal = await fs.readFile(resumed.source);
  await assert.rejects(reembedBrain(resumed.source, { ...resumed.options, run: true, resume: true }, resumed.deps), /hard link/);
  assert.deepEqual(await fs.readFile(resumed.source), resumedOriginal);
});

test('an unrelated existing receipt is preserved without publishing or creating work', async t => {
  const f = await fixture(t);
  const receipt = `${f.output}.reembed-receipt.json`;
  await fs.writeFile(receipt, 'unrelated receipt');
  await assert.rejects(reembedBrain(f.source, { ...f.options, run: true }, f.deps), /receipt already exists/);
  assert.equal(await fs.readFile(receipt, 'utf8'), 'unrelated receipt');
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${f.output}.reembed-work`), { code: 'ENOENT' });
});

test('output or receipt appearing during embedding is never overwritten', async t => {
  for (const suffix of ['', '.reembed-receipt.json']) {
    const f = await fixture(t);
    let called = false;
    const deps = { ...f.deps, createProvider: () => ({ id: TARGET, embedBatch: async texts => {
      if (!called) { await fs.writeFile(f.output + suffix, 'unrelated late artifact'); called = true; }
      return texts.map(() => [3, 4, 0]);
    } }) };
    await assert.rejects(reembedBrain(f.source, { ...f.options, run: true }, deps), /appeared during migration/);
    assert.equal(await fs.readFile(f.output + suffix, 'utf8'), 'unrelated late artifact');
  }
});

test('swap rechecks output vectors and receipt after asynchronous engine inspection', async t => {
  for (const mutation of ['vector', 'receipt']) {
    const f = await fixture(t, { directory: true });
    await reembedBrain(f.source, { ...f.options, run: true }, f.deps);
    const original = await fs.readFile(path.join(f.source, 'state.json.gz'));
    const deps = { ...f.deps, listProcesses: async () => {
      if (mutation === 'vector') {
        const stateFile = path.join(f.output, 'state.json.gz');
        const state = JSON.parse(gunzipSync(await fs.readFile(stateFile)));
        state.memory.nodes[0].embedding = [0, 1, 0]; state.memory.nodes[0].embedder_id = 'ollama:nomic-embed-text:3';
        await fs.writeFile(stateFile, gzipSync(JSON.stringify(state)));
      } else {
        const receiptFile = path.join(f.output, 'reembed-receipt.json');
        const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')); receipt.targetId = 'wrong';
        await fs.writeFile(receiptFile, JSON.stringify(receipt));
      }
      return [];
    } };
    await assert.rejects(reembedBrain(f.source, { ...f.options, swap: true }, deps), /changed during stopped-engine verification/);
    assert.deepEqual(await fs.readFile(path.join(f.source, 'state.json.gz')), original);
    assert.ok((await fs.readdir(f.root)).every(name => !name.startsWith('source.backup-')));
  }
});
