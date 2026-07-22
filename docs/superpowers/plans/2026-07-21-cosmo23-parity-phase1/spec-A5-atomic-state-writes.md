# Fix 1.5 — atomic state writes + corrupt-gzip salvage in cosmo23 StateCompression (cosmo23/engine/src/core/state-compression.js)

## Target current state

Bug 1 — non-atomic save, /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/state-compression.js:47-51 (verified by read):

```js
    // Compress with gzip
    const compressed = await gzip(jsonString, { level });
    
    // Save compressed data
    await fs.writeFile(filepath + '.gz', compressed);
```

`fs.writeFile` truncates and rewrites `state.json.gz` in place. A kill mid-write leaves a truncated .gz and no intact predecessor.

Bug 2 — no salvage and silent fresh-brain risk, same file lines 67-84:

```js
  static async loadCompressed(filepath) {
    // Try compressed file first
    const compressedPath = filepath + '.gz';
    
    try {
      const compressed = await fs.readFile(compressedPath);
      const decompressed = await gunzip(compressed);
      return JSON.parse(decompressed.toString('utf8'));
    } catch (error) {
      // Fall back to uncompressed file
      try {
        const data = await fs.readFile(filepath, 'utf8');
        return JSON.parse(data);
      } catch (fallbackError) {
        throw new Error(`Failed to load state from ${filepath} or ${compressedPath}: ${fallbackError.message}`);
      }
    }
  }
```

Any gzip error (trailing garbage OR truncation OR corruption) falls straight to the uncompressed `state.json`, which for compressed-only brains does not exist, so load throws with no recovery attempt. Empirically verified (Node zlib probe): valid gzip + trailing garbage makes `gunzip` throw `incorrect header check` even though the full state is recoverable from the first gzip member.

Caller context proving impact: orchestrator save path /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js:8107-8110 passes `(capturedState) => StateCompression.saveCompressed(statePath, capturedState, { compress: true, pretty: false })` into persistResearchState — every cycle-end save goes through the non-atomic write. Load path orchestrator.js:8383 `const state = await StateCompression.loadCompressed(statePath);` — a truncated .gz here throws, and (pre-Phase-1) crash recovery then proceeds from a checkpoint as if the brain were fresh. Note orchestrator.js:8372-8379 pre-checks `existsSync` for both files and early-returns on fresh brains, so the donor's ENOENT empty-state fallback does not change engine fresh-brain behavior.

CRITICAL DONOR BUG FOUND (verified empirically, not from memory): the donor salvage at /Users/jtr/_JTR23_/release/home23/engine/src/core/state-compression.js:93 is

```js
        const decompressed = zlib.inflateSync(compressed.slice(10), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
```

`inflateSync` expects a zlib header; the bytes after a gzip header are RAW deflate. Probe result: donor technique throws `incorrect header check` on the exact trailing-garbage case it was written for — the donor's salvage can NEVER succeed. `zlib.inflateRawSync(buf.subarray(10), { finishFlush: Z_SYNC_FLUSH })` succeeds on the same input (probe: recovered full JSON). The port below uses inflateRawSync plus an RFC-1952 header walk (handles FEXTRA/FNAME/FCOMMENT/FHCRC for files written by external gzip tools; Node's own zlib.gzip always emits a fixed 10-byte header, FLG=0, probe-verified).

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/state-compression.js

