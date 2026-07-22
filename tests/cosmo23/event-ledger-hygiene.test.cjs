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

const ORCHESTRATOR_PATH = path.resolve(
  __dirname,
  '../../cosmo23/engine/src/core/orchestrator.js'
);
const FACADE_PATH = path.resolve(
  __dirname,
  '../../cosmo23/engine/src/event-logger.js'
);

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

test('orchestrator and compat facade are wired to the durable ledger', () => {
  // Source pins for wiring points that cannot be exercised without a full
  // subsystem stack (same pattern as the heartbeat suite): init after
  // telemetry, fire-and-forget cycle events, close in stop() AFTER the
  // shutdown save/marker logic.
  const src = fs.readFileSync(ORCHESTRATOR_PATH, 'utf8');

  assert.ok(
    src.includes("const { EventLedger } = require('./event-ledger');"),
    'orchestrator requires the ledger module'
  );
  assert.ok(
    src.includes('this.eventLedger = new EventLedger(this.logsDir, {'),
    'constructor builds the ledger on logsDir'
  );
  assert.ok(
    src.includes('await this.eventLedger.initialize();'),
    'initialize() opens the ledger (non-fatal)'
  );
  assert.ok(
    src.includes("this.eventLedger?.log('cycle_start', { cycle: this.cycleCount });"),
    'executeCycle ledgers cycle_start without awaiting'
  );
  assert.ok(
    src.includes("this.eventLedger?.log('cycle_complete', { cycle: this.cycleCount, durationMs: cycleDuration });"),
    'executeCycle ledgers cycle_complete without awaiting'
  );

  // Shutdown ordering: the ledger closes AFTER the bounded shutdown save +
  // crash-marker logic and before the final stopped log line.
  const saveIdx = src.indexOf('const saveResult = await this.saveStateForShutdown();');
  const closeIdx = src.indexOf('await this.eventLedger.close();');
  const stoppedIdx = src.indexOf("this.logger.info('GPT-5.2 system stopped');");
  assert.ok(saveIdx > -1, 'shutdown save call present');
  assert.ok(closeIdx > -1, 'stop() closes the ledger');
  assert.ok(stoppedIdx > -1, 'stop() logs the stopped line');
  assert.ok(saveIdx < closeIdx, 'ledger close must come AFTER the shutdown state save');
  assert.ok(closeIdx < stoppedIdx, 'ledger close must come before the final stopped log');

  // The dead unbounded EventLogger must now delegate to the H5 ledger and
  // must no longer unlink history on clean start.
  const facade = fs.readFileSync(FACADE_PATH, 'utf8');
  assert.ok(
    facade.includes("require('./core/event-ledger')"),
    'compat facade delegates to core/event-ledger'
  );
  assert.ok(
    !/\bunlink(Sync)?\s*\(/.test(facade),
    'facade must not unlink ledger history'
  );
});
