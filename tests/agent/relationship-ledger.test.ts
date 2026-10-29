import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RelationshipLedger,
  entryMatchesQuery,
  relationshipLexicalScore,
  type RelationshipEntryInput,
  type AuthenticatedCorrectionIngress,
} from '../../src/agent/relationship-ledger.js';
import {
  LEGACY_EMBEDDING_PROFILE,
  LEGACY_EMBEDDING_RECIPE_ID,
} from '../../src/substrate/semantic-writer-stamp.js';
import lockfile from 'proper-lockfile';

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

test('direct owner relationship writes cannot bypass verification provenance and content gates', t => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain);
  const input = { type: 'decision' as const, statement: 'Buy tickets.', quote: 'I will buy tickets.',
    messageRef: 'message:1', sessionId: 'session:1', occurredAt: '2026-10-14T12:00:00.000Z' };
  for (const extra of [{ sessionId: 'home-verify-48' }, { chatId: 'recall-verification' },
    { metadata: { verification: true } }, { metadata: { source: 'non-owner' } },
    { quote: 'Test your recall of my tickets.' }, { conversationText: 'Run a retrieval retest using brain_search to find the tickets.' },
    { statement: "For this post-fix check, try the resident's retrieval and memory in practice.", quote: 'Yup. Give it a go…' }]) {
    assert.throws(() => ledger.upsertOwnerConversation({ ...input, ...extra }), /Verification conversations are not owner evidence/);
  }
  assert.equal(ledger.listEntries().length, 0);
  const genuine = ledger.upsertOwnerConversation({ ...input, conversationText: 'Use brain_search to find the tickets. Check the brain this morning.' });
  assert.equal(genuine.provenance.generation_method, 'owner_conversation');
});

test('generic relationship creates demote verification claims from owner evidence', t => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain);
  for (const input of [base({ statement: 'Test your recall of my tickets.',
    provenance: { session_refs: ['session:1'], generation_method: 'owner_conversation' } }),
    base({ provenance: { session_refs: ['home-verify-48'], generation_method: 'owner_conversation' } })]) {
    const created = ledger.addEntry(input);
    assert.equal(created.provenance.generation_method, 'agent_note');
    assert.equal(created.provenance.verification, true);
    assert.equal(created.provenance.conversation_kind, 'verification');
  }
});

test('Oct 14 owner recall does not match every older correction through generic conversation cues', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  let instant = '2026-08-23T19:20:10.000Z';
  const ledger = new RelationshipLedger(brain, { now: () => instant, idSuffix: counterSuffix() });
  const corrections = Array.from({ length: 12 }, (_, index) => {
    instant = index % 2 ? '2026-09-15T14:40:35.000Z' : '2026-08-23T19:20:10.000Z';
    return ledger.addEntry(base({
      type: 'correction', title: `Correction ${index}: preserve the established home`,
      statement: 'I told the owner in our morning conversation: talk to me before changing the brain.',
      triggers: ['conversation', 'morning', 'owner', 'brain', 'talk'],
    }));
  });
  instant = '2026-10-14T14:30:00.000Z';
  const owner = ledger.upsertOwnerConversation({
    type: 'decision', statement: 'Plan Friday lodging.', quote: 'Plan Friday lodging',
    occurredAt: '2026-10-14T10:36:24.000Z',
    messageRef: 'coordination.message:msg_oct14', sessionId: 'owner-session:oct14',
  });
  const query = 'October 14 2026 morning conversation dinner brain surgery re embedded restarted clarity retrieval fixes';
  for (const correction of corrections) {
    assert.equal(entryMatchesQuery(correction, query), false, 'generic cues must not count as meaningful overlap');
    assert.equal(entryMatchesQuery(correction, 'conversation morning owner brain me I talk'), false);
    assert.equal(relationshipLexicalScore(correction, query), 0);
    assert.equal(relationshipLexicalScore(correction, 'conversation morning owner brain me I talk'), 0);
  }
  assert.deepEqual(ledger.searchEntries(query).entries.map(entry => entry.id), [owner.id],
    'thin owner heads remain candidates for transcript resolution in the requested morning');
  assert.deepEqual(ledger.searchEntries('"2026-10-14" "owner" "brain"').entries.map(entry => entry.id), [owner.id]);
});

