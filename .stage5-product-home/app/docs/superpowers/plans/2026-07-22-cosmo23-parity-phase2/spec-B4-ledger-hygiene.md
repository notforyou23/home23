# cosmo23 events ledger hygiene (Fix 2.4, contract H5) + rotation survey of the other unbounded JSONL streams

## Target current state

TARGET FILE MISMATCH (verified): the prompt names /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/event-logger.js — that path does not exist. The actual files are:

1) /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/event-logger.js (the one matching the prompt's description). Lines 12-14: `this.filePath = path.join(runPath, 'events.jsonl'); this.stream = null; this.eventCount = 0;` — eventCount resets per process. Lines 28-38: `log(event) { ... eventId: ++this.eventCount ... this.stream.write(JSON.stringify(entry) + '\n'); }` — unbounded append, no rotation, no chain. Lines 17-21: `initialize(cleanStart)` UNLINKS the whole history on clean start.

2) /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/realtime/event-logger.js — a second EventLogger (extends COSMOEventEmitter), same unbounded events.jsonl append (lines 14, 42-50).

BOTH ARE DEAD CODE: `grep -rn "EventLogger|event-logger" cosmo23 --include=*.js -l` (node_modules excluded) matches only the two files themselves — zero requires from engine, server, launcher, or lib. Confirmed empirically: no events.jsonl exists in ANY run dir under cosmo23/runs/ (checked all, including live run labor23). So Fix 2.4 both introduces the H5 ledger AND wires a durable event sink into the orchestrator for the first time (which fixes 2.1/2.3 can then use).

Orchestrator has no ledger today: cosmo23/engine/src/core/orchestrator.js constructor ends at line 249-250 (`this.telemetry = new TelemetryCollector(...); this.shutdownHandler = null; // Created after initialization`) with no event persistence; executeCycle() (line 1217) and the cycle-complete point (line 3292-3293 `const cycleDuration = ...; this.logger.info(\`✓ Cycle completed in ${cycleDuration}ms (GPT-5.2)\`);`) log only to the text logger and the in-memory/SSE emitter (`this._getEvents()`, line 434 — realtime only, nothing durable).

OTHER UNBOUNDED JSONL WRITERS (surveyed per task):
- thoughts.jsonl — orchestrator.js:7976-7985 `logThought()`: `await fs.appendFile(path.join(this.logsDir, 'thoughts.jsonl'), line)`. Readers: cosmo23/engine/src/curation/insight-curator.js:301 (reads the whole file), cosmo23/engine/src/merge/merge-engine.js:2199-2200 (archives it on merge). Largest observed across ALL runs: 180KB (crossfit-import); live labor23: 20KB-scale.
- dreams.jsonl — orchestrator.js:7987-7999 `saveDream()`: appendFile per dream. Largest observed: 8KB.
- voice.jsonl — orchestrator.js:8029-8034 inside `voice()`: appendFile per utterance. Reader: coordinator/context-providers.js:198-202 (TODO stub only). Largest observed: 12KB.
These are three SEPARATE inline fs.appendFile call sites — there is no shared writer, and each has single-file readers. Growth is KB-scale and bounded per run by execution.maxCycles/maxRuntimeMinutes. Per the task's YAGNI rule, NO rotation is proposed for them — documented as follow-up in apiNotes.
Additional unbounded streams noted for the record (out of scope): synthesis-commit-receipts.jsonl (orchestrator.js:4180), commitment-governor-receipts.jsonl (orchestrator.js:4189), evaluation-timeseries.jsonl, coordinator/results_queue.jsonl (meta-coordinator.js:2192), coordinator/task_state_queue.jsonl (cluster/task-state-queue.js:28), agents/*/findings.jsonl + insights.jsonl.

## CHANGE: cosmo23/engine/src/core/event-ledger.js

NEW FILE — H5 events ledger: monotonic seq resumed from the tail of events.jsonl on boot (4KB window, widened to 64KB, full scan as last resort), sha256 prevHash chain over serialized lines ('GENESIS' for the first record, chain continues across rotation), rotation at ledger.maxBytes (default 50MB) to events-<ISO-stamp>.jsonl with async gzip (tmp+rename) and keepRolls retention (default 5, prunes only *.jsonl.gz), torn-tail newline guard, legacy/unparseable file preserved aside as .unchained.jsonl, boot orphan sweep (.gz.tmp removal, bare-roll re-gzip), serialized append queue (chain integrity requires write ordering), and exported verifiers verifyLedgerFile/verifyLedgerChain (breaks: invalid_json, prev_hash_mismatch, seq_break; chain walk orders files by first seq and threads hash+seq across boundaries). Validated standalone: 9/9 node:test pass.

### Code
```js
/**
 * EventLedger — durable, tamper-evident, size-bounded events ledger (H5).
 *
 * Replaces the unbounded per-process events.jsonl appender (the old
 * EventLogger reset eventCount every process and never rotated):
 *
 *   - seq        — numeric event id, monotonic ACROSS restarts. Resumed on
 *                  boot by reading the tail of the current events.jsonl
 *                  (last 4KB, widened to 64KB, then full scan as last
 *                  resort) and parsing the final complete line.
 *   - prevHash   — sha256 hex of the previous serialized line (the exact
 *                  JSON string as written, WITHOUT the trailing newline).
 *                  'GENESIS' for the first record of a fresh ledger. The
 *                  chain CONTINUES across rotation: the first record of a
 *                  new file links to the last record of the rolled file.
 *   - Rotation   — when events.jsonl would exceed maxBytes (config
 *                  ledger.maxBytes, default 50MB) it is renamed to
 *                  events-<ISO-stamp>.jsonl, gzipped asynchronously
 *                  (.gz.tmp + rename), and retention keeps the newest
 *                  keepRolls (config ledger.keepRolls, default 5) gzipped
 *                  rolls.
 *   - Verify     — verifyLedgerFile / verifyLedgerChain walk files and
 *                  report chain breaks: invalid_json, prev_hash_mismatch,
 *                  seq_break.
 *
 * Honesty note: a forward hash chain detects mid-file edits, deleted lines
 * and cross-file truncation (the next file's first prevHash no longer
 * matches). Truncating the TAIL of the newest file leaves no in-file
 * evidence; it surfaces as a seq regression against rolled files or a
 * missing ledger_close record.
 *
 * Appends are serialized on an internal promise queue — chain integrity
 * requires strict write ordering. Logging is best-effort: failures warn
 * and never throw into engine cycles.
 */

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // H5 default: 50MB
const DEFAULT_KEEP_ROLLS = 5;
const GENESIS = 'GENESIS';
const LEDGER_FILENAME = 'events.jsonl';
const TAIL_WINDOWS = [4096, 65536];

