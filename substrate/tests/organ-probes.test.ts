/**
 * THE PROBE AUDIT (2026-08-13).
 *
 * Every probe in this suite is an instrument that answers "is this organ
 * alive?", and on 2026-08-13 one of them — seed-thought — was found reading
 * GREEN through a 43% lifetime thought-failure rate on jerry, 33% on forrest,
 * 10-of-10 blackout windows on both, and a 21-hour silence. The audit that
 * followed found the same defect shape in three more probes.
 *
 * The shape: EVERY no-data branch returned green. Missing input, unparseable
 * output, an organ deleted outright — all of it graded as health, because
 * "I found nothing wrong" was implemented as "nothing is wrong".
 *
 * The house rule these tests enforce is already law here: never trust a
 * negative until the instrument is proven to fire on a known positive. That
 * rule was written for scans of the brain and was never applied to the probes
 * themselves. This file applies it. Each probe is proven to go RED on the
 * failures it exists to catch, and to stay GREEN on ordinary health — because
 * an alarm that cries wolf gets ignored, which is its own kind of blindness.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  judgePm2, judgeEngines, judgePi, probeSeedThought, probeShipperFlow, probeBobbyMirror,
  type Pm2App,
} from '../bin/organ-probes.js';

function scratch(): string { return mkdtempSync(join(tmpdir(), 'probe-audit-')); }
const online = (name: string): Pm2App => ({ name, pm2_env: { status: 'online', restart_time: 0, pm_uptime: Date.now() } });

// ── pm2 ──────────────────────────────────────────────────────────────────────

test('pm2: an organ the ecosystem declares but pm2 has never heard of is RED, not absent', () => {
  const r = judgePm2([online('home23-jerry')], ['home23-jerry', 'home23-jerry-shipper']);
  const gone = r.find((x) => x.organ === 'pm2:jerry-shipper');
  assert.ok(gone !== undefined, 'a declared-but-missing organ must produce a row at all');
  assert.equal(gone.ok, false);
  assert.match(gone.why, /ABSENT FROM PM2/);
});

test('pm2: unreadable pm2 is RED — it cannot confirm ANY organ', () => {
  const r = judgePm2(null, ['home23-jerry']);
  assert.equal(r.every((x) => !x.ok), true);
});

test('pm2: a stopped organ is RED, and a healthy fleet is GREEN', () => {
  assert.equal(judgePm2([{ name: 'home23-jerry', pm2_env: { status: 'stopped' } }], []).every((x) => !x.ok), true);
  assert.equal(judgePm2([online('home23-jerry')], ['home23-jerry']).every((x) => x.ok), true);
});

// ── engines ──────────────────────────────────────────────────────────────────

test('engines: pm2 unreadable reports RED rather than reporting nothing', () => {
  const r = judgeEngines(null, ['home23-jerry']);
  assert.equal(r.length, 1, 'must not return an empty array — silence reads as health');
  assert.equal(r[0]?.ok, false);
});

test('engines: an engine missing from pm2 is RED', () => {
  const r = judgeEngines([online('home23-forrest')], ['home23-jerry']);
  assert.equal(r[0]?.ok, false);
  assert.match(r[0]?.why ?? '', /ABSENT FROM PM2/);
});

test('engines: a single deliberate restart is GREEN; rising restarts are RED', () => {
  const app = (n: number): Pm2App[] => [{ name: 'home23-x', pm2_env: { status: 'online', restart_time: n, pm_uptime: Date.now() } }];
  assert.equal(judgeEngines(app(9), ['home23-x'])[0]?.ok, true, 'first observation cannot be churn');
  assert.equal(judgeEngines(app(9), ['home23-x'])[0]?.ok, true, 'steady count is not churn');
  assert.equal(judgeEngines(app(11), ['home23-x'])[0]?.ok, false, 'count rising between observations IS churn');
});

// ── pi ───────────────────────────────────────────────────────────────────────

test('pi: malformed output is RED — Number("?") is NaN and NaN>0 is false', () => {
  const r = judgePi('runner=ok; sense=ok; journal=ok');   // stale_requests missing
  const ex = r.find((x) => x.organ === 'bobby-exchange');
  assert.equal(ex?.ok, false, 'an unparseable answer is not a healthy answer');
  assert.match(ex?.why ?? '', /unparseable/);
});

test('pi: no response is RED; a dead runner is RED; a serviced exchange is GREEN', () => {
  assert.equal(judgePi(null).every((x) => !x.ok), true);
  assert.equal(judgePi('runner=dead sense=ok journal=ok stale_requests=0').find((x) => x.organ === 'bobby-runner')?.ok, false);
  assert.equal(judgePi('runner=ok sense=ok journal=ok stale_requests=0').every((x) => x.ok), true);
  assert.equal(judgePi('runner=ok sense=ok journal=ok stale_requests=3').find((x) => x.organ === 'bobby-exchange')?.ok, false);
});

// ── seed thought: can this individual still form a thought? ──────────────────

function chain(root: string, agent: string, recs: Array<{ minAgo: number; failed: boolean }>): void {
  const d = join(root, 'instances', agent, 'substrate', 'seed-01');
  mkdirSync(d, { recursive: true });
  const lines = recs.map((r) => JSON.stringify({
    seq: 1, category: 'lobe',
    issuedAt: new Date(Date.now() - r.minAgo * 60_000).toISOString(),
    payload: r.failed ? { error: '401 OAuth access token has expired' } : { appliedDeltas: [{}] },
  }));
  writeFileSync(join(d, 'seed-ledger.jsonl'), lines.join('\n') + '\n');
}

test('seed-thought: chronic interleaved failure is RED (the defect that shipped)', () => {
  const root = scratch();
  // fail,fail,ok,fail,fail,ok… — never two failures at the tail, so the old
  // last-two-must-both-fail rule graded 80% failure as perfect health.
  chain(root, 'a', [...Array(15).keys()].map((i) => ({ minAgo: 150 - i * 10, failed: i % 5 !== 0 })));
  const r = probeSeedThought('a', root);
  assert.equal(r.ok, false);
  assert.match(r.why, /FAILED/);
});

test('seed-thought: an individual that stopped thinking is RED', () => {
  const root = scratch();
  chain(root, 'a', [...Array(10).keys()].map((i) => ({ minAgo: 600 - i * 10, failed: false })));
  const r = probeSeedThought('a', root);
  assert.equal(r.ok, false);
  assert.match(r.why, /HAS NOT THOUGHT/);
});

test('seed-thought: no thought on record, and an unreadable chain, are both RED', () => {
  const root = scratch();
  const d = join(root, 'instances', 'a', 'substrate', 'seed-01');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'seed-ledger.jsonl'), JSON.stringify({ seq: 1, category: 'transition', issuedAt: new Date().toISOString(), payload: {} }) + '\n');
  assert.equal(probeSeedThought('a', root).ok, false);
  assert.equal(probeSeedThought('nonexistent', root).ok, false);
});

test('seed-thought: healthy is GREEN, and one transient failure does NOT cry wolf', () => {
  const root = scratch();
  chain(root, 'ok', [...Array(10).keys()].map((i) => ({ minAgo: 100 - i * 10, failed: false })));
  assert.equal(probeSeedThought('ok', root).ok, true);
  chain(root, 'blip', [...Array(10).keys()].map((i) => ({ minAgo: 100 - i * 10, failed: i === 4 })));
  const r = probeSeedThought('blip', root);
  assert.equal(r.ok, true, 'a single 401 among ten thoughts is a watch item, not an alarm');
  assert.match(r.why, /watch/);
});

// ── shipper flow ─────────────────────────────────────────────────────────────

function conv(root: string, agent: string, files: string[], streamTsMinAgo: number | null): void {
  const c = join(root, 'instances', agent, 'conversations');
  const s = join(root, 'instances', agent, 'substrate');
  mkdirSync(c, { recursive: true }); mkdirSync(s, { recursive: true });
  // A REAL turn dated now — the old fixture wrote '{}' and so contained no
  // shippable turn at all, which meant this helper never exercised lag.
  for (const f of files) {
    writeFileSync(join(c, f), JSON.stringify({ role: 'user', content: 'a real turn', ts: new Date().toISOString() }) + '\n');
  }
  if (streamTsMinAgo !== null) {
    writeFileSync(join(s, 'conversation-stream.jsonl'),
      JSON.stringify({ ts: new Date(Date.now() - streamTsMinAgo * 60_000).toISOString() }) + '\n');
  }
}

test('shipper-flow: an empty conversations dir is RED — the probe was measuring nothing', () => {
  const root = scratch();
  conv(root, 'a', [], 0);
  const r = probeShipperFlow('a', root);
  assert.equal(r.ok, false);
  assert.match(r.why, /EMPTY/);
});

test('shipper-flow: files present but none matching the pattern is RED (regex drift)', () => {
  const root = scratch();
  conv(root, 'a', ['some-new-naming-scheme.jsonl'], 0);
  const r = probeShipperFlow('a', root);
  assert.equal(r.ok, false);
  assert.match(r.why, /NONE match/);
});

test('shipper-flow: NON-TURN records bumping mtime do NOT read as lag', () => {
  // The false positive that shipped (2026-08-13): jerry read "61min behind"
  // while nothing was unshipped. Conversation files carry stream events and
  // turn-completion markers with no `content` and sometimes no `ts`; they bump
  // the file's mtime without producing a shippable turn. The probe compared
  // mtime against the stream's content timestamp — different quantities.
  const root = scratch();
  const c = join(root, 'instances', 'a', 'conversations');
  const s = join(root, 'instances', 'a', 'substrate');
  mkdirSync(c, { recursive: true }); mkdirSync(s, { recursive: true });
  const shipped = new Date(Date.now() - 70 * 60_000).toISOString();
  writeFileSync(join(c, 'a__ios_x.jsonl'), [
    JSON.stringify({ role: 'user', content: 'a real turn', ts: shipped }),
    // …then an hour of plumbing residue, freshly written:
    JSON.stringify({ kind: 'delta', type: 'stream', seq: 1, turn_id: 't', data: {}, ts: new Date().toISOString() }),
    JSON.stringify({ type: 'turn_end', role: 'assistant', chat_id: 'c', status: 'ok', turn_id: 't' }),
  ].join('\n') + '\n');
  writeFileSync(join(s, 'conversation-stream.jsonl'), JSON.stringify({ ts: shipped }) + '\n');

  const r = probeShipperFlow('a', root);
  assert.equal(r.ok, true, 'a shipper that has shipped every real turn is HEALTHY, whatever mtime says');
  assert.match(r.why, /current/);
});

test('shipper-flow: a genuinely unshipped TURN is still RED', () => {
  const root = scratch();
  const c = join(root, 'instances', 'a', 'conversations');
  const s = join(root, 'instances', 'a', 'substrate');
  mkdirSync(c, { recursive: true }); mkdirSync(s, { recursive: true });
  writeFileSync(join(c, 'a__ios_x.jsonl'), [
    JSON.stringify({ role: 'user', content: 'shipped long ago', ts: new Date(Date.now() - 120 * 60_000).toISOString() }),
    JSON.stringify({ role: 'assistant', content: 'THIS never reached the stream', ts: new Date(Date.now() - 5 * 60_000).toISOString() }),
  ].join('\n') + '\n');
  writeFileSync(join(s, 'conversation-stream.jsonl'),
    JSON.stringify({ ts: new Date(Date.now() - 120 * 60_000).toISOString() }) + '\n');

  const r = probeShipperFlow('a', root);
  assert.equal(r.ok, false, 'real language that never reached the seed must still alarm');
  assert.match(r.why, /unshipped/);
});

test('shipper-flow: a lagging stream is RED, a current stream is GREEN', () => {
  const rootLag = scratch();
  conv(rootLag, 'a', ['a__ios_x.jsonl'], 600);          // stream tail 10h behind now
  assert.equal(probeShipperFlow('a', rootLag).ok, false);
  const rootOk = scratch();
  conv(rootOk, 'a', ['a__ios_x.jsonl'], 0);
  assert.equal(probeShipperFlow('a', rootOk).ok, true);
});

// ── bobby mirror ─────────────────────────────────────────────────────────────

test('bobby-mirror: missing is RED, stale is RED, fresh is GREEN', () => {
  const root = scratch();
  assert.equal(probeBobbyMirror(root).ok, false, 'a missing mirror must not read healthy');
  const d = join(root, 'instances', 'bobby', 'seed-01-mirror');
  mkdirSync(d, { recursive: true });
  const p = join(d, 'seed-ledger.jsonl');
  writeFileSync(p, '{}\n');
  const stale = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(p, stale, stale);
  assert.equal(probeBobbyMirror(root).ok, false, 'an hour-old mirror is stalled');
  writeFileSync(p, '{}\n');
  assert.equal(probeBobbyMirror(root).ok, true);
});
