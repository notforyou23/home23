'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { StateCompression, uniqueTmpPath } = require('../../cosmo23/engine/src/core/state-compression.js');

const STRUCTURED_FALLBACK = {
  cycleCount: 0,
  journal: [],
  lastSummarization: 0,
  memory: { nodes: [], edges: [], clusters: [] },
};

async function makeTmpDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function sampleState(marker) {
  return {
    cycleCount: 42,
    journal: [{ entry: `journal-${marker}` }],
    lastSummarization: 7,
    memory: {
      nodes: [{ id: `node-${marker}`, concept: `concept ${marker}` }],
      edges: [{ source: `node-${marker}`, target: `node-${marker}`, weight: 1 }],
      clusters: [],
    },
  };
}

test('uniqueTmpPath stays in the target directory and matches the temp naming pattern', () => {
  const target = '/some/dir/state.json.gz';
  const tmp = uniqueTmpPath(target);
  assert.equal(path.dirname(tmp), path.dirname(target), 'temp file must share the target directory so rename is atomic');
  assert.match(path.basename(tmp), /^state\.json\.gz\..+\.tmp$/);
  assert.notEqual(uniqueTmpPath(target), tmp, 'temp paths must be unique per call');
});

test('saveCompressed writes atomically: valid .gz, round-trips, no temp leftovers', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-statecomp-save-');
  const statePath = path.join(dir, 'state.json');
  const state = sampleState('atomic');

  const result = await StateCompression.saveCompressed(statePath, state, { compress: true });
  assert.equal(result.compressed, true);
  assert.ok(result.size > 0);

  const entries = await fsp.readdir(dir);
  assert.deepEqual(entries.sort(), ['state.json.gz'], 'only the final .gz may exist — no partial/temp files');

  const loaded = await StateCompression.loadCompressed(statePath);
  assert.deepEqual(loaded, state);
});

test('a save that dies mid-write leaves the previous intact .gz and cleans its temp file', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-statecomp-crash-');
  const statePath = path.join(dir, 'state.json');
  const original = sampleState('original');
  const replacement = sampleState('replacement');

  await StateCompression.saveCompressed(statePath, original, { compress: true });

  // Simulate a mid-write kill: write half the bytes to whatever destination
  // the module chose, then fail. The module must be writing to a temp path
  // (never state.json.gz in place) and must clean the temp file on failure.
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
    () => StateCompression.saveCompressed(statePath, replacement, { compress: true }),
    /simulated mid-write kill/,
  );
  promisesApi.writeFile = realWriteFile;

  assert.equal(writeTargets.length, 1);
  assert.notEqual(writeTargets[0], statePath + '.gz', 'must never write the final .gz in place');
  assert.match(path.basename(writeTargets[0]), /^state\.json\.gz\..+\.tmp$/, 'write must target a unique temp file next to the .gz');

  const entries = await fsp.readdir(dir);
  assert.deepEqual(entries.sort(), ['state.json.gz'], 'failed save must clean its temp file and leave only the previous .gz');

  const loaded = await StateCompression.loadCompressed(statePath);
  assert.deepEqual(loaded, original, 'previous state must survive a mid-write kill untouched');
});

test('loadCompressed salvages a .gz with trailing garbage appended', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-statecomp-salvage-');
  const statePath = path.join(dir, 'state.json');
  const state = sampleState('salvage');

  const cleanGz = zlib.gzipSync(JSON.stringify(state), { level: zlib.constants.Z_BEST_COMPRESSION });
  const garbage = Buffer.from('TRAILING-GARBAGE-FROM-A-MID-WRITE-KILL-0123456789');
  fs.writeFileSync(statePath + '.gz', Buffer.concat([cleanGz, garbage]));

  // Sanity: plain gunzip must reject this file, so a passing load proves salvage ran.
  assert.throws(() => zlib.gunzipSync(fs.readFileSync(statePath + '.gz')));

  const loaded = await StateCompression.loadCompressed(statePath);
  assert.deepEqual(loaded, state, 'first valid gzip member must be recovered despite trailing garbage');
});

test('loadCompressed returns the structured fallback for a fully corrupt .gz with no uncompressed file', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-statecomp-corrupt-');
  const statePath = path.join(dir, 'state.json');

  fs.writeFileSync(statePath + '.gz', Buffer.from('this is not gzip data at all, just junk bytes 0123456789'));

  const loaded = await StateCompression.loadCompressed(statePath);
  assert.deepEqual(loaded, STRUCTURED_FALLBACK, 'corrupt-only .gz must yield the structured empty state, not a throw');
});

test('loadCompressed returns the structured fallback for a truncated .gz with no uncompressed file', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-statecomp-truncated-');
  const statePath = path.join(dir, 'state.json');
  const state = sampleState('truncated');

  const cleanGz = zlib.gzipSync(JSON.stringify(state), { level: zlib.constants.Z_BEST_COMPRESSION });
  fs.writeFileSync(statePath + '.gz', cleanGz.subarray(0, Math.floor(cleanGz.length / 2)));

  const loaded = await StateCompression.loadCompressed(statePath);
  assert.deepEqual(loaded, STRUCTURED_FALLBACK, 'a pre-fix mid-write-kill artifact must not throw or half-parse');
});

test('loadCompressed falls back to the uncompressed file when the .gz is corrupt', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-statecomp-fallback-');
  const statePath = path.join(dir, 'state.json');
  const state = sampleState('uncompressed');

  fs.writeFileSync(statePath + '.gz', Buffer.from('corrupt junk that is not gzip'));
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

  const loaded = await StateCompression.loadCompressed(statePath);
  assert.deepEqual(loaded, state);
});

test('loadCompressed returns the structured fallback when neither file exists', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-statecomp-missing-');
  const statePath = path.join(dir, 'state.json');

  const loaded = await StateCompression.loadCompressed(statePath);
  assert.deepEqual(loaded, STRUCTURED_FALLBACK);
});

test('loadCompressed still throws when the uncompressed file exists but is unreadable JSON', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-statecomp-badjson-');
  const statePath = path.join(dir, 'state.json');

  fs.writeFileSync(statePath, '{ definitely not json', 'utf8');

  await assert.rejects(
    () => StateCompression.loadCompressed(statePath),
    /Failed to load state from/,
  );
});