function sha256Line(line) {
  return crypto.createHash('sha256').update(line, 'utf8').digest('hex');
}

function rollStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the tail of the current ledger and recover { seq, prevHash } from the
 * final complete, parseable, seq-bearing line. A trailing fragment without a
 * newline (torn write) is never resumed from — it is left in place as
 * evidence and the next append starts on a fresh line.
 *
 * A non-empty file with NO recoverable line (legacy pre-chain format or
 * corruption) is preserved aside as events-<stamp>.unchained.jsonl and a
 * fresh chain starts at GENESIS.
 */
async function resumeFromTail(filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return { seq: 0, prevHash: GENESIS, bytes: 0, tornTail: false, preservedUnchained: null };
  }
  if (stat.size === 0) {
    return { seq: 0, prevHash: GENESIS, bytes: 0, tornTail: false, preservedUnchained: null };
  }

  for (const window of TAIL_WINDOWS) {
    const readSize = Math.min(window, stat.size);
    const start = stat.size - readSize;
    const buffer = Buffer.alloc(readSize);
    const handle = await fsp.open(filePath, 'r');
    try {
      await handle.read(buffer, 0, readSize, start);
    } finally {
      await handle.close();
    }
    const text = buffer.toString('utf8');
    const endsWithNewline = text.endsWith('\n');
    const parts = text.split('\n');
    // Reading from mid-file: the first part may be a partial line — drop it.
    if (start > 0) parts.shift();
    // Content after the last newline is a torn line — never resumed from.
    const tornFragment = endsWithNewline ? '' : (parts.pop() || '');
    const completeLines = parts.filter((line) => line.length > 0);

    for (let i = completeLines.length - 1; i >= 0; i--) {
      let parsed = null;
      try {
        parsed = JSON.parse(completeLines[i]);
      } catch {
        continue; // keep scanning backwards
      }
      if (parsed && Number.isFinite(parsed.seq)) {
        return {
          seq: parsed.seq,
          prevHash: sha256Line(completeLines[i]),
          bytes: stat.size,
          tornTail: tornFragment.length > 0 || i < completeLines.length - 1,
          preservedUnchained: null,
        };
      }
    }

    if (readSize >= stat.size) break; // whole file scanned, nothing recoverable
  }

  // Legacy (pre-chain) or corrupt ledger: preserve it aside, start fresh.
  const preservedPath = path.join(
    path.dirname(filePath),
    `events-${rollStamp()}.unchained.jsonl`
  );
  await fsp.rename(filePath, preservedPath);
  return { seq: 0, prevHash: GENESIS, bytes: 0, tornTail: false, preservedUnchained: preservedPath };
}

class EventLedger {
  /**
   * @param {string} dir - directory the ledger lives in (the run's logsDir)
   * @param {object} [opts]
   * @param {number} [opts.maxBytes]  - rotation threshold (default 50MB)
   * @param {number} [opts.keepRolls] - gzipped rolls kept (default 5)
   * @param {object} [opts.logger]    - optional logger with warn()
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.filePath = path.join(dir, LEDGER_FILENAME);
    this.maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
      ? opts.maxBytes
      : DEFAULT_MAX_BYTES;
    this.keepRolls = Number.isInteger(opts.keepRolls) && opts.keepRolls >= 0
      ? opts.keepRolls
      : DEFAULT_KEEP_ROLLS;
    this.logger = opts.logger || null;

    this.seq = 0;               // last WRITTEN seq
    this.prevHash = GENESIS;    // hash of the last written serialized line
    this.currentBytes = 0;
    this.ready = false;
    this._needsNewlineGuard = false;
    this._queue = Promise.resolve();
    this._pendingRollJobs = new Set();
  }

  /**
   * Resume seq/prevHash from the tail of the current file, sweep orphan
   * rotation artifacts, and open the ledger.
   */
  async initialize() {
    await fsp.mkdir(this.dir, { recursive: true });

    const resume = await resumeFromTail(this.filePath);
    this.seq = resume.seq;
    this.prevHash = resume.prevHash;
    this.currentBytes = resume.bytes;
    this._needsNewlineGuard = resume.tornTail;
    this.ready = true;

    // Crash hygiene: finish gzipping bare rolls, drop half-written .gz.tmp.
    await this._sweepOrphans();

    this.log('ledger_open', {
      pid: process.pid,
      resumedSeq: resume.seq,
      tornTail: resume.tornTail || undefined,
      preservedUnchained: resume.preservedUnchained || undefined,
    });
    return this;
  }

  /**
   * Append one event. Synchronous enqueue; the returned promise resolves to
   * the written record (with final seq/prevHash) or null on failure/closed.
   * Never rejects.
   */
  log(type, data = {}) {
    if (!this.ready) return Promise.resolve(null);
    const next = this._queue
      .then(() => this._append(type, data))
      .catch((error) => {
        // A failed append may have written partial bytes — start the next
        // record on a fresh line so one bad write cannot garble the next.
        this._needsNewlineGuard = true;
        this.logger?.warn?.('[event-ledger] append failed', { error: error?.message });
        return null;
      });
    this._queue = next;
    return next;
  }

