import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RelationshipLedger,
  type RelationshipEntryInput,
  type AuthenticatedCorrectionIngress,
} from '../../src/agent/relationship-ledger.js';

function tmpBrain(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-rel-ledger-'));
  return path.join(dir, 'jerry', 'brain');
}

// Deterministic clock (advances 1s per read) + counter-based id suffix.
function clock(startIso = '2026-08-05T12:00:00.000Z', stepMs = 1000): () => string {
  let t = Date.parse(startIso);
  return () => { const iso = new Date(t).toISOString(); t += stepMs; return iso; };
}
function counterSuffix(): () => string {
  let n = 0;
  return () => (n++).toString(16).padStart(4, '0');
}

function base(overrides: Partial<RelationshipEntryInput> = {}): RelationshipEntryInput {
  return {
    type: 'preference',
    title: 'title',
    statement: 'statement',
    provenance: { session_refs: ['chat-1'], generation_method: 'agent_note' },
    ...overrides,
  };
}

test('addEntry clamps confidence to the method cap and forces actor=agent', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });

  const entry = ledger.addEntry(base({ confidence: 0.99 }));
  assert.equal(entry.actor, 'agent');
  assert.equal(entry.confidence, 0.8); // agent_note cap
  assert.equal(entry.agent, 'jerry');  // derived from brainDir
  assert.match(entry.id, /^rel_\d{8}T\d{6}Z_[0-9a-f]{4}$/);
});

test('a caller cannot self-declare jtr_correction to earn the 0.95 cap', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });

  const laundered = ledger.addEntry(base({
    type: 'correction',
    confidence: 0.99,
    provenance: { session_refs: ['chat-1'], generation_method: 'jtr_correction' },
  }));
  assert.equal(laundered.actor, 'agent');
  assert.equal(laundered.provenance.generation_method, 'agent_note'); // downgraded
  assert.equal(laundered.confidence, 0.8); // agent_note cap, not 0.95
});

test('an authenticated correction ingress earns actor=jtr; without a passing validator it stays agent', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));

  const messageRef = 'dashboard:chat-1:message-9';
  const userText = 'Correction: the deploy port is 5005, not 5004.';
  const recorded = new Map([[messageRef, { chatId: 'chat-1', userText }]]);
  const ledger = new RelationshipLedger(brain, {
    now: clock(),
    idSuffix: counterSuffix(),
    validateCorrectionIngress: (ingress: AuthenticatedCorrectionIngress) => {
      const rec = recorded.get(ingress.messageRef);
      return rec?.chatId === ingress.chatId && rec.userText === ingress.userText;
    },
  });
  const ingress: AuthenticatedCorrectionIngress = { chatId: 'chat-1', messageRef, userText };

  // statement == the user's own claim → earns jtr authority + 0.95 cap
  const earned = ledger.addEntry(base({
    type: 'correction', title: 'deploy port', statement: userText, confidence: 0.99,
  }), ingress);
  assert.equal(earned.actor, 'jtr');
  assert.equal(earned.provenance.generation_method, 'jtr_correction');
  assert.equal(earned.confidence, 0.95);
  assert.ok(earned.provenance.source_refs.includes(messageRef));

  // no validator on this ledger → same ingress cannot earn jtr
  const noValidator = new RelationshipLedger(tmpBrain(), { now: clock(), idSuffix: counterSuffix() });
  const notEarned = noValidator.addEntry(base({
    type: 'correction', statement: userText,
  }), ingress);
  assert.equal(notEarned.actor, 'agent');
  assert.equal(notEarned.provenance.generation_method, 'agent_note');

  // statement != the user's claim → validator present but claim does not bind
  const mismatched = ledger.addEntry(base({
    type: 'correction', statement: 'Something else entirely.',
  }), ingress);
  assert.equal(mismatched.actor, 'agent');
});

test('supersede flips the old entry status and links both directions', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });

  const old = ledger.addEntry(base({ type: 'decision', title: 'v1', statement: 'do it the old way' }));
  const next = ledger.supersede(old.id, base({ type: 'decision', title: 'v2', statement: 'do it the new way' }));

  const refreshedOld = ledger.getEntry(old.id)!;
  assert.equal(refreshedOld.status, 'superseded');
  assert.deepEqual(refreshedOld.superseded_by, [next.id]);
  assert.deepEqual(next.supersedes, [old.id]);
  assert.equal(next.status, 'active');
});

test('resolve and remove are soft — the entry stays present with provenance intact', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });

  const thread = ledger.addEntry(base({ type: 'thread', title: 'open thread', statement: 'finish the migration' }));
  const resolved = ledger.resolve(thread.id)!;
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolved_at);
  assert.equal(ledger.getEntry(thread.id)?.status, 'resolved'); // still present

  const promise = ledger.addEntry(base({
    type: 'promise', title: 'owe a summary', statement: 'send the recap',
    provenance: { session_refs: ['chat-1'], source_refs: ['msg:42'], generation_method: 'agent_note' },
  }));
  const removed = ledger.remove(promise.id, 'no longer relevant')!;
  assert.equal(removed.status, 'removed');
  assert.deepEqual(ledger.getEntry(promise.id)?.provenance.source_refs, ['msg:42']); // provenance kept
  // soft delete: still in the file, just hidden from default listings
  assert.equal(ledger.listEntries().find(e => e.id === promise.id), undefined);
  assert.ok(ledger.listEntries({ includeRemoved: true }).some(e => e.id === promise.id));
});