Full-file replacement (cleaner than spot edits: save and load both change; rotateBackups/createBackup are byte-identical to current). Adds unique-temp-file + rename atomic writes for both compressed and uncompressed saves, first-gzip-member salvage via RFC-1952 header walk + inflateRawSync (donor's inflateSync is broken — see targetCurrentState), and the donor's structured empty-state fallback. Public API unchanged: static saveCompressed/loadCompressed/rotateBackups/createBackup with identical signatures and return shapes; exports gain additive uniqueTmpPath + salvageFirstGzipMember (donor also exports uniqueTmpPath). All 14 cosmo23 consumers destructure { StateCompression } and are unaffected: orchestrator.js:3, dashboard/server.js:9, dashboard/server-before-filesystem.js:9, dashboard/insight-analyzer.js:5, dashboard/novelty-validator.js:693+745, merge/hub-adapter.js:17, scripts/{refocus-run,patch-memory-paths,clean-brain,merge_runs,merge_runs_v2,batch-clean-brains}.js, engine/tests/integration/sleep-wake-fix.test.js. Verified working: 9/9 tests pass against this exact content.

### Anchor
```
const zlib = require('zlib');
const fs = require('fs').promises;
```

### Code
```js
const zlib = require('zlib');
const fs = require('fs').promises;
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

function uniqueTmpPath(targetPath) {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return `${targetPath}.${suffix}.tmp`;
}

/**
 * Salvage the first gzip member from a buffer with trailing garbage.
 *
 * A mid-write kill or a concatenating writer can leave extra bytes after a
 * complete gzip stream; plain gunzip rejects the whole file. This parses the
 * gzip header (RFC 1952) to find the deflate payload, then inflates it with
 * Z_SYNC_FLUSH so decompression stops cleanly at the end of the first stream
 * instead of erroring on the trailing bytes.
 *
 * @param {Buffer} buffer - Raw file contents starting with a gzip header
 * @returns {Buffer} - Decompressed payload of the first gzip member
 */
function salvageFirstGzipMember(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 18) {
    throw new Error('Buffer too short to contain a gzip stream');
  }
  if (buffer[0] !== 0x1f || buffer[1] !== 0x8b || buffer[2] !== 0x08) {
    throw new Error('Not a gzip (deflate) stream');
  }
  const flg = buffer[3];
  let offset = 10;
  if (flg & 0x04) { // FEXTRA
    if (buffer.length < offset + 2) throw new Error('Truncated gzip header (FEXTRA)');
    offset += 2 + buffer.readUInt16LE(offset);
  }
  if (flg & 0x08) { // FNAME (zero-terminated)
    while (offset < buffer.length && buffer[offset] !== 0x00) offset++;
    offset++;
  }
  if (flg & 0x10) { // FCOMMENT (zero-terminated)
    while (offset < buffer.length && buffer[offset] !== 0x00) offset++;
    offset++;
  }
  if (flg & 0x02) offset += 2; // FHCRC
  if (offset >= buffer.length) {
    throw new Error('Truncated gzip header');
  }
  return zlib.inflateRawSync(buffer.subarray(offset), {
    finishFlush: zlib.constants.Z_SYNC_FLUSH
  });
}

/**
 * State Compression Utilities
 *
 * Handles compression/decompression of large state files
 * to reduce disk usage without changing data structure.
 *
 * Backward compatible: can read both compressed and uncompressed files.
 */
class StateCompression {

  /**
   * Compress and save state to file (atomic: temp file + rename)
   *
   * @param {string} filepath - Target file path
   * @param {Object} state - State object to save
   * @param {Object} options - Compression options
   * @returns {Promise<{size: number, compressed: boolean}>}
   */
  static async saveCompressed(filepath, state, options = {}) {
    const {
      compress = true,
      pretty = false,
      level = zlib.constants.Z_BEST_COMPRESSION
    } = options;

    // Serialize state to JSON
    const jsonString = pretty
      ? JSON.stringify(state, null, 2)
      : JSON.stringify(state);

    if (!compress) {
      // Save uncompressed (backward compatibility) — atomic write
      await StateCompression._writeAtomic(filepath, jsonString, 'utf8');
      return {
        size: Buffer.byteLength(jsonString, 'utf8'),
        compressed: false
      };
    }

    // Compress with gzip
    const compressed = await gzip(jsonString, { level });

    // Atomic write: unique temp file in the same directory, then rename.
    // A mid-write kill leaves the previous intact .gz in place, never a
    // truncated one.
    await StateCompression._writeAtomic(filepath + '.gz', compressed);

    return {
      size: compressed.length,
      compressed: true,
      originalSize: Buffer.byteLength(jsonString, 'utf8'),
      ratio: (compressed.length / Buffer.byteLength(jsonString, 'utf8')).toFixed(2)
    };
  }

  /**
   * Write data to targetPath atomically (temp file + rename).
   * The temp file lives in the same directory so rename stays atomic.
   */
  static async _writeAtomic(targetPath, data, encoding) {
    const tempPath = uniqueTmpPath(targetPath);
    try {
      await fs.writeFile(tempPath, data, encoding);
      await fs.rename(tempPath, targetPath);
    } catch (error) {
      try { await fs.rm(tempPath, { force: true }); } catch (_) { /* best effort */ }
      throw error;
    }
  }

  /**
   * Load state from file (handles both compressed and uncompressed)
   *
   * Load order:
   *   1. filepath + '.gz' via gunzip
   *   2. same bytes via first-gzip-member salvage (tolerates trailing garbage)
   *   3. uncompressed filepath
   *   4. structured empty-state fallback when neither file exists, or when the
   *      .gz is unrecoverable and no uncompressed file exists (the caller's
   *      brain-snapshot guard is responsible for refusing an empty brain)
   *
   * @param {string} filepath - File path (without .gz extension)
   * @returns {Promise<Object>} - Parsed state object
   */
  static async loadCompressed(filepath) {
    // Try compressed file first
    const compressedPath = filepath + '.gz';

    let compressedError = null;
    try {
      const compressed = await fs.readFile(compressedPath);
      try {
        // Standard gunzip (works for clean files)
        const decompressed = await gunzip(compressed);
        return JSON.parse(decompressed.toString('utf8'));
      } catch (gzipError) {
        // Trailing garbage or a corrupted tail: salvage the first valid
        // gzip member (mid-write kills and appenders leave junk after it)
        const decompressed = salvageFirstGzipMember(compressed);
        const state = JSON.parse(decompressed.toString('utf8'));
        console.warn(`⚠️ Salvaged first gzip member from ${compressedPath} (gunzip failed: ${gzipError.message})`);
        return state;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Compressed file exists but is unrecoverable — remember why,
        // then still try the uncompressed fallback
        compressedError = error;
      }

      // Fall back to uncompressed file
      try {
        const data = await fs.readFile(filepath, 'utf8');
        return JSON.parse(data);
      } catch (fallbackError) {
        if (fallbackError.code === 'ENOENT') {
          if (compressedError) {
            console.warn(`⚠️ Corrupt compressed state at ${compressedPath} (${compressedError.message}) and no uncompressed fallback — returning structured empty state`);
          }
          // Neither file readable — structured empty state. Callers that
          // know the brain should be non-empty (brain-snapshot.json) must
          // fail loud instead of accepting this.
          return {
            cycleCount: 0,
            journal: [],
            lastSummarization: 0,
            memory: { nodes: [], edges: [], clusters: [] },
          };
        }
        throw new Error(`Failed to load state from ${filepath} or ${compressedPath}: ${fallbackError.message}`);
      }
    }
  }

  /**
   * Rotate old backup files, keeping only the most recent N
   *
   * @param {string} logsDir - Logs directory path
   * @param {string} pattern - Filename pattern (e.g., 'state.backup')
   * @param {number} keepCount - Number of recent backups to keep
   * @returns {Promise<{removed: number, kept: number}>}
   */
  static async rotateBackups(logsDir, pattern = 'state.backup', keepCount = 5) {
    try {
      const files = await fs.readdir(logsDir);

      // Find all backup files matching pattern
      const backups = files
        .filter(f => f.startsWith(pattern))
        .map(f => ({
          name: f,
          path: require('path').join(logsDir, f),
          timestamp: parseInt(f.split('.').find(part => /^\d{13}$/.test(part)) || '0')
        }))
        .filter(f => f.timestamp > 0)
        .sort((a, b) => b.timestamp - a.timestamp); // Newest first

      if (backups.length <= keepCount) {
        return { removed: 0, kept: backups.length };
      }

      // Remove old backups
      const toRemove = backups.slice(keepCount);
      let removed = 0;

      for (const backup of toRemove) {
        try {
          await fs.unlink(backup.path);
          // Also remove .gz version if exists
          try {
            await fs.unlink(backup.path + '.gz');
          } catch (e) {
            // Ignore if .gz doesn't exist
          }
          removed++;
        } catch (error) {
          // Continue even if one file fails to delete
        }
      }

      return {
        removed,
        kept: backups.length - removed
      };
    } catch (error) {
      // If rotation fails, don't crash - just log
      return { removed: 0, kept: 0, error: error.message };
    }
  }

  /**
   * Create a timestamped backup of current state
   *
   * @param {string} filepath - Source file path
   * @param {string} logsDir - Logs directory
   * @returns {Promise<string>} - Backup file path
   */
  static async createBackup(filepath, logsDir) {
    const timestamp = Date.now();
    const backupPath = require('path').join(logsDir, `state.backup.${timestamp}.json`);

    try {
      // Try to copy compressed version first
      const compressedSource = filepath + '.gz';
      try {
        await fs.copyFile(compressedSource, backupPath + '.gz');
        return backupPath + '.gz';
      } catch (e) {
        // Fall back to uncompressed
        await fs.copyFile(filepath, backupPath);
        return backupPath;
      }
    } catch (error) {
      throw new Error(`Backup creation failed: ${error.message}`);
    }
  }
}

module.exports = { StateCompression, uniqueTmpPath, salvageFirstGzipMember };

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

Register the new test in the second node --test group of the "test" script (the cosmo23 .cjs group), inserted between bounded-json and cluster-aware-memory-persistence. Anchor snippet verified to appear exactly once in package.json.

### Anchor
```
tests/cosmo23/bounded-json.test.cjs tests/cosmo23/cluster-aware-memory-persistence.test.cjs
```

### Code
```js
tests/cosmo23/bounded-json.test.cjs tests/cosmo23/state-compression-atomicity.test.cjs tests/cosmo23/cluster-aware-memory-persistence.test.cjs
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

Add the new test file to the enforced registration list (lines 44-45 currently read runtime-dependency-compatibility then package-test-registration). Anchor verified unique.

### Anchor
```
    'tests/cosmo23/runtime-dependency-compatibility.test.cjs',
    'tests/cosmo23/package-test-registration.test.cjs',
```

### Code
```js
    'tests/cosmo23/runtime-dependency-compatibility.test.cjs',
    'tests/cosmo23/state-compression-atomicity.test.cjs',
    'tests/cosmo23/package-test-registration.test.cjs',
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/state-compression-atomicity.test.cjs

```js
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

```

## API NOTES

VERIFICATION: all code above was executed, not just written. The full proposed module + full proposed test file were run in a scratchpad mirror of the repo layout (tests/cosmo23/ requiring ../../cosmo23/engine/src/core/state-compression.js): 9/9 pass under node --test --test-concurrency=1.

DONOR BUG (needs its own fix in home23 engine): /Users/jtr/_JTR23_/release/home23/engine/src/core/state-compression.js:93 salvages with zlib.inflateSync(compressed.slice(10), ...). Empirical probe: inflateSync throws 'incorrect header check' on gzip-payload bytes (raw deflate needs inflateRawSync) — the donor's salvage path has never worked. This port replaces it with an RFC-1952 header walk + inflateRawSync + Z_SYNC_FLUSH, probe-verified to recover the first gzip member with trailing garbage present. Recommend back-porting salvageFirstGzipMember to the donor.

PUBLIC API: unchanged. All 14 consumers (orchestrator.js:3, dashboard/server.js:9, server-before-filesystem.js:9, insight-analyzer.js:5, novelty-validator.js:693/745, merge/hub-adapter.js:17, six scripts/, engine/tests/integration/sleep-wake-fix.test.js:7) destructure { StateCompression } and call only saveCompressed/loadCompressed/rotateBackups/createBackup — signatures and success return shapes identical. New exports (uniqueTmpPath, salvageFirstGzipMember) are additive; donor exports uniqueTmpPath too.

BEHAVIOR DELTAS (intentional, per shared contract):
1. loadCompressed no longer throws when neither file exists, or when the .gz is unrecoverable and no uncompressed file exists — returns the structured empty state { cycleCount: 0, journal: [], lastSummarization: 0, memory: { nodes: [], edges: [], clusters: [] } } (exact donor shape; keys match contract 6's scalar-overlay set). Engine impact: none for fresh brains — orchestrator.js:8372-8379 pre-checks existsSync and early-returns before calling loadCompressed. For the corrupt-only case the fail-loud responsibility sits with the Fix-1.x BRAIN_LOAD_EMPTY guard (contract 4) comparing against brain-snapshot.json — this module stays dumb by design so the fixes compose. Scripts (clean-brain.js:64, batch-clean-brains.js:162, merge_runs.js:667, merge_runs_v2.js:126, refocus-run.js:36, patch-memory-paths.js:34) previously got a throw on a totally-missing path and now get empty state; all of them discover statePath from existing run dirs, so risk is low, but the implementer should know.
2. Uncompressed (compress:false) save path is also atomic now (same temp+rename) — strictly safer, same return value.
3. Salvage/corrupt-fallback paths console.warn with emoji prefix (class is static, has no this.logger; matches cosmo23 message style and satisfies 'not silent').

COMPOSITION WITH OTHER PHASE-1 FIXES: orchestrator saveState (orchestrator.js:8107-8110) passes StateCompression.saveCompressed as the saveState callback into persistResearchState (lib/memory-sidecar.js path, contract 3) — atomicity now applies inside that flow with zero orchestrator changes, and Fix 1.1's structured saveState result wraps around it untouched. loadCompressed still returns a plain parsed object, so hydrateStateMemory-based hydration (contract 3) is unaffected.

PRE-EXISTING LATENT BUG SPOTTED (out of scope, unchanged by this fix): cosmo23/engine/src/dashboard/server.js:2526 and server-before-filesystem.js:1839 do `const StateCompression = require('../core/state-compression')` WITHOUT destructuring, shadowing the correct top-level import; the module object has no .loadCompressed, so the /api/operations/force-wake route throws TypeError today. One-line fix each (add braces or delete the shadowing require); worth folding into any cosmo23 cleanup pass.

TEST REGISTRATION: test file added to package.json 'test' chain (second node --test group, anchor verified unique) AND to the enforced list in tests/cosmo23/package-test-registration.test.cjs, so the registration guard covers it going forward.

VENDORED-PATCH LOG: this is a cosmo23/ edit — per docs/design/COSMO23-VENDORED-PATCHES.md discipline the implementer must record it as the next patch entry (post-Patch-20) so it survives upstream resyncs.