  /** Await all queued appends and background gzip/retention jobs. */
  async flush() {
    await this._queue;
    await Promise.allSettled(Array.from(this._pendingRollJobs));
  }

  /** Log a final record, then flush and close. Idempotent. */
  async close() {
    if (!this.ready) return;
    const closing = this.log('ledger_close', {});
    this.ready = false;
    await closing;
    await this.flush();
  }

  // ── internals ────────────────────────────────────────────────────────────

  async _append(type, data) {
    const seq = this.seq + 1;
    // Reserved fields always win over payload fields of the same name.
    const record = Object.assign(
      { type, ts: new Date().toISOString() },
      data,
      { seq, prevHash: this.prevHash, type }
    );
    const line = JSON.stringify(record);
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;

    if (this.currentBytes > 0 && this.currentBytes + lineBytes > this.maxBytes) {
      await this._rotate();
    }

    let payload = line + '\n';
    if (this._needsNewlineGuard) {
      payload = '\n' + payload;
      this._needsNewlineGuard = false;
    }

    await fsp.appendFile(this.filePath, payload, 'utf8');
    this.currentBytes += Buffer.byteLength(payload, 'utf8');
    this.seq = seq;
    this.prevHash = sha256Line(line);
    return record;
  }

  async _rotate() {
    const stamp = rollStamp();
    let rolledPath = path.join(this.dir, `events-${stamp}.jsonl`);
    for (let n = 1; (await pathExists(rolledPath)) || (await pathExists(`${rolledPath}.gz`)); n++) {
      rolledPath = path.join(this.dir, `events-${stamp}-${n}.jsonl`);
    }
    await fsp.rename(this.filePath, rolledPath);
    this.currentBytes = 0;
    this._needsNewlineGuard = false;
    // Chain state (this.prevHash / this.seq) carries over IN MEMORY — the
    // first record of the new file links to the last record of the roll.
    this._startRollJob(rolledPath);
  }

  _startRollJob(rolledPath) {
    const job = this._gzipAndPrune(rolledPath).catch((error) => {
      this.logger?.warn?.('[event-ledger] roll gzip failed', {
        roll: path.basename(rolledPath),
        error: error?.message,
      });
    });
    this._pendingRollJobs.add(job);
    job.finally(() => this._pendingRollJobs.delete(job));
  }

  async _gzipAndPrune(rolledPath) {
    const gzPath = `${rolledPath}.gz`;
    const tmpPath = `${gzPath}.tmp`;
    await new Promise((resolve, reject) => {
      const source = fs.createReadStream(rolledPath);
      const gzip = zlib.createGzip();
      const sink = fs.createWriteStream(tmpPath);
      source.on('error', reject);
      gzip.on('error', reject);
      sink.on('error', reject);
      sink.on('finish', resolve);
      source.pipe(gzip).pipe(sink);
    });
    await fsp.rename(tmpPath, gzPath);
    await fsp.unlink(rolledPath);
    await this._enforceRetention();
  }

  /**
   * Keep only the newest keepRolls gzipped rolls. Bare events-*.jsonl rolls
   * are never pruned here — they are either mid-gzip or crash orphans that
   * _sweepOrphans() will gzip on the next boot.
   */
  async _enforceRetention() {
    const entries = await fsp.readdir(this.dir);
    const rolls = entries
      .filter((name) => /^events-.+\.jsonl\.gz$/.test(name))
      .sort(); // ISO-derived stamps sort lexically
    const excess = rolls.length - this.keepRolls;
    for (let i = 0; i < excess; i++) {
      await fsp.unlink(path.join(this.dir, rolls[i])).catch(() => {});
    }
  }

  async _sweepOrphans() {
    let entries;
    try {
      entries = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.endsWith('.gz.tmp')) {
        await fsp.unlink(path.join(this.dir, name)).catch(() => {});
        continue;
      }
      if (/^events-.+\.jsonl$/.test(name) && !name.endsWith('.unchained.jsonl')) {
        this._startRollJob(path.join(this.dir, name));
      }
    }
  }
}

// ── verification ─────────────────────────────────────────────────────────────

function readLedgerLines(filePath) {
  let raw = fs.readFileSync(filePath);
  if (filePath.endsWith('.gz')) raw = zlib.gunzipSync(raw);
  return raw.toString('utf8').split('\n').filter((line) => line.length > 0);
}

/**
 * Walk one ledger file and verify the hash chain and seq continuity.
 *
 * @param {string} filePath - events.jsonl or a .jsonl.gz roll
 * @param {object} [opts]
 * @param {string|null} [opts.expectedPrevHash] - hash the first record must
 *        link to (from the previous file). null = unverifiable anchor
 *        (earlier rolls pruned); the first VALID record is accepted as the
 *        trust anchor.
 * @param {number|null} [opts.expectedNextSeq] - seq the first record must
 *        carry. null = accept any.
 * @returns {{ file, ok, records, breaks, firstSeq, lastSeq, lastHash, genesis }}
 */
