/**
 * Tests for the Companion Layer attention gate (Step 30, Piece 3).
 *
 * Deterministic: time is injected via nowMs so every verdict is reproducible.
 * Each HARD safety rule is covered, and assertions check both the decision and
 * the reason slug — the slugs are the gate's inspectable audit trail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AttentionGate,
  originFromChatId,
  type OutboundSignal,
} from '../../src/agent/attention/attention-gate.js';

const T0 = Date.parse('2026-08-05T12:00:00.000Z');
const fixedNow = (ms: number) => () => ms;

function sig(overrides: Partial<OutboundSignal> = {}): OutboundSignal {
  return { origin: 'cron', text: 'a resident update', ...overrides };
}

// ── HARD rule 1: user replies are never gated ──────────────────────────────

test('numeric chatId always surfaces even for pure telemetry', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ origin: 'cron', chatId: '123456789', kind: 'telemetry' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'user_reply_never_gated');
});

test('negative (group) numeric chatId still surfaces', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ chatId: '-1001234', kind: 'telemetry', severity: 'info' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'user_reply_never_gated');
});

test('origin user-reply always surfaces even with telemetry kind', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ origin: 'user-reply', chatId: 'cron-x', kind: 'telemetry' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'user_reply_never_gated');
});

// ── HARD rule 2: direct answers ────────────────────────────────────────────

test('isDirectAnswer surfaces regardless of kind', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ isDirectAnswer: true, kind: 'telemetry', severity: 'info' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'direct_answer_never_suppressed');
});

// ── HARD rule 3: failures ──────────────────────────────────────────────────

test('isFailure surfaces even when it would otherwise be low materiality', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ origin: 'cron', isFailure: true, kind: 'status' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'failure_must_surface');
});

// ── HARD rule 4: critical / emergency escalation ───────────────────────────

test('critical severity surfaces', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ origin: 'live-problems', severity: 'critical' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'critical_escalation');
});

test('emergency severity surfaces even during a protected rhythm', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ severity: 'emergency', jtrRhythm: 'sleep' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'critical_escalation');
});

// ── Telemetry / status routine noise must NOT surface ──────────────────────

test('routine telemetry with no materiality is suppressed', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ origin: 'good-life', kind: 'telemetry', severity: 'info' }));
  assert.equal(v.decision, 'suppress');
  assert.equal(v.reason, 'telemetry_noise_suppressed');
});

test('queue-depth health metric is suppressed as noise', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ kind: 'queue-depth' }));
  assert.equal(v.decision, 'suppress');
  assert.equal(v.reason, 'telemetry_noise_suppressed');
});

test('routine status is aggregated (not surfaced)', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ origin: 'cron', kind: 'status', severity: 'info' }));
  assert.equal(v.decision, 'aggregate');
  assert.equal(v.reason, 'aggregated_low_materiality');
});

// ── Materiality ────────────────────────────────────────────────────────────

test('requiresAction surfaces with action_required reason', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ requiresAction: true, kind: 'status' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'action_required');
});

test('anomaly kind surfaces', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ kind: 'anomaly' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'anomaly');
});

test('changesStory surfaces', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ changesStory: true, kind: 'status' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'changes_story');
});

test('explicitlyWatched surfaces', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ explicitlyWatched: true }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'explicitly_watched');
});

test('alert severity surfaces with mirrored severity slug', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ severity: 'alert' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'severity_alert');
});

// ── Duplicate suppression ──────────────────────────────────────────────────

test('duplicate within window suppressed; same key after window surfaces again', () => {
  let now = T0;
  const gate = new AttentionGate({ nowMs: () => now, dedupeWindowMs: 6 * 60 * 60 * 1000 });
  const s = sig({ requiresAction: true, dedupeKey: 'garage-open' });

  // First evaluation is material → surface. Caller records after a real surface.
  const first = gate.evaluate(s);
  assert.equal(first.decision, 'surface');
  gate.record(s);

  // Same key 1h later → duplicate suppressed even though still material.
  now = T0 + 60 * 60 * 1000;
  const dup = gate.evaluate(s);
  assert.equal(dup.decision, 'suppress');
  assert.equal(dup.reason, 'duplicate_suppressed');

  // Past the 6h window → key is stale, surfaces again.
  now = T0 + 7 * 60 * 60 * 1000;
  const revived = gate.evaluate(s);
  assert.equal(revived.decision, 'surface');
});

test('duplicate detection falls back to hashing text when no dedupeKey given', () => {
  let now = T0;
  const gate = new AttentionGate({ nowMs: () => now });
  const s = sig({ requiresAction: true, text: 'identical body' });
  assert.equal(gate.evaluate(s).decision, 'surface');
  gate.record(s);
  now = T0 + 1000;
  const dup = gate.evaluate(sig({ requiresAction: true, text: 'identical body' }));
  assert.equal(dup.decision, 'suppress');
  assert.equal(dup.reason, 'duplicate_suppressed');
});

// ── Protected rhythm ───────────────────────────────────────────────────────

test('protected rhythm aggregates a non-urgent notice', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ severity: 'notice', jtrRhythm: 'family-evening' }));
  assert.equal(v.decision, 'aggregate');
  assert.equal(v.reason, 'protected_rhythm_defers_non_urgent');
});

test('protected rhythm still surfaces a requiresAction signal', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ requiresAction: true, jtrRhythm: 'sleep' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'action_required');
});

test('protected rhythm still surfaces an urgent signal', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ severity: 'urgent', jtrRhythm: 'deep-work' }));
  assert.equal(v.decision, 'surface');
  assert.equal(v.reason, 'severity_urgent');
});

// ── Staleness ──────────────────────────────────────────────────────────────

test('stale non-material signal suppressed', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({
    severity: 'info',
    kind: 'observation',
    observedAtMs: T0 - 7 * 60 * 60 * 1000,
  }));
  assert.equal(v.decision, 'suppress');
  assert.equal(v.reason, 'stale_signal_deferred');
});

test('fresh non-material observation is aggregated, not suppressed as stale', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({
    severity: 'info',
    kind: 'observation',
    observedAtMs: T0 - 60 * 1000,
  }));
  assert.equal(v.decision, 'aggregate');
  assert.equal(v.reason, 'low_materiality_deferred');
});

// ── Default ────────────────────────────────────────────────────────────────

test('unknown low-materiality signal defaults to aggregate', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const v = gate.evaluate(sig({ origin: 'agency', text: 'thinking out loud' }));
  assert.equal(v.decision, 'aggregate');
  assert.equal(v.reason, 'low_materiality_deferred');
});

// ── Aggregation buffer + digest ────────────────────────────────────────────

test('aggregate buffer enqueues, counts, drains, and flush thresholds fire', () => {
  let now = T0;
  const gate = new AttentionGate({
    nowMs: () => now,
    aggregateFlushCount: 3,
    aggregateFlushMs: 30 * 60 * 1000,
  });
  assert.equal(gate.shouldFlushAggregate(), false);

  gate.enqueueAggregate(sig({ text: 'one' }));
  gate.enqueueAggregate(sig({ text: 'two' }));
  assert.equal(gate.pendingAggregateCount(), 2);
  assert.equal(gate.shouldFlushAggregate(), false);

  gate.enqueueAggregate(sig({ text: 'three' }));
  assert.equal(gate.shouldFlushAggregate(), true); // count threshold

  const drained = gate.drainAggregate();
  assert.equal(drained.length, 3);
  assert.equal(gate.pendingAggregateCount(), 0);
  assert.equal(gate.shouldFlushAggregate(), false);

  // Age-based flush: one item, then advance past aggregateFlushMs.
  gate.enqueueAggregate(sig({ text: 'lonely' }));
  assert.equal(gate.shouldFlushAggregate(), false);
  now = T0 + 31 * 60 * 1000;
  assert.equal(gate.shouldFlushAggregate(), true);
});

test('buildDigest concatenates, dedupes, and bounds output', () => {
  const gate = new AttentionGate({ nowMs: fixedNow(T0) });
  const digest = gate.buildDigest([
    sig({ origin: 'cron', text: 'backup done', dedupeKey: 'k1' }),
    sig({ origin: 'good-life', text: 'walk logged', dedupeKey: 'k2' }),
    sig({ origin: 'cron', text: 'backup done again', dedupeKey: 'k1' }), // deduped
  ]);
  assert.match(digest, /Held updates \(2\):/);
  assert.match(digest, /\[cron\] backup done/);
  assert.match(digest, /\[good-life\] walk logged/);

  const many = Array.from({ length: 200 }, (_, i) =>
    sig({ origin: 'cron', text: `event number ${i} with a fairly long descriptive body to fill space`, dedupeKey: `k${i}` }));
  const bounded = gate.buildDigest(many);
  assert.ok(bounded.length <= 1500, `digest length ${bounded.length} should be <= 1500`);
  assert.match(bounded, /\(\+\d+ more\)/);
});

// ── originFromChatId mapping ───────────────────────────────────────────────

test('originFromChatId maps prefixes and numeric ids', () => {
  assert.equal(originFromChatId('123456'), 'user-reply');
  assert.equal(originFromChatId('-1001234'), 'user-reply');
  assert.equal(originFromChatId('cron-heartbeat-pulse'), 'cron');
  assert.equal(originFromChatId('proposer:shakedown'), 'agency');
  assert.equal(originFromChatId('worker:shakedown:abc'), 'agency');
  assert.equal(originFromChatId('subagent:jerry:1f'), 'subagent');
  assert.equal(originFromChatId(''), 'unknown');
  assert.equal(originFromChatId(undefined), 'unknown');
  assert.equal(originFromChatId('something-else'), 'unknown');
});
