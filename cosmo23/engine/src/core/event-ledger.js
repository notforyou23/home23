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
      .map((name) => {
        // events-<stamp>.jsonl.gz or events-<stamp>-<n>.jsonl.gz (same-ms
        // collision suffix). A plain lexical sort mis-orders the suffixed
        // forms ('-' sorts before '.', and -10 before -2), which would
        // prune chronologically NEWER rolls and tear a seq gap into the
        // surviving chain — so sort by (stamp, numeric suffix) instead.
        const base = name.slice('events-'.length, -'.jsonl.gz'.length);
        const match = base.match(/^(.*Z)-(\d+)$/);
        return {
          name,
          stamp: match ? match[1] : base,
          n: match ? Number(match[2]) : 0,
        };
      })
      .sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.n - b.n));
    const excess = rolls.length - this.keepRolls;
    for (let i = 0; i < excess; i++) {
      await fsp.unlink(path.join(this.dir, rolls[i].name)).catch(() => {});
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
