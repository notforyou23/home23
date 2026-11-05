import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LiveProblemStore,
  isOperatorSuppressed,
} = require('../../../engine/src/live-problems/store.js');

const FAIL = { ok: false, detail: 'still broken' };
const PASS = { ok: true, detail: 'healthy' };

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'home23-operator-authority-'));
  const store = new LiveProblemStore({ brainDir: dir });
  store.upsert({
    id: 'p1',
    claim: 'something is wrong',
    state: 'chronic',
    verifier: { type: 'noop', args: {} },
    remediation: [{ type: 'dispatch_to_agent', args: { budgetHours: 4 } }],
  });
  return { store, dir };
}

test('operatorClose resolves the problem even though the verifier still fails', () => {
  const { store, dir } = makeStore();
  try {
    store.operatorClose('p1', { actor: 'jtr', reason: 'verified by hand, not worth chasing' });

    const p = store.get('p1');
    assert.equal(p.state, 'resolved');
    assert.equal(p.operatorDecision.kind, 'closed');
    assert.equal(p.operatorDecision.actor, 'jtr');
    assert.equal(p.operatorDecision.reason, 'verified by hand, not worth chasing');
    assert.equal(p.escalated, false);
    assert.equal(p.stepIndex, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an operator-closed problem is NOT resurrected by a failing verifier, but keeps telling the truth', () => {
  const { store, dir } = makeStore();
  try {
    store.operatorClose('p1', { actor: 'jtr', reason: 'accepted' });
    store.recordVerification('p1', FAIL);

    const p = store.get('p1');
    // The operator's decision holds...
    assert.equal(p.state, 'resolved', 'operator close must survive a failing verifier');
    // ...but the record must not lie about the underlying condition.
    assert.equal(p.lastResult.ok, false);
    assert.equal(p.lastResult.detail, 'still broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a genuinely passing verifier clears the operator override', () => {
  const { store, dir } = makeStore();
  try {
    store.operatorClose('p1', { actor: 'jtr', reason: 'accepted' });
    store.recordVerification('p1', PASS);

    const p = store.get('p1');
    assert.equal(p.state, 'resolved');
    assert.equal(p.operatorDecision, undefined, 'no override needed once the condition is actually healthy');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('operatorReopen puts a closed problem back under verifier authority', () => {
  const { store, dir } = makeStore();
  try {
    store.operatorClose('p1', { actor: 'jtr', reason: 'accepted' });
    store.operatorReopen('p1', { actor: 'jtr', reason: 'came back' });

    const p = store.get('p1');
    assert.equal(p.state, 'open');
    assert.equal(p.operatorDecision, undefined);

    store.recordVerification('p1', FAIL);
    assert.equal(store.get('p1').state, 'open', 'reopened problems follow the verifier again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('operatorMute suppresses remediation without claiming the problem is fixed', () => {
  const { store, dir } = makeStore();
  try {
    const until = new Date(Date.now() + 3600_000).toISOString();
    store.operatorMute('p1', { actor: 'jtr', reason: 'stop burning agent hours', untilIso: until });

    const p = store.get('p1');
    assert.equal(p.mutedUntil, until);
    assert.equal(p.operatorDecision.kind, 'muted');
    assert.equal(p.state, 'chronic', 'mute must not fake a resolution');
    assert.equal(isOperatorSuppressed(p), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a mute expires on its own', () => {
  const { store, dir } = makeStore();
  try {
    const past = new Date(Date.now() - 1000).toISOString();
    store.operatorMute('p1', { actor: 'jtr', reason: 'brief pause', untilIso: past });
    assert.equal(isOperatorSuppressed(store.get('p1')), false, 'an elapsed mute stops suppressing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('operatorUnmute lifts the mute immediately', () => {
  const { store, dir } = makeStore();
  try {
    store.operatorMute('p1', {
      actor: 'jtr', reason: 'pause', untilIso: new Date(Date.now() + 3600_000).toISOString(),
    });
    store.operatorUnmute('p1', { actor: 'jtr' });

    const p = store.get('p1');
    assert.equal(p.mutedUntil, undefined);
    assert.equal(isOperatorSuppressed(p), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('muting clears a wedged dispatch so it stops idling out its budget', () => {
  const { store, dir } = makeStore();
  try {
    store.recordDispatch('p1', { turnId: 't_stuck' });
    assert.equal(store.get('p1').dispatchedAt !== undefined, true);

    store.operatorMute('p1', {
      actor: 'jtr', reason: 'pause', untilIso: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal(store.get('p1').dispatchedAt, undefined, 'a muted problem must not hold a live dispatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isOperatorSuppressed is false for an untouched problem', () => {
  const { store, dir } = makeStore();
  try {
    assert.equal(isOperatorSuppressed(store.get('p1')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every operator action leaves an attributed audit entry', () => {
  const { store, dir } = makeStore();
  try {
    store.operatorMute('p1', {
      actor: 'jtr', reason: 'pause', untilIso: new Date(Date.now() + 60_000).toISOString(),
    });
    store.operatorUnmute('p1', { actor: 'jtr' });
    store.operatorClose('p1', { actor: 'jtr', reason: 'done' });
    store.operatorReopen('p1', { actor: 'jtr', reason: 'back' });

    const kinds = (store.get('p1').remediationLog || [])
      .filter(e => e.type === 'operator_action')
      .map(e => e.detail.split(':')[0]);
    assert.deepEqual(kinds, ['mute', 'unmute', 'close', 'reopen']);
    for (const entry of store.get('p1').remediationLog || []) {
      if (entry.type === 'operator_action') assert.equal(entry.actor, 'jtr');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
