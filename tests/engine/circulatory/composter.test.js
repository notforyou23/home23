// Residence-Time Admission for the Composter (From The Inside — Unit 4).
//
// The composter is a log-only janitor for discarded-thoughts.jsonl. It admits a
// composting pass when EITHER a valid-entry count threshold OR an oldest-valid-
// entry residence-age threshold is met, reports operational evidence (valid
// count, oldest age, observed arrival rate), then extracts patterns and
// truncates. It must NEVER write a brain node. Missing/empty/entirely malformed
// input is a safe no-op that does not truncate.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Composter } = require('../../../engine/src/circulatory/composter.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function mkBrainDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'composter-'));
}

function writeLines(brainDir, lines) {
  fs.writeFileSync(
    path.join(brainDir, 'discarded-thoughts.jsonl'),
    lines.join('\n') + (lines.length ? '\n' : ''),
  );
}

function readFile(brainDir) {
  return fs.readFileSync(path.join(brainDir, 'discarded-thoughts.jsonl'), 'utf8');
}

// A memory graph that records ANY method invocation, so we can assert the
// composter never writes a node (no addNode / compost_receipt revival).
function recordingMemory() {
  const calls = [];
  const proxy = new Proxy(
    {},
    { get: (_t, prop) => (...args) => { calls.push({ prop: String(prop), args }); } },
  );
  return { memory: proxy, calls };
}

function entry(overrides = {}) {
  return JSON.stringify({ reason: 'novelty', candidate: { signal: 'probe' }, ...overrides });
}

test('count-trigger: valid-entry count at threshold admits, truncates, reports rate', async () => {
  const brainDir = mkBrainDir();
  const now = 10 * DAY;
  // 4 entries, one per hour ending at `now` -> span 3h, rate (4-1)/3 = 1/hr.
  const lines = [
    entry({ ts: now - 3 * HOUR }),
    entry({ ts: now - 2 * HOUR }),
    entry({ ts: now - 1 * HOUR }),
    entry({ ts: now }),
  ];
  writeLines(brainDir, lines);

  const c = new Composter({ brainDir, countThreshold: 4, oldestAgeThresholdMs: 30 * DAY });
  const result = await c.tick(now);

  assert.ok(result, 'compost should run');
  assert.equal(result.entriesProcessed, 4);
  assert.equal(result.evidence.validEntryCount, 4);
  assert.equal(result.evidence.oldestValidEntryAgeMs, 3 * HOUR);
  assert.equal(result.evidence.arrivalRatePerHour, 1);
  assert.equal(result.evidence.trigger, 'count');
  assert.equal(readFile(brainDir), '', 'file truncated after compost');
});

test('age-trigger below count threshold: stale oldest entry admits', async () => {
  const brainDir = mkBrainDir();
  const now = 10 * DAY;
  const lines = [
    entry({ ts: now - 5000 }),
    entry({ ts: now - 100 }),
  ];
  writeLines(brainDir, lines);

  // Count threshold far above 2; short residence bound so 5000ms is stale.
  const c = new Composter({ brainDir, countThreshold: 500, oldestAgeThresholdMs: 1000 });
  const result = await c.tick(now);

  assert.ok(result, 'age should admit even below count threshold');
  assert.equal(result.evidence.validEntryCount, 2);
  assert.equal(result.evidence.oldestValidEntryAgeMs, 5000);
  assert.equal(result.evidence.trigger, 'age');
  assert.equal(readFile(brainDir), '');
});

test('below both thresholds: safe no-op, file not truncated', async () => {
  const brainDir = mkBrainDir();
  const now = 10 * DAY;
  const lines = [entry({ ts: now - 100 }), entry({ ts: now - 50 })];
  writeLines(brainDir, lines);
  const before = readFile(brainDir);

  const c = new Composter({ brainDir, countThreshold: 500, oldestAgeThresholdMs: DAY });
  const result = await c.tick(now);

  assert.equal(result, null, 'no trigger -> no compost');
  assert.equal(readFile(brainDir), before, 'file preserved when nothing triggers');
});

