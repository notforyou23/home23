'use strict';

// The merge engine's state IO must route through the hardened
// StateCompression module: atomic temp-file+fsync+rename writes, first-gzip-
// member salvage on load, and throw-on-missing semantics (a run with no
// readable state is an invalid merge input, never an empty brain).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  loadCompressedState,
  saveCompressedState,
} = require('../../cosmo23/engine/src/merge/merge-engine.js');

async function makeTmpDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function sampleState(marker) {
  return {
    cycleCount: 7,
    journal: [{ entry: `merge-${marker}` }],
    lastSummarization: 3,
    memory: {
      nodes: [{ id: `node-${marker}`, concept: `merged concept ${marker}` }],
      edges: [],
      clusters: [],
    },
  };
}

test('saveCompressedState round-trips through loadCompressedState', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-mergeio-roundtrip-');
  const statePath = path.join(dir, 'state.json');
  const state = sampleState('roundtrip');

  await saveCompressedState(statePath, state);

  const entries = await fsp.readdir(dir);
  assert.deepEqual(entries.sort(), ['state.json.gz'], 'only the final .gz may exist — no temp leftovers');

  const loaded = await loadCompressedState(statePath);
  assert.deepEqual(loaded, state);
});

test('saveCompressedState never writes the merged .gz in place', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-mergeio-atomic-');
  const statePath = path.join(dir, 'state.json');
  const original = sampleState('original');
  const replacement = sampleState('replacement');

  await saveCompressedState(statePath, original);

  const promisesApi = require('fs').promises;
  const realWriteFile = promisesApi.writeFile;
  const writeTargets = [];
  promisesApi.writeFile = async function patchedWriteFile(target, data, ...rest) {
    writeTargets.push(String(target));
    const partial = Buffer.isBuffer(data)
      ? data.subarray(0, Math.floor(data.length / 2))
      : String(data).slice(0, Math.floor(String(data).length / 2));
    await realWriteFile.call(this, target, partial, ...rest);
    throw new Error('simulated mid-write kill');
  };
  t.after(() => {
    promisesApi.writeFile = realWriteFile;
  });

  await assert.rejects(
    () => saveCompressedState(statePath, replacement),
    /simulated mid-write kill/,
  );
  promisesApi.writeFile = realWriteFile;

  assert.equal(writeTargets.length, 1);
  assert.notEqual(writeTargets[0], statePath + '.gz', 'must never write the final .gz in place');
  assert.match(path.basename(writeTargets[0]), /^state\.json\.gz\..+\.tmp$/, 'write must target a unique temp file next to the .gz');

  const entries = await fsp.readdir(dir);
  assert.deepEqual(entries.sort(), ['state.json.gz'], 'failed save must clean its temp file and leave only the previous .gz');

  const loaded = await loadCompressedState(statePath);
  assert.deepEqual(loaded, original, 'previous merged state must survive a mid-write kill untouched');
});

test('loadCompressedState salvages a .gz with trailing garbage appended', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-mergeio-salvage-');
  const statePath = path.join(dir, 'state.json');
  const state = sampleState('salvage');

  const cleanGz = zlib.gzipSync(JSON.stringify(state));
  const garbage = Buffer.from('TRAILING-GARBAGE-FROM-A-MID-WRITE-KILL-0123456789');
  fs.writeFileSync(statePath + '.gz', Buffer.concat([cleanGz, garbage]));

  // Sanity: plain gunzip must reject this file, so a passing load proves salvage ran.
  assert.throws(() => zlib.gunzipSync(fs.readFileSync(statePath + '.gz')));

  const loaded = await loadCompressedState(statePath);
  assert.deepEqual(loaded, state, 'the merge loader must recover the first valid gzip member');
});

test('loadCompressedState throws for a missing run state — invalid run, never an empty brain', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-mergeio-missing-');
  const statePath = path.join(dir, 'state.json');

  await assert.rejects(() => loadCompressedState(statePath));
});

test('loadCompressedState throws for an unrecoverable .gz with no uncompressed fallback', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-mergeio-corrupt-');
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath + '.gz', Buffer.from('junk bytes, definitely not gzip'));

  await assert.rejects(() => loadCompressedState(statePath));
});