function verifyLedgerFile(filePath, opts = {}) {
  const breaks = [];
  let expectedPrevHash = opts.expectedPrevHash ?? null;
  let expectedNextSeq = opts.expectedNextSeq ?? null;
  let firstSeq = null;
  let lastSeq = null;
  let lastHash = null;
  let genesis = false;
  let records = 0;

  const lines = readLedgerLines(filePath);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      breaks.push({ file: filePath, index, reason: 'invalid_json' });
      continue;
    }
    if (!parsed || !Number.isFinite(parsed.seq) || typeof parsed.prevHash !== 'string') {
      breaks.push({ file: filePath, index, reason: 'invalid_json' });
      continue;
    }

    if (records === 0 && parsed.prevHash === GENESIS) genesis = true;

    if (expectedPrevHash !== null && parsed.prevHash !== expectedPrevHash) {
      breaks.push({
        file: filePath,
        index,
        seq: parsed.seq,
        reason: 'prev_hash_mismatch',
        expected: expectedPrevHash,
        actual: parsed.prevHash,
      });
    }
    if (expectedNextSeq !== null && parsed.seq !== expectedNextSeq) {
      breaks.push({
        file: filePath,
        index,
        reason: 'seq_break',
        expected: expectedNextSeq,
        actual: parsed.seq,
      });
    }

    if (firstSeq === null) firstSeq = parsed.seq;
    lastSeq = parsed.seq;
    lastHash = sha256Line(line);
    expectedPrevHash = lastHash;
    expectedNextSeq = parsed.seq + 1;
    records++;
  }

  return {
    file: filePath,
    ok: breaks.length === 0,
    records,
    breaks,
    firstSeq,
    lastSeq,
    lastHash,
    genesis,
  };
}

/**
 * Verify the whole ledger chain in a directory: every surviving roll
 * (gzipped or bare) plus the current events.jsonl, ordered by first seq,
 * with prevHash and seq threaded ACROSS file boundaries.
 *
 * .unchained.jsonl files (pre-chain evidence preserved by resume) are
 * reported but not walked.
 */