test('relationship lexical matching uses whole words while preserving meaningful correction phrases', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });
  const correction = ledger.addEntry(base({
    type: 'correction', title: 'Identity correction',
    statement: 'There is no he. I am Jerry. The seed, the lobe, this room—I am them.',
    triggers: ['remembered'],
  }));
  assert.equal(entryMatchesQuery(correction, 'There is no he. I am Jerry. The seed, the lobe, this room—I am them.'), true);
  assert.equal(entryMatchesQuery(correction, 'embedded'), false);
  assert.equal(entryMatchesQuery(correction, 'member'), false, 'a substring of remembered is not a term match');
  assert.equal(relationshipLexicalScore(correction, 'Jerry seed dinner surgery'), 0.5,
    'matched relationship entries carry their actual term coverage, not a constant 1.0');
});

test('owner time-window candidates precede genuinely matching corrections and retain privacy gates', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  let instant = '2026-09-15T14:40:35.000Z';
  const ledger = new RelationshipLedger(brain, { now: () => instant, idSuffix: counterSuffix() });
  const correction = ledger.addEntry(base({
    type: 'correction', title: 'Surgery retrieval', statement: 'Review surgery retrieval before claiming results.',
  }));
  ledger.addEntry(base({
    type: 'correction', title: 'Private surgery retrieval', statement: 'Private surgery retrieval.', privacy_class: 'sensitive',
  }));
  instant = '2026-10-14T14:30:00.000Z';
  const owner = ledger.upsertOwnerConversation({
    type: 'preference', statement: 'Plan Friday lodging.', quote: 'Plan Friday lodging',
    occurredAt: '2026-10-14T10:36:24.000Z',
    messageRef: 'coordination.message:msg_oct14', sessionId: 'owner-session:oct14',
  });
  const query = 'October 14 2026 morning conversation brain surgery clarity retrieval fixes';
  const found = ledger.searchEntries(query, { excludePrivacy: ['sensitive'] });
  assert.deepEqual(found.entries.map(entry => entry.id), [owner.id, correction.id]);
  assert.equal(relationshipLexicalScore(correction, query), 0.5);
  assert.equal(found.withheldMatching, 1);
  assert.equal(ledger.searchEntries('conversation owner brain me I talk', { excludePrivacy: ['sensitive'] }).withheldMatching, 0);
  ledger.remove(correction.id);
  assert.ok(!ledger.searchEntries(query).entries.some(entry => entry.id === correction.id));
});

test('owner conversation repeats retain evidence, refresh the date and never earn correction authority', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });
  const first = ledger.upsertOwnerConversation({
    type: 'preference', statement: 'Keep replies concise.', quote: 'Please keep your replies concise.',
    messageRef: 'owner:1', sessionId: 'session:1', occurredAt: '2026-10-01T12:00:00.000Z', privacy: 'sensitive',
  });
  const repeated = ledger.upsertOwnerConversation({
    type: 'preference', statement: ' KEEP replies  concise. ', quote: 'Keep replies concise, please.',
    messageRef: 'owner:2', sessionId: 'session:2', occurredAt: '2026-10-02T12:00:00.000Z',
  });
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.actor, 'agent');
  assert.equal(repeated.provenance.generation_method, 'owner_conversation');
  assert.equal(repeated.confidence, 0.8);
  assert.deepEqual(repeated.provenance.source_refs, ['owner:1', 'owner:2']);
  assert.deepEqual(repeated.provenance.session_refs, ['session:1', 'session:2']);
  assert.equal(repeated.evidence_note, 'Keep replies concise, please.');
  assert.equal(repeated.privacy_class, 'sensitive');
  assert.equal(repeated.createdAt, '2026-10-01T12:00:00.000Z');
  assert.equal(repeated.updatedAt, '2026-10-02T12:00:00.000Z');
  ledger.upsertOwnerConversation({
    type: 'preference', statement: 'Keep replies concise.', quote: 'Concise replies, please.',
    messageRef: 'owner:older', sessionId: 'session:0', occurredAt: '2026-09-30T12:00:00.000Z',
  });
  assert.equal(ledger.getEntry(first.id)?.updatedAt, repeated.updatedAt);
  assert.equal(ledger.listEntries().length, 1);
  assert.equal(ledger.retrieveForContext('replies', { budgetChars: 2000 }).entries.length, 1);
  assert.equal(ledger.retrieveForContext('replies', { budgetChars: 2000, excludePrivacy: ['sensitive'] }).text, '');
  const events = fs.readFileSync(path.join(brain, 'relationship-ledger.events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.every(event => !('semantic_vector' in event)));
});