test('malformed/missing timestamps: valid entries still count-trigger; age uses only valid ts', async () => {
  const brainDir = mkBrainDir();
  const now = 10 * DAY;
  // 3 valid JSON entries, but none carry a usable timestamp.
  const lines = [
    entry({ ts: 'not-a-date' }),
    entry({}), // missing ts entirely
    entry({ ts: null }),
  ];
  writeLines(brainDir, lines);

  const c = new Composter({ brainDir, countThreshold: 3, oldestAgeThresholdMs: 1000 });
  const result = await c.tick(now);

  assert.ok(result, 'count trigger fires regardless of timestamp validity');
  assert.equal(result.evidence.validEntryCount, 3);
  assert.equal(result.evidence.timestampedCount, 0);
  assert.equal(result.evidence.oldestValidEntryAgeMs, null, 'no valid ts -> no age');
  assert.equal(result.evidence.arrivalRatePerHour, null, 'no false-precision rate');
  assert.equal(result.evidence.trigger, 'count');
  assert.equal(readFile(brainDir), '');
});

test('entirely malformed JSONL: safe no-op, no truncation', async () => {
  const brainDir = mkBrainDir();
  const now = 10 * DAY;
  writeLines(brainDir, ['}{ not json', 'garbage', '###', '{ "unterminated": ']);
  const before = readFile(brainDir);

  // Even a trivially-low count threshold must not admit: zero VALID entries.
  const c = new Composter({ brainDir, countThreshold: 1, oldestAgeThresholdMs: 1 });
  const result = await c.tick(now);

  assert.equal(result, null, 'no valid entries -> no-op');
  assert.equal(readFile(brainDir), before, 'malformed input must not be truncated');
});

test('empty file: safe no-op, no truncation', async () => {
  const brainDir = mkBrainDir();
  writeLines(brainDir, []);
  const c = new Composter({ brainDir, countThreshold: 1, oldestAgeThresholdMs: 1 });
  const result = await c.tick(10 * DAY);
  assert.equal(result, null);
  assert.equal(readFile(brainDir), '', 'empty stays empty (unchanged)');
});

test('missing file: safe no-op', async () => {
  const brainDir = mkBrainDir();
  const c = new Composter({ brainDir, countThreshold: 1, oldestAgeThresholdMs: 1 });
  assert.equal(await c.tick(10 * DAY), null);
});

test('post-compost truncation empties the file and advances totalComposted', async () => {
  const brainDir = mkBrainDir();
  const now = 10 * DAY;
  const lines = Array.from({ length: 6 }, (_, i) => entry({ ts: now - i * HOUR }));
  writeLines(brainDir, lines);

  const c = new Composter({ brainDir, countThreshold: 6, oldestAgeThresholdMs: 30 * DAY });
  await c.tick(now);

  assert.equal(readFile(brainDir), '', 'truncated to empty');
  assert.equal(c.getStats().totalComposted, 6);
});

test('never writes a brain node (log-only, no compost_receipt)', async () => {
  const brainDir = mkBrainDir();
  const now = 10 * DAY;
  const lines = Array.from({ length: 5 }, (_, i) => entry({ ts: now - i * HOUR }));
  writeLines(brainDir, lines);

  const { memory, calls } = recordingMemory();
  const c = new Composter({ brainDir, memory, countThreshold: 5, oldestAgeThresholdMs: 30 * DAY });
  const result = await c.tick(now);

  assert.ok(result, 'compost ran');
  assert.equal(calls.length, 0, `memory must never be touched; got: ${JSON.stringify(calls)}`);
});

test('default thresholds preserved: count 500, bounded oldest-age', () => {
  const c = new Composter({ brainDir: '/tmp/none' });
  assert.equal(c.countThreshold, 500);
  assert.equal(typeof c.oldestAgeThresholdMs, 'number');
  assert.ok(c.oldestAgeThresholdMs > 0 && Number.isFinite(c.oldestAgeThresholdMs), 'bounded default');
});