test('persistence is atomic (no .tmp left behind) and round-trips from disk', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });

  const a = ledger.addEntry(base({ type: 'preference', title: 'p1', statement: 's1' }));
  const b = ledger.addEntry(base({ type: 'aversion', title: 'a1', statement: 's2' }));

  const leftover = fs.readdirSync(brain).filter(f => f.includes('.tmp-'));
  assert.deepEqual(leftover, []);

  const reloaded = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });
  const ids = reloaded.listEntries().map(e => e.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
  assert.equal(reloaded.getEntry(a.id)?.statement, 's1');
});

test('retrieveForContext ranks correction over shared_reference, packs to budget, excludes privacy + closed', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix(), agent: 'jerry' });

  // Equal keyword relevance ('deploy' in triggers); type weight must decide.
  const joke = ledger.addEntry(base({
    type: 'shared_reference', title: 'deploy joke', statement: 'the classic deploy-on-friday bit',
    triggers: ['deploy'],
  }));
  const corr = ledger.addEntry(base({
    type: 'correction', title: 'deploy rule', statement: 'never deploy without a load test',
    triggers: ['deploy'],
  }));
  // Non-matching + excluded-privacy + closed entries that must not appear.
  const secret = ledger.addEntry(base({
    type: 'preference', title: 'deploy secret', statement: 'sensitive deploy note',
    triggers: ['deploy'], privacy_class: 'sensitive',
  }));
  const gone = ledger.addEntry(base({ type: 'thread', title: 'deploy old', statement: 'deploy stale', triggers: ['deploy'] }));
  ledger.remove(gone.id);

  const full = ledger.retrieveForContext('deploy', { budgetChars: 100_000, excludePrivacy: ['sensitive'] });
  assert.equal(full.entries[0]?.type, 'correction'); // outranks shared_reference
  const ids = full.entries.map(e => e.id);
  assert.ok(ids.includes(corr.id) && ids.includes(joke.id));
  assert.ok(!ids.includes(secret.id), 'sensitive excluded');
  assert.ok(!ids.includes(gone.id), 'removed excluded');
  assert.ok(full.text.startsWith('[RELATIONSHIP — jerry]'));

  // Tight budget: only the header + first (correction) line fit.
  const lines = full.text.split('\n');
  const tight = (lines[0]!.length + 1) + (lines[1]!.length + 1);
  const packed = ledger.retrieveForContext('deploy', { budgetChars: tight, excludePrivacy: ['sensitive'] });
  assert.equal(packed.entries.length, 1);
  assert.equal(packed.entries[0]?.id, corr.id);
  assert.equal(packed.omittedCount, 1); // joke omitted (secret+gone were filtered, not omitted)

  // Read-mostly: retrieval did not touch reuse_count.
  assert.equal(ledger.getEntry(corr.id)?.reuse_count, 0);
  ledger.markSurfaced([corr.id]);
  assert.equal(ledger.getEntry(corr.id)?.reuse_count, 1);
  assert.ok(ledger.getEntry(corr.id)?.last_surfaced);
});

test('maxEntries eviction drops closed entries before active, and never drops protected active', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix(), maxEntries: 2 });

  const closed = ledger.addEntry(base({ type: 'preference', title: 'closed', statement: 'to resolve' }));
  ledger.resolve(closed.id); // now 'resolved'
  const keepA = ledger.addEntry(base({ type: 'correction', title: 'keepA', statement: 'active correction' }));
  const keepB = ledger.addEntry(base({ type: 'promise', title: 'keepB', statement: 'active promise' }));

  // count 3 > max 2 → the resolved entry is evicted, the two active protected ones stay.
  assert.equal(ledger.getEntry(closed.id), undefined);
  assert.ok(ledger.getEntry(keepA.id));
  assert.ok(ledger.getEntry(keepB.id));

  // Overflow of ONLY protected active entries: refuse to drop them.
  const keepC = ledger.addEntry(base({ type: 'decision', title: 'keepC', statement: 'active decision' }));
  assert.equal(ledger.listEntries().length, 3); // exceeds maxEntries, but all protected+active
  assert.ok(ledger.getEntry(keepC.id));
});

test('toPublicJSON exposes the full ledger including removed/superseded, newest-first', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });

  const first = ledger.addEntry(base({ title: 'first', statement: 's1' }));
  const second = ledger.addEntry(base({ title: 'second', statement: 's2' }));
  ledger.remove(first.id);

  const pub = ledger.toPublicJSON();
  assert.equal(pub.schema, 'home23.relationship-ledger.v1');
  assert.equal(pub.count, 2);
  assert.equal(pub.entries[0]?.id, second.id); // newest first
  assert.ok(pub.entries.some(e => e.id === first.id && e.status === 'removed'));
});