function verifyLedgerChain(dir) {
  const entries = fs.readdirSync(dir);
  const unchained = entries.filter((name) => name.endsWith('.unchained.jsonl'));
  const rollNames = entries.filter(
    (name) => /^events-.+\.jsonl(\.gz)?$/.test(name)
      && !name.endsWith('.unchained.jsonl')
      && !name.endsWith('.tmp')
  );

  const files = rollNames.map((name) => path.join(dir, name));
  const current = path.join(dir, LEDGER_FILENAME);
  if (fs.existsSync(current)) files.push(current);

  // Order by each file's first record seq — robust against same-millisecond
  // rotation stamps.
  const withFirstSeq = files.map((file) => {
    let firstSeq = Number.POSITIVE_INFINITY;
    try {
      for (const line of readLedgerLines(file)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && Number.isFinite(parsed.seq)) {
            firstSeq = parsed.seq;
            break;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // unreadable file — verifyLedgerFile below will surface it
    }
    return { file, firstSeq };
  });
  withFirstSeq.sort((a, b) => a.firstSeq - b.firstSeq);

  const results = [];
  const breaks = [];
  let expectedPrevHash = null; // unverifiable anchor until the first record
  let expectedNextSeq = null;

  for (const { file } of withFirstSeq) {
    let result;
    try {
      result = verifyLedgerFile(file, { expectedPrevHash, expectedNextSeq });
    } catch (error) {
      result = {
        file,
        ok: false,
        records: 0,
        breaks: [{ file, index: -1, reason: 'unreadable', error: error?.message }],
        firstSeq: null,
        lastSeq: null,
        lastHash: null,
        genesis: false,
      };
    }
    results.push(result);
    breaks.push(...result.breaks);
    if (result.lastHash !== null) {
      expectedPrevHash = result.lastHash;
      expectedNextSeq = result.lastSeq + 1;
    }
  }

  return {
    ok: breaks.length === 0,
    files: results,
    breaks,
    unchained: unchained.map((name) => path.join(dir, name)),
    genesis: results.length > 0 && results[0].genesis === true,
  };
}

module.exports = {
  EventLedger,
  verifyLedgerFile,
  verifyLedgerChain,
  sha256Line,
  GENESIS,
  DEFAULT_MAX_BYTES,
  DEFAULT_KEEP_ROLLS,
  LEDGER_FILENAME,
};

```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Add the EventLedger require next to the other Phase A hardening requires. Anchor is grep-verified unique (1 hit, line 16). Replace the anchor line with anchor + new line.

### Anchor
```
const { TelemetryCollector } = require('./telemetry-collector');
```

### Code
```js
const { TelemetryCollector } = require('./telemetry-collector');
const { EventLedger } = require('./event-ledger');
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Construct the ledger in the orchestrator constructor (after TelemetryCollector, before the shutdownHandler line, lines 249-250). Two-line anchor is unique; neither line has trailing whitespace. config.ledger is a NEW config namespace (ledger.maxBytes / ledger.keepRolls); ConfigValidator is non-breaking so no validator change is needed.

### Anchor
```
    this.telemetry = new TelemetryCollector(config, logger, this.logsDir);
    this.shutdownHandler = null; // Created after initialization
```

### Code
```js
    this.telemetry = new TelemetryCollector(config, logger, this.logsDir);
    // Fix 2.4 (H5): durable events ledger — monotonic seq across restarts,
    // sha256 prevHash chain, size-capped rotation + gzip + retention.
    this.eventLedger = new EventLedger(this.logsDir, {
      maxBytes: config.ledger?.maxBytes,
      keepRolls: config.ledger?.keepRolls,
      logger,
    });
    this.shutdownHandler = null; // Created after initialization
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Open the ledger during initialize(), right after telemetry init (lines 563-565). WARNING: the line immediately AFTER this anchor (line 566) is a blank line containing four trailing spaces — do NOT include it in the anchor; the three anchor lines themselves are clean. Ledger init is non-fatal by design (saves are sacred, the ledger is nonessential — H4 posture).

### Anchor
```
    // Phase A: Initialize telemetry
    await this.telemetry.initialize();
    this.telemetry.emitLifecycleEvent('initialized');
```

### Code
```js
    // Phase A: Initialize telemetry
    await this.telemetry.initialize();
    this.telemetry.emitLifecycleEvent('initialized');

    // Fix 2.4 (H5): open the durable events ledger (seq resume from the tail
    // of events.jsonl + hash chain + rotation). Non-fatal — the ledger must
    // never block a run.
    try {
      await this.eventLedger.initialize();
    } catch (error) {
      this.logger.warn('Event ledger init failed (non-fatal)', { error: error.message });
    }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Ledger the cycle start (executeCycle entry, lines 1217-1219; `this.cycleCount++;` is grep-verified unique in the file). log() is a synchronous enqueue that never throws — no await, no cycle latency.

### Anchor
```
  async executeCycle() {
    const cycleStart = new Date();
    this.cycleCount++;
```

### Code
```js
  async executeCycle() {
    const cycleStart = new Date();
    this.cycleCount++;
    this.eventLedger?.log('cycle_start', { cycle: this.cycleCount });
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Ledger the cycle completion (lines 3292-3293; the logger line contains a literal U+2713 checkmark and is grep-verified unique). WARNING: the line AFTER this anchor (3294) is a blank line with six trailing spaces — do not include it. Note the consolidation-mode early return (line ~1272) intentionally logs cycle_start without cycle_complete; cycle progress signaling is H1's heartbeat job, not the ledger's.

### Anchor
```
      const cycleDuration = Date.now() - cycleStart.getTime();
      this.logger.info(`✓ Cycle completed in ${cycleDuration}ms (GPT-5.2)`);
```

### Code
```js
      const cycleDuration = Date.now() - cycleStart.getTime();
      this.logger.info(`✓ Cycle completed in ${cycleDuration}ms (GPT-5.2)`);
      this.eventLedger?.log('cycle_complete', { cycle: this.cycleCount, durationMs: cycleDuration });
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Close the ledger at the end of stop() (line 9390, grep-verified unique). WARNING: the line BEFORE it (9389) is a blank line with four trailing spaces — anchor on the logger line alone. close() awaits queued appends and background gzip jobs; both are small and local, so this cannot meaningfully delay the bounded shutdown path (and it runs AFTER saveStateForShutdown/marker logic — state saving order is untouched).

### Anchor
```
    this.logger.info('GPT-5.2 system stopped');
```

### Code
```js
    // Fix 2.4 (H5): flush and close the events ledger (queued appends +
    // background gzip jobs; never throws into shutdown).
    if (this.eventLedger) {
      try {
        await this.eventLedger.close();
      } catch (error) {
        this.logger.warn('Event ledger close failed (non-fatal)', { error: error.message });
      }
    }

    this.logger.info('GPT-5.2 system stopped');
```

## CHANGE: cosmo23/engine/src/event-logger.js

FULL REPLACEMENT of the dead unbounded EventLogger with a compatibility facade over the H5 ledger. Zero callers exist (grep-verified across cosmo23 engine/server/launcher/lib), so the sync-to-async initialize()/close() change breaks nothing; the facade preserves the emitThought/emitCycle/emitGoal/emitAgent/emitWebSearch/emitCode/emit surface and drops the history-destroying cleanStart unlink.

### Anchor
```
class EventLogger {
```

### Code
```js
/**
 * Event Logger — compatibility facade over the durable EventLedger (H5).
 *
 * The legacy implementation appended to events.jsonl without bound and
 * reset eventCount every process. It now delegates to
 * core/event-ledger.js: monotonic seq across restarts, sha256 prevHash
 * chain, size-capped rotation with gzip + retention.
 *
 * API changes vs the legacy class (zero callers exist — grep-verified):
 *   - initialize() and close() are async.
 *   - initialize() no longer accepts cleanStart: the ledger is append-only;
 *     hygiene comes from rotation, never from unlinking history.
 */

'use strict';

const { EventLedger } = require('./core/event-ledger');

class EventLogger {
  constructor(runPath, opts = {}) {
    this.runPath = runPath;
    this.ledger = new EventLedger(runPath, opts);
    this.filePath = this.ledger.filePath;
  }

  get eventCount() {
    return this.ledger.seq;
  }

  async initialize() {
    await this.ledger.initialize();
    this.log({ type: 'session_start' });
  }

  log(event) {
    if (!event || typeof event !== 'object') return;
    const { type, ...data } = event;
    this.ledger.log(type || 'event', data);
  }

  // Convenience methods matching the event emitter API
  emitThought(data) { this.log({ type: 'thought_generated', ...data }); }
  emitCycle(data) { this.log({ type: 'cycle_start', ...data }); }
  emitGoal(data) { this.log({ type: 'goal_created', ...data }); }
  emitAgent(data) { this.log({ type: 'agent_spawned', ...data }); }
  emitWebSearch(data) { this.log({ type: 'web_search', ...data }); }
  emitCode(data) { this.log({ type: 'code_generation', ...data }); }
  emit(type, data) { this.log({ type, ...data }); }

  async close() {
    this.log({ type: 'session_end' });
    await this.ledger.close();
  }
}

module.exports = { EventLogger };

```

## CHANGE: package.json

Register the new suite in the cosmo23 node:test block of scripts.test, immediately after merge-engine-state-io. Anchor pair is grep-verified unique (1 hit) inside the single-line test command.

### Anchor
```
tests/cosmo23/merge-engine-state-io.test.cjs tests/cosmo23/model-catalog-builtin-coverage.test.cjs
```

### Code
```js
tests/cosmo23/merge-engine-state-io.test.cjs tests/cosmo23/event-ledger-hygiene.test.cjs tests/cosmo23/model-catalog-builtin-coverage.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration list (line 51; list is not strictly alphabetical, appending after the merge-engine entry matches house style). Anchor is grep-verified unique.

### Anchor
```
    'tests/cosmo23/merge-engine-state-io.test.cjs',
```

### Code
```js
    'tests/cosmo23/merge-engine-state-io.test.cjs',
    'tests/cosmo23/event-ledger-hygiene.test.cjs',
```

## TEST FILE: tests/cosmo23/event-ledger-hygiene.test.cjs

```js
'use strict';

// Fix 2.4 (contract H5): the cosmo23 events ledger must carry monotonic
// seq ids ACROSS restarts, a sha256 prevHash chain (GENESIS-rooted,
// continuing across rotation), size-capped rotation with async gzip and
// bounded retention, and an exported verifier that detects tampering and
// truncation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  EventLedger,
  verifyLedgerFile,
  verifyLedgerChain,
  sha256Line,
  GENESIS,
} = require('../../cosmo23/engine/src/core/event-ledger.js');