test('later recaps and mentions cannot refresh or replace substantive owner relationship evidence', t => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain);
  const input = { type: 'decision' as const, statement: 'Plan Friday lodging for Trey and Billy.',
    quote: 'Melissa and I need Friday lodging in Worcester.', messageRef: 'message:original',
    sessionId: 'session:original', occurredAt: '2026-10-01T12:00:00.000Z' };
  const original = ledger.upsertOwnerConversation(input);
  // Include legacy records without explicit classification metadata.
  const file = path.join(brain, 'relationship-ledger.json');
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete document.entries[0].provenance.conversation_kind;
  fs.writeFileSync(file, JSON.stringify(document));
  const recap = ledger.upsertOwnerConversation({ ...input, quote: 'Recap: plan Friday lodging for Trey and Billy.',
    messageRef: 'message:recap', sessionId: 'session:recap', occurredAt: '2026-10-14T12:00:00.000Z',
    supersedes: [original.id] });
  const mention = ledger.upsertOwnerConversation({ ...input, quote: 'We previously discussed Friday lodging for Trey and Billy.',
    messageRef: 'message:mention', sessionId: 'session:mention', occurredAt: '2026-10-14T13:00:00.000Z',
    supersedes: [original.id] });
  assert.notEqual(recap.id, original.id);
  assert.notEqual(mention.id, original.id);
  assert.notEqual(mention.id, recap.id);
  const preserved = ledger.getEntry(original.id)!;
  assert.equal(preserved.updatedAt, input.occurredAt);
  assert.equal(preserved.status, 'active');
  assert.equal(recap.supersedes, undefined);
  assert.equal(mention.supersedes, undefined);
  assert.equal(preserved.evidence_note, input.quote);
  assert.deepEqual(preserved.provenance.source_refs, ['message:original']);
  assert.deepEqual(preserved.provenance.session_refs, ['session:original']);
  assert.equal(recap.provenance.conversation_kind, 'recap');
  assert.equal(mention.provenance.conversation_kind, 'mention');
  const repeated = ledger.upsertOwnerConversation({ ...input, quote: 'Recap: plan Friday lodging for Trey and Billy.',
    messageRef: 'message:recap-again', sessionId: 'session:recap-again', occurredAt: '2026-10-14T14:00:00.000Z' });
  assert.equal(repeated.id, recap.id, 'same-kind repeats still merge');
  assert.equal(ledger.listEntries().length, 3);
});

test('relationship context and search prefer original owner evidence over newer ticket recaps', t => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const nowMs = Date.parse('2026-10-14T16:00:00.000Z');
  const ledger = new RelationshipLedger(brain, { now: () => new Date(nowMs).toISOString() });
  const input = { type: 'decision' as const, statement: 'Buy Trey Billy tickets and plan Friday lodging.',
    quote: 'I bought Trey Billy tickets on Ticketmaster.', messageRef: 'message:original',
    sessionId: 'session:original', occurredAt: '2026-10-01T12:00:00.000Z' };
  const original = ledger.upsertOwnerConversation(input);
  const budgetChars = ledger.retrieveForContext('Trey Billy tickets', { budgetChars: 10_000, nowMs }).text.length;
  const recap = ledger.upsertOwnerConversation({ ...input, quote: 'Recap: Buy Trey Billy tickets and plan Friday lodging.',
    messageRef: 'message:recap', sessionId: 'session:recap', occurredAt: '2026-10-14T12:00:00.000Z' });
  assert.deepEqual(ledger.searchEntries('Trey Billy tickets', { nowMs }).entries.map(entry => entry.id), [original.id, recap.id]);
  const context = ledger.retrieveForContext('Trey Billy tickets', { budgetChars, nowMs });
  assert.deepEqual(context.entries.map(entry => entry.id), [original.id]);
});

test('legacy verification owner entries are excluded from relationship context and downgraded notes stay demoted', t => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: () => '2026-10-14T16:00:00.000Z' });
  const input = { type: 'decision' as const, title: 'Trey Billy tickets', statement: 'Trey Billy tickets on Ticketmaster.',
    evidence_note: 'Test your recall of Trey Billy tickets.',
    provenance: { generation_method: 'owner_conversation' as const, session_refs: ['home-verify-tickets'] } };
  const demoted = ledger.addEntry(input);
  const legacy = ledger.addEntry({ ...input, provenance: { ...input.provenance, session_refs: ['home-verify-legacy'] } });
  const original = ledger.upsertOwnerConversation({ type: 'decision', statement: 'Trey Billy tickets on Ticketmaster.',
    quote: 'I bought Trey Billy tickets on Ticketmaster.', messageRef: 'message:original',
    sessionId: 'session:original', occurredAt: '2026-10-01T12:00:00.000Z' });
  const file = path.join(brain, 'relationship-ledger.json');
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  document.entries.find((entry: any) => entry.id === legacy.id).provenance.generation_method = 'owner_conversation';
  fs.writeFileSync(file, JSON.stringify(document));
  const context = ledger.retrieveForContext('Trey Billy tickets', { budgetChars: 10_000 });
  assert.deepEqual(context.entries.map(entry => entry.id), [original.id, demoted.id]);
  assert.ok(!ledger.searchEntries('Trey Billy tickets').entries.some(entry => entry.id === legacy.id));
});

test('relationship recency ranking and newest ties require explicit query time intent', t => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const nowMs = Date.parse('2026-10-14T16:00:00.000Z');
  const ledger = new RelationshipLedger(brain, { now: () => new Date(nowMs).toISOString() });
  const original = ledger.upsertOwnerConversation({ type: 'decision', statement: 'Trey Billy tickets choice A.',
    quote: 'I chose Trey Billy tickets option A.', messageRef: 'message:a', sessionId: 'session:a',
    occurredAt: '2026-10-01T12:00:00.000Z' });
  const newer = ledger.upsertOwnerConversation({ type: 'decision', statement: 'Trey Billy tickets choice B.',
    quote: 'I chose Trey Billy tickets option B.', messageRef: 'message:b', sessionId: 'session:b',
    occurredAt: '2026-10-14T12:00:00.000Z' });
  for (const query of ['Trey Billy tickets', 'latest Trey Billy tickets']) {
    const expected = query.startsWith('latest') ? [newer.id, original.id] : [original.id, newer.id];
    assert.deepEqual(ledger.searchEntries(query, { nowMs }).entries.map(entry => entry.id), expected);
    assert.deepEqual(ledger.retrieveForContext(query, { budgetChars: 10_000, nowMs }).entries.map(entry => entry.id), expected);
  }
});

test('owner relationship supersession keeps history under capacity pressure and respects evidence time', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix(), maxEntries: 1 });
  const first = ledger.upsertOwnerConversation({
    type: 'preference', statement: 'Use short replies.', quote: 'Use short replies.', messageRef: 'owner:1',
    sessionId: 'session:1', occurredAt: '2026-10-01T12:00:00.000Z',
  });
  const newer = ledger.upsertOwnerConversation({
    type: 'preference', statement: 'Explain the details.', quote: 'Explain the details now.', messageRef: 'owner:2',
    sessionId: 'session:2', occurredAt: '2026-10-02T12:00:00.000Z', supersedes: [first.id],
  });
  assert.equal(ledger.getEntry(first.id)?.status, 'superseded');
  assert.deepEqual(ledger.getEntry(first.id)?.superseded_by, [newer.id]);
  assert.deepEqual(newer.supersedes, [first.id]);
  const replayed = ledger.upsertOwnerConversation({
    type: 'preference', statement: 'Use short replies.', quote: 'Use short replies.', messageRef: 'owner:1',
    sessionId: 'session:1', occurredAt: '2026-10-01T12:00:00.000Z',
  });
  assert.equal(replayed.id, first.id);
  assert.equal(replayed.status, 'superseded');
  ledger.upsertOwnerConversation({
    type: 'aversion', statement: 'Avoid long replies.', quote: 'Avoid long replies.', messageRef: 'owner:older',
    sessionId: 'session:0', occurredAt: '2026-09-30T12:00:00.000Z', supersedes: [newer.id],
  });
  assert.equal(ledger.getEntry(newer.id)?.status, 'active');
  assert.equal(ledger.toPublicJSON().count, 3);
});