async function makeTmpDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function readRecords(filePath) {
  let raw = fs.readFileSync(filePath);
  if (filePath.endsWith('.gz')) raw = zlib.gunzipSync(raw);
  return raw
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

test('assigns monotonic seq and a GENESIS-rooted hash chain within a session', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-ledger-chain-');
  const ledger = new EventLedger(dir, { maxBytes: 1024 * 1024 });
  await ledger.initialize();
  await ledger.log('alpha', { value: 1 });
  await ledger.log('beta', { value: 2 });
  await ledger.close();

  const filePath = path.join(dir, 'events.jsonl');
  const records = readRecords(filePath);
  // ledger_open, alpha, beta, ledger_close
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4]);
  assert.equal(records[0].prevHash, GENESIS);
  assert.equal(records[0].type, 'ledger_open');
  assert.equal(records[3].type, 'ledger_close');

  const result = verifyLedgerFile(filePath, { expectedPrevHash: GENESIS, expectedNextSeq: 1 });
  assert.equal(result.ok, true, JSON.stringify(result.breaks));
  assert.equal(result.genesis, true);
  assert.equal(result.records, 4);
});

test('seq resumes across a simulated restart and the chain continues without a GENESIS reset', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-ledger-resume-');

  const first = new EventLedger(dir);
  await first.initialize();
  await first.log('boot1_event', { n: 1 });
  await first.close();

  const filePath = path.join(dir, 'events.jsonl');
  const beforeLines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const lastLineBefore = beforeLines[beforeLines.length - 1];

  // Simulated restart: a brand-new instance over the same directory.
  const second = new EventLedger(dir);
  await second.initialize();
  await second.log('boot2_event', { n: 2 });
  await second.close();

  const records = readRecords(filePath);
  // boot1: open(1), event(2), close(3); boot2: open(4), event(5), close(6)
  assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(records[3].type, 'ledger_open');
  assert.equal(
    records[3].prevHash,
    sha256Line(lastLineBefore),
    'first record of the new boot must link to the last line of the previous boot'
  );
  assert.equal(records.filter((r) => r.prevHash === GENESIS).length, 1, 'GENESIS appears exactly once');

  const result = verifyLedgerFile(filePath, { expectedPrevHash: GENESIS, expectedNextSeq: 1 });
  assert.equal(result.ok, true, JSON.stringify(result.breaks));
});

test('verifyLedgerFile detects in-place tampering of a middle record', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-ledger-tamper-');
  const ledger = new EventLedger(dir);
  await ledger.initialize();
  await ledger.log('payment', { amount: 10 });
  await ledger.log('payment', { amount: 20 });
  await ledger.close();

  const filePath = path.join(dir, 'events.jsonl');
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  // Tamper: rewrite amount 10 -> 999 in the second record (index 1).
  lines[1] = lines[1].replace('"amount":10', '"amount":999');
  fs.writeFileSync(filePath, lines.join('\n') + '\n');

  const result = verifyLedgerFile(filePath, { expectedPrevHash: GENESIS, expectedNextSeq: 1 });
  assert.equal(result.ok, false);
  assert.ok(
    result.breaks.some((b) => b.reason === 'prev_hash_mismatch'),
    `expected prev_hash_mismatch, got ${JSON.stringify(result.breaks)}`
  );
});

test('verifyLedgerFile flags seq gaps even when hashes are internally consistent', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-ledger-seqgap-');
  const filePath = path.join(dir, 'events.jsonl');

  // Handcraft a chain whose hashes are correct but whose seq skips 3.
  const lines = [];
  let prevHash = GENESIS;
  for (const seq of [1, 2, 4]) {
    const line = JSON.stringify({ type: 'evt', ts: new Date().toISOString(), seq, prevHash });
    lines.push(line);
    prevHash = sha256Line(line);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');

  const result = verifyLedgerFile(filePath, { expectedPrevHash: GENESIS, expectedNextSeq: 1 });
  assert.equal(result.ok, false);
  const seqBreaks = result.breaks.filter((b) => b.reason === 'seq_break');
  assert.equal(seqBreaks.length, 1);
  assert.equal(seqBreaks[0].expected, 3);
  assert.equal(seqBreaks[0].actual, 4);
  assert.ok(!result.breaks.some((b) => b.reason === 'prev_hash_mismatch'));
});

test('rotation rolls at maxBytes, gzips asynchronously, enforces retention, and the chain spans rolls', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-ledger-rotate-');
  const ledger = new EventLedger(dir, { maxBytes: 512, keepRolls: 2 });
  await ledger.initialize();
  for (let i = 0; i < 40; i++) {
    await ledger.log('bulk', { i, pad: 'x'.repeat(120) });
  }
  await ledger.close(); // close() flushes queued appends and gzip jobs

  const entries = await fsp.readdir(dir);
  const gzRolls = entries.filter((name) => /^events-.+\.jsonl\.gz$/.test(name));
  const bareRolls = entries.filter((name) => /^events-.+\.jsonl$/.test(name));
  const tmpFiles = entries.filter((name) => name.endsWith('.tmp'));

  assert.ok(entries.includes('events.jsonl'), 'live ledger file must exist');
  assert.ok(gzRolls.length >= 1, 'rotation must have produced gzipped rolls');
  assert.ok(gzRolls.length <= 2, `retention must keep at most keepRolls gz rolls, saw ${gzRolls.length}`);
  assert.equal(bareRolls.length, 0, 'all rolls must be gzipped after flush');
  assert.equal(tmpFiles.length, 0, 'no .tmp staging files may survive');

  // Chain must verify across the surviving rolls + current file. The anchor
  // is unverifiable (oldest rolls were pruned) but every subsequent link —
  // including the roll -> current-file boundary — must hold.
  const chain = verifyLedgerChain(dir);
  assert.equal(chain.ok, true, JSON.stringify(chain.breaks));
  assert.ok(chain.files.length >= 2, 'chain walk must cover rolls and the current file');

  // Seq must be strictly continuous across surviving files.
  const allSeqs = chain.files.flatMap((f) => [f.firstSeq, f.lastSeq]);
  for (let i = 1; i < chain.files.length; i++) {
    assert.equal(
      chain.files[i].firstSeq,
      chain.files[i - 1].lastSeq + 1,
      'seq must continue exactly across file boundaries'
    );
  }
  assert.ok(allSeqs.every((s) => Number.isFinite(s)));
});

test('cross-file truncation of a rolled file is detected by the chain walk', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-ledger-trunc-');
  const ledger = new EventLedger(dir, { maxBytes: 1024, keepRolls: 5 });
  await ledger.initialize();
  for (let i = 0; i < 10; i++) {
    await ledger.log('bulk', { i, pad: 'y'.repeat(120) });
  }
  await ledger.close();

  const gzRolls = (await fsp.readdir(dir)).filter((name) => /^events-.+\.jsonl\.gz$/.test(name));
  assert.ok(gzRolls.length >= 1, 'test requires at least one roll');

  // Truncate the last line off a roll that holds at least two records.
  const rollLines = gzRolls.map((name) => ({
    target: path.join(dir, name),
    lines: zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8').split('\n').filter(Boolean),
  }));
  const victim = rollLines.find((roll) => roll.lines.length >= 2);
  assert.ok(victim, 'test requires a roll with >=2 records');
  const { target, lines } = victim;
  const truncated = lines.slice(0, -1).join('\n') + '\n';
  fs.writeFileSync(target, zlib.gzipSync(Buffer.from(truncated, 'utf8')));

  const chain = verifyLedgerChain(dir);
  assert.equal(chain.ok, false, 'truncating a rolled file must break the chain');
  assert.ok(
    chain.breaks.some((b) => b.reason === 'prev_hash_mismatch' || b.reason === 'seq_break'),
    `expected a chain break, got ${JSON.stringify(chain.breaks)}`
  );
});

test('torn tail: resume skips the fragment, guards with a newline, and seq continues', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-ledger-torn-');
  const first = new EventLedger(dir);
  await first.initialize();
  await first.log('evt', { n: 1 });
  await first.close(); // seq 1..3 (open, evt, close)

  const filePath = path.join(dir, 'events.jsonl');
  // Simulate a torn write: a partial record with NO trailing newline.
  fs.appendFileSync(filePath, '{"seq":999,"prevHash":"deadbeef","type":"torn');

  const second = new EventLedger(dir);
  await second.initialize();
  await second.log('evt', { n: 2 });
  await second.close();

  const records = readRecords(filePath);
  assert.deepEqual(
    records.map((r) => r.seq),
    [1, 2, 3, 4, 5, 6],
    'seq must resume from the last COMPLETE record, ignoring the torn fragment'
  );

  const result = verifyLedgerFile(filePath, { expectedPrevHash: GENESIS, expectedNextSeq: 1 });
  const reasons = result.breaks.map((b) => b.reason);
  assert.deepEqual(reasons, ['invalid_json'], 'only the torn fragment may be flagged');
  assert.equal(result.records, 6, 'all six real records must verify');
});

test('a legacy pre-chain events.jsonl is preserved aside and a fresh chain starts', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-ledger-legacy-');
  const filePath = path.join(dir, 'events.jsonl');
  // Old EventLogger format: eventId, no seq, no prevHash.
  fs.writeFileSync(
    filePath,
    '{"type":"session_start","eventId":1,"timestamp":1}\n{"type":"thought_generated","eventId":2,"timestamp":2}\n'
  );

  const ledger = new EventLedger(dir);
  await ledger.initialize();
  await ledger.log('evt', { n: 1 });
  await ledger.close();

  const entries = await fsp.readdir(dir);
  const unchained = entries.filter((name) => name.endsWith('.unchained.jsonl'));
  assert.equal(unchained.length, 1, 'legacy file must be preserved as .unchained.jsonl');
  const preserved = fs.readFileSync(path.join(dir, unchained[0]), 'utf8');
  assert.ok(preserved.includes('"eventId":2'), 'legacy content must survive byte-for-byte');

  const records = readRecords(filePath);
  assert.equal(records[0].prevHash, GENESIS);
  assert.deepEqual(records.map((r) => r.seq), [1, 2, 3]);

  const chain = verifyLedgerChain(dir);
  assert.equal(chain.ok, true, JSON.stringify(chain.breaks));
  assert.equal(chain.unchained.length, 1);
});

test('reserved fields cannot be spoofed by payload data', async (t) => {
  const dir = await makeTmpDir(t, 'cosmo23-ledger-spoof-');
  const ledger = new EventLedger(dir);
  await ledger.initialize();
  await ledger.log('evt', { seq: 999999, prevHash: 'spoofed', type: 'other' });
  await ledger.close();

  const records = readRecords(path.join(dir, 'events.jsonl'));
  assert.equal(records[1].seq, 2);
  assert.notEqual(records[1].prevHash, 'spoofed');
  assert.equal(records[1].type, 'evt');

  const result = verifyLedgerFile(path.join(dir, 'events.jsonl'), {
    expectedPrevHash: GENESIS,
    expectedNextSeq: 1,
  });
  assert.equal(result.ok, true, JSON.stringify(result.breaks));
});