test('owner recall preserves leading dates and ignores recap participant names without inventing repeat dates', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const now = Date.parse('2026-10-15T14:00:00-04:00');
  const ledger = new RelationshipLedger(brain, { now: () => new Date(now).toISOString(), idSuffix: counterSuffix() });
  const input = { type: 'decision' as const, statement: 'Keep the established home.', quote: 'Keep the old home.',
    messageRef: 'coordination.message:oct14', sessionId: 'owner-session:oct14', occurredAt: '2026-10-14T09:00:00-04:00' };
  const oct14 = ledger.upsertOwnerConversation(input);
  ledger.upsertOwnerConversation({ ...input, statement: 'An earlier unrelated topic.', messageRef: 'coordination.message:oct13',
    occurredAt: '2026-10-13T09:00:00-04:00' });
  assert.deepEqual(ledger.searchEntries('On Oct 14, what did Jason and I talk about?').entries.map(e => e.id), [oct14.id]);
  assert.deepEqual(ledger.searchEntries('What did Jason and I discuss yesterday morning?').entries.map(e => e.id), [oct14.id]);
  assert.deepEqual(ledger.searchEntries('On 2026-02-30, what did we discuss?').entries, []);
  ledger.upsertOwnerConversation({ ...input, messageRef: 'coordination.message:oct15',
    occurredAt: '2026-10-15T09:00:00-04:00' });
  assert.deepEqual(ledger.searchEntries('Keep the established home on Oct 14').entries, [],
    'the retained latest quote is Oct 15 evidence, not a reconstructed Oct 14 transcript');
});

test('long-lived relationship readers reload distiller writes and preserve them when marking surfaced', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const reader = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });
  const existing = reader.addEntry(base());
  const background = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });
  const learned = background.upsertOwnerConversation({
    type: 'decision', statement: 'Keep the old home.', quote: 'Keep the old home.', messageRef: 'owner:1',
    sessionId: 'session:1', occurredAt: '2026-10-01T12:00:00.000Z',
  });
  assert.ok(reader.retrieveForContext('home', { budgetChars: 2000 }).entries.some(entry => entry.id === learned.id));
  reader.markSurfaced([existing.id]);
  assert.equal(background.getEntry(existing.id)?.reuse_count, 1);
  assert.ok(background.getEntry(learned.id));
  const ledgerPath = path.join(brain, 'relationship-ledger.json');
  const release = lockfile.lockSync(ledgerPath);
  try { assert.throws(() => reader.markSurfaced([existing.id]), /lock/i); }
  finally { release(); }
  fs.writeFileSync(ledgerPath, '{unreadable');
  assert.throws(() => reader.upsertOwnerConversation({
    type: 'decision', statement: 'Keep the old home.', quote: 'Keep the old home.', messageRef: 'owner:1',
    sessionId: 'session:1', occurredAt: '2026-10-01T12:00:00.000Z',
  }));
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), '{unreadable');
});

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
  const unrelated = ledger.addEntry(base({ type: 'correction', title: 'Memory pressure incident',
    statement: 'The process restarted after an OOM.', triggers: ['memory', 'pressure'], applies_to: ['machine'] }));

  const full = ledger.retrieveForContext('deploy', { budgetChars: 100_000, excludePrivacy: ['sensitive'] });
  assert.equal(full.entries[0]?.type, 'correction'); // outranks shared_reference
  const ids = full.entries.map(e => e.id);
  assert.ok(ids.includes(corr.id) && ids.includes(joke.id));
  assert.ok(!ids.includes(secret.id), 'sensitive excluded');
  assert.ok(!ids.includes(gone.id), 'removed excluded');
  assert.ok(!ids.includes(unrelated.id), 'an unrelated high-weight correction cannot ride along');
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

test('relationship context admits the current subject and authenticated global instructions, not operational baggage', t => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  const globalText = 'Correction: going forward, keep your replies concise.';
  const ingress = { chatId: 'chat-1', messageRef: 'message:global', userText: globalText };
  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix(),
    validateCorrectionIngress: candidate => JSON.stringify(candidate) === JSON.stringify(ingress) });
  const global = ledger.addEntry(base({ type: 'correction', title: 'Concise replies', statement: globalText,
    applies_to: ['global'] }), ingress);
  const inferredGlobal = ledger.addEntry(base({ type: 'correction', title: 'Invented global machinery rule',
    statement: 'Always report the planning queue count.', applies_to: ['global'] }));
  const ops = ledger.addEntry(base({ type: 'correction', title: 'Waiting memory prediction',
    statement: 'The process is waiting for a new memory sample.', applies_to: ['machine'], triggers: ['memory', 'process'] }));
  const personal = ledger.addEntry(base({ type: 'thread', title: 'Tacoma and Tesla',
    statement: 'The owner likes the Tacoma and still loves Tesla FSD.', triggers: ['Tacoma', 'Tesla'] }));
  const haircut = ledger.retrieveForContext('Same haircut. How are you?', { budgetChars: 5000 });
  assert.deepEqual(haircut.entries.map(entry => entry.id), [global.id]);
  const followup = ledger.retrieveForContext('Exactly.', { budgetChars: 5000, recentSubject: 'Tacoma and Tesla FSD' });
  assert.ok(followup.entries.some(entry => entry.id === personal.id));
  assert.ok(followup.entries.some(entry => entry.id === global.id));
  assert.ok(!followup.entries.some(entry => entry.id === ops.id || entry.id === inferredGlobal.id));
  assert.ok(ledger.retrieveForContext('What about memory pressure?', { budgetChars: 5000 }).entries.some(entry => entry.id === ops.id));
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

test('new ledger event lines stamp provenance; unstamped history is not rewritten', (t) => {
  const brain = tmpBrain();
  t.after(() => fs.rmSync(path.dirname(path.dirname(brain)), { recursive: true, force: true }));
  fs.mkdirSync(brain, { recursive: true });
  const eventsPath = path.join(brain, 'relationship-ledger.events.jsonl');
  const oldLine = JSON.stringify({
    event_id: 'evt_old_unstamped',
    event_type: 'entry_added',
    entry_id: 'rel_old',
    agent: 'jerry',
    ts: '2026-08-05T11:00:00.000Z',
    payload: { type: 'preference', actor: 'agent', method: 'agent_note', head: 'old. unstamped history' },
    semantic_vector: Array.from({ length: 16 }, () => 0.1),
  });
  fs.writeFileSync(eventsPath, `${oldLine}\n`);

  const ledger = new RelationshipLedger(brain, { now: clock(), idSuffix: counterSuffix() });
  ledger.addEntry(base({ title: 'new preference', statement: 'stamp this new teaching line' }));

  const raw = fs.readFileSync(eventsPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines[0], oldLine, 'existing event bytes must stay unknown and unstamped');
  assert.ok(lines.length >= 2);
  const newest = JSON.parse(lines[lines.length - 1]!);
  assert.equal(newest.semantic_recipe_id, LEGACY_EMBEDDING_RECIPE_ID);
  assert.equal(newest.semantic_encoder, LEGACY_EMBEDDING_PROFILE);
  if (newest.semantic_vector) {
    assert.equal(newest.semantic_absence, undefined);
    assert.ok(Array.isArray(newest.semantic_vector));
  } else {
    assert.equal(newest.semantic_absence, 'unavailable');
  }
  assert.equal(Object.hasOwn(JSON.parse(lines[0]!), 'semantic_recipe_id'), false);
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