```

## API NOTES

VALIDATION: module + full test suite were validated standalone in the session scratchpad (/private/tmp/claude-501/.../scratchpad/ledgercheck, mirroring the repo layout so the delivered relative require path '../../cosmo23/engine/src/core/event-ledger.js' was exercised as-is): 9/9 pass under `node --test --test-concurrency=1`. NO repository file was created, edited, or stashed at any point — nothing to revert.

TARGET MISMATCH (important for the implementer): the task named cosmo23/engine/src/core/event-logger.js; the real files are cosmo23/engine/src/event-logger.js and cosmo23/engine/src/realtime/event-logger.js. Both are DEAD CODE — zero requires anywhere in cosmo23 (engine/server/launcher/lib, grep-verified) and no events.jsonl exists in any run dir (all of cosmo23/runs/ checked, including live labor23). So this fix creates the H5 ledger as a new core module, wires it into the orchestrator (first-ever durable event sink), and rewrites the dead src/event-logger.js as a compat facade so the unbounded/per-process-count implementation ceases to exist. realtime/event-logger.js is left untouched (also dead; it extends COSMOEventEmitter and is entangled with the SSE emitter class — deleting/porting it is a separate cleanup, YAGNI).

DONOR MISMATCHES (verified by reading, per H6): NEITHER donor implements H5. home23 engine/src/core/event-ledger.js has no seq, no prevHash chain, no tail-resume, no rotation — only a per-record payloadHash and the never-throw/best-effort posture (which I adopted). src/agent/event-ledger.ts has zero hash/prevHash/sha256 hits. The chain/rotation design here is written fresh to the H5 spec; do not go looking for it in the donors.

DESIGN DECISIONS: (1) Hash domain = the exact serialized JSON line WITHOUT trailing newline; prevHash of the first-ever record is 'GENESIS'; chain state carries in memory across rotation so the first record of a new file links to the rolled file's last record (H5). (2) Appends serialize on a promise queue — chain correctness requires strict ordering; log() is a sync enqueue returning a never-rejecting promise, so hot paths (executeCycle) never await it. (3) seq is assigned at WRITE time (not enqueue), so a failed append cannot burn a seq and create false gap alarms; a failed append also arms a newline guard so partial bytes can't garble the next record. (4) Tail resume: 4KB window per spec, widened to 64KB, full scan only as last resort; torn trailing fragments are never resumed from, are preserved as evidence (verifier flags exactly one invalid_json), and the next append is newline-guarded. A non-empty file with no seq-bearing parseable line (legacy format/corruption) is preserved aside as events-<stamp>.unchained.jsonl and the chain restarts at GENESIS — history is never unlinked. (5) Rotation renames to events-<ISO-stamp>.jsonl (H5 name), with a '-N' suffix only on same-millisecond collisions (reachable with tiny test caps); gzip is async via .gz.tmp + rename; retention prunes ONLY *.jsonl.gz (a bare roll is either mid-gzip or a crash orphan that the boot sweep re-gzips); verifyLedgerChain orders files by first seq (not filename) so same-ms rolls can't scramble the walk. (6) Honesty limit, stated in the module doc: a forward chain cannot detect truncation of the NEWEST file's tail in-file; it is detectable cross-file (next file's prevHash mismatch — tested) and at next boot via seq regression vs rolled files or a missing ledger_close.

WIRING/COMPOSITION: the ledger lives at this.eventLedger on the orchestrator — fixes 2.1/2.3 should emit durable events via `this.eventLedger?.log('watchdog_trip', {...})` etc. (never await it in a cycle). Ledger init/close are try/caught and log() never throws: per H4, a ledger failure can never block or degrade a state save. stop() closes the ledger AFTER saveStateForShutdown/marker logic — persistence ordering is untouched. Consolidation-mode cycles log cycle_start but return before cycle_complete (deliberate; progress signaling is H1's heartbeat, not the ledger). Config knobs are ledger.maxBytes (default 50MB) and ledger.keepRolls (default 5) read via config.ledger?.* — a new YAML namespace; ConfigValidator is non-breaking so no validator change is required (optionally add an info-level note there as a follow-up).

ANCHOR WARNINGS: orchestrator.js contains trailing-whitespace-only blank lines adjacent to two anchors — line 566 (four spaces, after the telemetry-init anchor) and line 3294 (six spaces, after the cycle-complete anchor) and line 9389 (four spaces, before the stop() anchor). All proposed anchors were chosen to exclude those lines and were grep-verified unique (counts: TelemetryCollector require=1, shutdownHandler comment line=1, 'await this.telemetry.initialize();'=1, 'this.cycleCount++;'=1, 'Cycle completed in'=1, 'GPT-5.2 system stopped'=1, package.json pair=1, registration-list line=1). The cycle-complete anchor contains a literal U+2713 '✓' character — copy it exactly.

THOUGHTS/DREAMS/VOICE (surveyed, rotation NOT proposed — YAGNI per task): three separate inline fs.appendFile call sites in orchestrator.js (logThought 7976-7985, saveDream 7987-7999, voice 8029-8034), no shared writer; readers assume single files (insight-curator.js:301 reads thoughts.jsonl whole; merge-engine.js:2199 archives it; context-providers.js:198-202 voice TODO). Observed growth is KB-scale (max 180KB thoughts.jsonl across all runs) and bounded per run by maxCycles/maxRuntimeMinutes. FOLLOW-UP (if ever needed): extract a shared appendJsonl helper on the orchestrator and reuse EventLedger's rotation internals; must update insight-curator and merge-engine readers in the same change. Other unbounded streams recorded in targetCurrentState (receipts/evaluation/coordinator queues) are likewise out of scope.

RISKS: low. The ledger is additive and non-fatal everywhere; the only behavioral deltas on live runs are a new events.jsonl in the run dir (name previously unused — verified absent in all runs) and a bounded flush during stop(). Not persistence-adjacent (no saveState/loadState paths touched), so the sacred-persistence restart protocol is not triggered by this change alone — but it will land alongside other Phase 2 fixes, so the standalone load test before any engine restart still applies to the batch.
