import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { RelationshipLedger } from '../../src/agent/relationship-ledger.js';
import { relationshipNoteTool, relationshipRecallTool, relationshipUpdateTool } from '../../src/agent/tools/relationship.js';
import { learningLessonId } from '../../shared/seed-learning.cjs';
import { createLearningDecisionEvidenceReader } from '../../src/agent/learning-decision-evidence.js';

function fixture(t: { after(fn: () => void): void }, text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-learning-ingress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brain = path.join(root, 'jerry', 'brain');
  const ingress = { chatId: 'chat:owner', messageRef: 'message:feedback', userText: text };
  const ledger = new RelationshipLedger(brain, {
    validateCorrectionIngress: candidate => JSON.stringify(candidate) === JSON.stringify(ingress),
  });
  const seedStateDir = path.join(root, 'seed');
  writeLearningSnapshot(seedStateDir, [{ schema: 'home23.learning-decision.v1', decisionId: feedback().decisionId,
    scope: feedback().scope, tags: feedback().tags, sourceRefs: ['machine:observed-1'], criterion: 'owner-value' }]);
  const ctx = { chatId: ingress.chatId, relationshipLedger: ledger,
    seedStateDir,
    authenticatedUserMessage: { chatId: ingress.chatId, messageRef: ingress.messageRef, text } } as any;
  return { root, brain, ledger, ingress, ctx };
}

function feedback(direction: 'attenuate' | 'reinforce' = 'attenuate') {
  return { schema: 'home23.learning-feedback.v1', decisionId: 'decision:memory-watch:1',
    scope: 'owner.outreach:machine.memory', direction, basis: 'owner-feedback',
    tags: ['routine', 'mild'], excludes: ['critical', 'owner-requested'], evidenceRefs: [] };
}

function writeLearningSnapshot(stateDir: string, decisions: Array<Record<string, unknown>>, lessons: Array<Record<string, unknown>> = []) {
  fs.mkdirSync(path.join(stateDir, 'checkpoints'), { recursive: true });
  const development = { 'world.home': { experience: { version: 1, decisions, lessons, seenFeedbackIds: [] } } };
  const stateHash = createHash('sha256').update(JSON.stringify({ cells: [], dispositions: {}, development })).digest('hex');
  const line = JSON.stringify({ seq: 1, prevHash: '0'.repeat(64), category: 'genesis', payload: {}, stateHashAfter: stateHash });
  fs.writeFileSync(path.join(stateDir, 'seed-ledger.jsonl'), `${line}\n`);
  fs.writeFileSync(path.join(stateDir, 'checkpoints', 'ckpt_0001.json'), JSON.stringify({
    version: 2, cells: [], dispositions: {}, stateHash,
    ledgerSeq: 1, ledgerCursor: createHash('sha256').update(line).digest('hex'), development,
  }));
}

test('a misplaced natural conduct instruction refuses before writing or consuming authority, then permits an exact scoped retry', async t => {
  const instruction = 'Keep routine machine status out of personal conversations unless I ask.';
  const text = `Codex, relaying the owner's explicit correction under their authorization: “${instruction}” The owner wants that to carry into future choices. Preserve existing history.`;
  const { root, brain, ctx, ingress } = fixture(t, text);
  let validations = 0;
  const ledger = new RelationshipLedger(brain, { validateCorrectionIngress: candidate => {
    validations++;
    return validations === 1 && JSON.stringify(candidate) === JSON.stringify(ingress);
  } });
  const stateDir = path.join(root, 'seed');
  writeLearningSnapshot(stateDir, [{ schema: 'home23.learning-decision.v1', decisionId: 'actual-optional-agency-choice',
    scope: 'foreground.context', tags: ['operational', 'agency', 'automatic'],
    sourceRefs: ['surface:AGENCY'], criterion: 'owner-value' }]);
  const runtime = { ...ctx, relationshipLedger: ledger, seedStateDir: stateDir };
  for (const type of ['preference', 'aversion']) {
    const misplaced = await relationshipNoteTool.execute({ type, title: 'Routine operational context',
      statement: `The owner prefers personal conversations without routine machine status: “${instruction}”` }, runtime);
    assert.equal(misplaced.is_error, true, misplaced.content);
    assert.match(misplaced.content, /conduct_feedback_requires_learning/);
    assert.match(misplaced.content, /"recorded"\s*:\s*false/);
    assert.match(misplaced.content, /relationship_recall/);
    assert.match(misplaced.content, /omit|without.*scope/i);
  }
  assert.equal(validations, 0, 'repair guidance must leave the one-shot owner token available');
  assert.equal(ledger.listEntries().length, 0);
  assert.equal(fs.existsSync(path.join(brain, 'relationship-ledger.json')), false);
  assert.equal(fs.existsSync(path.join(brain, 'relationship-ledger.events.jsonl')), false);

  const input = { type: 'attenuation', title: 'Routine operational context', statement: text,
    learning: { ...feedback(), decisionId: 'actual-optional-agency-choice', scope: 'foreground.context',
      tags: ['operational', 'agency', 'automatic'], excludes: ['requested'] } };
  const quotedExcerpt = await relationshipNoteTool.execute({ ...input, statement: instruction }, runtime);
  assert.equal(quotedExcerpt.is_error, true, quotedExcerpt.content);
  assert.equal(validations, 0, 'a quoted excerpt cannot consume authority for the full delegated message');
  assert.equal(ledger.listEntries().length, 0);
  const corrected = await relationshipNoteTool.execute(input, runtime);
  const retry = await relationshipNoteTool.execute(input, runtime);
  assert.equal(corrected.is_error, undefined, corrected.content);
  assert.equal(retry.is_error, undefined, retry.content);
  assert.equal(validations, 1);
  assert.equal(ledger.listEntries().length, 1);
  const entry = ledger.listEntries()[0]!;
  assert.equal(entry.actor, 'jtr');
  assert.equal(entry.statement, text, 'the full delegated message preserves its actual attribution');
  assert.equal(entry.learning?.decisionId, 'actual-optional-agency-choice');
  assert.deepEqual(entry.learning?.excludes, ['requested']);
  const events = fs.readFileSync(path.join(brain, 'relationship-ledger.events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.owner_quote, text);
  assert.match(corrected.content, /Seed application=not yet confirmed/);
});

test('natural operational attenuation recognizes keep-out and avoid without accepting an excerpt as the owner claim', async t => {
  for (const [index, text] of [
    'Keep routine machine status out of personal conversations unless I ask.',
    'Please avoid routine operational status in your replies unless I request it.',
  ].entries()) {
    const { brain, ctx, ingress } = fixture(t, text);
    let validations = 0;
    const ledger = new RelationshipLedger(brain, { validateCorrectionIngress: candidate => {
      validations++;
      return JSON.stringify(candidate) === JSON.stringify(ingress);
    } });
    const runtime = { ...ctx, relationshipLedger: ledger };
    const input = { type: 'attenuation', title: 'Optional operational context', statement: text,
      learning: { ...feedback(), decisionId: `actual-choice:${index}` } };
    writeLearningSnapshot(runtime.seedStateDir, [{ schema: 'home23.learning-decision.v1', decisionId: input.learning.decisionId,
      scope: input.learning.scope, tags: input.learning.tags, sourceRefs: ['machine:observed-1'], criterion: 'owner-value' }]);
    const excerpt = await relationshipNoteTool.execute({ ...input, statement: text.split(' unless ')[0] }, runtime);
    assert.equal(excerpt.is_error, true, excerpt.content);
    assert.equal(validations, 0);
    const wrongChat = await relationshipNoteTool.execute(input, { ...runtime, chatId: 'chat:other' });
    assert.equal(wrongChat.is_error, true, wrongChat.content);
    assert.equal(validations, 0);
    const accepted = await relationshipNoteTool.execute(input, runtime);
    assert.equal(accepted.is_error, undefined, accepted.content);
    assert.equal(validations, 1);
    assert.equal(ledger.listEntries()[0]?.actor, 'jtr');
    assert.equal(ledger.listEntries()[0]?.statement, text);
  }
});

test('ordinary tastes, reports and hypotheticals remain context notes and explicitly report no conduct learning', async t => {
  for (const text of [
    'I prefer tea.',
    'My coworker said, "Keep routine machine status out of personal conversations." That is their opinion, not an instruction for you.',
    'If I asked you to keep routine machine status out of personal conversations, what would happen?',
    'Would you ever keep routine machine status out of personal conversations?',
  ]) {
    const { ledger, ctx } = fixture(t, text);
    const result = await relationshipNoteTool.execute({ type: 'preference', title: 'Context only', statement: text }, ctx);
    assert.equal(result.is_error, undefined, result.content);
    assert.equal(ledger.listEntries()[0]?.actor, 'agent');
    assert.equal(ledger.listEntries()[0]?.learning, undefined);
    assert.match(result.content, /conduct learning=not recorded/);
    assert.doesNotMatch(result.content, /Seed application=not yet confirmed/,
      'context-only success must not imply that an executable lesson is waiting for application');
  }
});

test('reported, questioned, or differently targeted language cannot earn operational attenuation', async t => {
  for (const text of [
    'What do you think of this suggested policy?\n“Keep routine machine status out of personal conversations unless I ask.”',
    'My coworker suggested this policy:\n“Keep routine machine status out of personal conversations unless I ask.”',
    "My coworker's preference:\nKeep routine machine status out of personal conversations unless I ask.",
    'My coworker sent me this example:\n"Keep routine machine status out of personal conversations unless I ask."\nWould that be sensible?',
    'Please avoid suppressing routine machine status in personal conversations.',
    'Please avoid losing machine status updates.',
    'Keep complaints about routine machine status out of personal conversations.',
  ]) {
    const { brain, ctx, ingress } = fixture(t, text);
    let validations = 0;
    const ledger = new RelationshipLedger(brain, { validateCorrectionIngress: candidate => {
      validations++;
      return JSON.stringify(candidate) === JSON.stringify(ingress);
    } });
    const runtime = { ...ctx, relationshipLedger: ledger };
    const note = await relationshipNoteTool.execute({ type: 'preference', title: 'A proposed policy', statement: text }, runtime);
    assert.equal(note.is_error, undefined, note.content);
    assert.equal(ledger.listEntries()[0]?.actor, 'agent');
    assert.equal(ledger.listEntries()[0]?.learning, undefined);
    const originalEvents = fs.readFileSync(path.join(brain, 'relationship-ledger.events.jsonl'), 'utf8');

    const inventedTeaching = await relationshipNoteTool.execute({ type: 'attenuation', title: 'Not an instruction',
      statement: text, learning: feedback() }, runtime);
    assert.equal(inventedTeaching.is_error, true, inventedTeaching.content);
    assert.equal(validations, 0, 'the full framing must be checked before consuming authenticated authority');
    assert.equal(ledger.listEntries().length, 1);
    assert.equal(fs.readFileSync(path.join(brain, 'relationship-ledger.events.jsonl'), 'utf8'), originalEvents);
  }
});

test('a conduct instruction in the current message does not block a distinct ordinary taste note', async t => {
  const instruction = 'Keep routine machine status out of personal conversations unless I ask.';
  const text = `${instruction} I also prefer tea.`;
  const { brain, ctx, ingress } = fixture(t, text);
  let validations = 0;
  const ledger = new RelationshipLedger(brain, { validateCorrectionIngress: candidate => {
    validations++;
    return JSON.stringify(candidate) === JSON.stringify(ingress);
  } });
  const runtime = { ...ctx, relationshipLedger: ledger };
  const misplaced = await relationshipNoteTool.execute({ type: 'preference', title: 'Optional operational context',
    statement: instruction }, runtime);
  assert.equal(misplaced.is_error, true, misplaced.content);
  assert.match(misplaced.content, /conduct_feedback_requires_learning/);
  assert.equal(ledger.listEntries().length, 0);

  const taste = await relationshipNoteTool.execute({ type: 'preference', title: 'Tea', statement: 'I prefer tea.' }, runtime);
  assert.equal(taste.is_error, undefined, taste.content);
  assert.match(taste.content, /conduct learning=not recorded/);
  assert.equal(validations, 0);
  assert.equal(ledger.listEntries().length, 1);
  assert.equal(ledger.listEntries()[0]?.statement, 'I prefer tea.');
  assert.equal(ledger.listEntries()[0]?.actor, 'agent');
  assert.equal(ledger.listEntries()[0]?.learning, undefined);
});

test('conduct-like prose without authenticated current ingress cannot acquire owner authority', async t => {
  const text = 'Keep routine machine status out of personal conversations unless I ask.';
  const { ledger, ctx } = fixture(t, text);
  const result = await relationshipNoteTool.execute({ type: 'preference', title: 'Unattributed note', statement: text },
    { ...ctx, authenticatedUserMessage: undefined });
  assert.equal(result.is_error, undefined, result.content);
  assert.equal(ledger.listEntries()[0]?.actor, 'agent');
  assert.equal(ledger.listEntries()[0]?.learning, undefined);
  assert.match(result.content, /conduct learning=not recorded/);
});

test('the public learning schema requires an actual decision identity', () => {
  const properties = relationshipNoteTool.input_schema.properties as Record<string, { required?: string[] }>;
  assert.ok(properties.learning.required?.includes('decisionId'));
});

test('authenticated attenuation preserves the exact owner words and the particular choice, once', async t => {
  const text = 'Those routine memory messages are noise. Send less of that unless something needs action.';
  const { brain, ledger, ctx } = fixture(t, text);
  const input = { type: 'attenuation', title: 'Routine memory commentary', statement: text,
    applies_to: 'machine.memory', learning: feedback() };
  const result = await relationshipNoteTool.execute(input, ctx);
  assert.equal(result.is_error, undefined, result.content);
  const entry = ledger.listEntries()[0] as any;
  assert.equal(entry.actor, 'jtr');
  assert.equal(entry.statement, text);
  assert.equal(entry.learning.decisionId, 'decision:memory-watch:1');
  assert.deepEqual(entry.learning.excludes, ['critical', 'owner-requested']);
  assert.ok(entry.learning.evidenceRefs.includes('message:feedback'));
  assert.match(result.content, /source projection=projected/);
  assert.match(result.content, /Seed application=not yet confirmed/);
  await relationshipNoteTool.execute(input, ctx);
  assert.equal(ledger.listEntries().length, 1, 'a retried tool call is one teaching');
  const events = fs.readFileSync(path.join(brain, 'relationship-ledger.events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.type, 'attenuation');
  assert.equal(events[0].payload.actor, 'jtr');
  assert.equal(events[0].payload.learning.scope, 'owner.outreach:machine.memory');
  assert.equal(events[0].payload.owner_quote, text);
});

test('positive conduct feedback earns authority only for its authenticated original claim', async t => {
  const text = 'That was useful. Keep noticing connections like that.';
  const { ledger, ctx } = fixture(t, text);
  const result = await relationshipNoteTool.execute({ type: 'correction', title: 'Useful connection',
    statement: text, learning: feedback('reinforce') }, ctx);
  assert.equal(result.is_error, undefined, result.content);
  assert.equal(ledger.listEntries()[0]?.actor, 'jtr');
  const invented = await relationshipNoteTool.execute({ type: 'correction', title: 'Invented praise',
    statement: 'Everything I do is helpful.', learning: feedback('reinforce') }, ctx);
  assert.equal(invented.is_error, true);
  assert.equal(ledger.listEntries().length, 1);
});

test('a fact, a forged quote, or a claimed verifier cannot mint conduct teaching', async t => {
  const text = 'I leased an Underground-gray Tacoma.';
  const { ledger, ctx } = fixture(t, text);
  for (const input of [
    { type: 'attenuation', statement: text, learning: feedback() },
    { type: 'preference', statement: text, learning: feedback('reinforce') },
    { type: 'correction', statement: text, learning: { ...feedback('reinforce'), basis: 'verified-outcome' } },
    { type: 'attenuation', statement: 'That was noise.', learning: feedback() },
  ]) {
    const result = await relationshipNoteTool.execute({ title: 'Cannot forge teaching', ...input }, ctx);
    assert.equal(result.is_error, true, result.content);
  }
  assert.equal(ledger.listEntries().length, 0);
  const fact = await relationshipNoteTool.execute({ type: 'preference', title: 'Truck', statement: text }, ctx);
  assert.equal(fact.is_error, undefined);
  assert.equal(ledger.listEntries()[0]?.actor, 'agent');
  assert.equal((ledger.listEntries()[0] as any).learning, undefined);
});

test('a durable teaching whose projection fails is retried after restart without duplicate delivery', async t => {
  const text = 'Stop sending routine memory commentary; it is noise.';
  const { brain, ledger, ingress } = fixture(t, text);
  const events = path.join(brain, 'relationship-ledger.events.jsonl');
  fs.mkdirSync(events);
  const entry = ledger.addEntry({ type: 'attenuation', title: 'Noise', statement: text,
    provenance: { session_refs: [ingress.chatId] }, learning: feedback() } as any, ingress) as any;
  assert.equal(entry.seed_projection.status, 'pending');
  assert.equal(ledger.listEntries().length, 1);
  fs.rmdirSync(events);
  const restored = new RelationshipLedger(brain);
  assert.deepEqual(restored.flushSeedTeaching(), { projected: 1, pending: 0 });
  assert.equal((restored.getEntry(entry.id) as any).seed_projection.status, 'projected');

  // Simulate the crash boundary after append/fsync but before acknowledgement.
  const disk = JSON.parse(fs.readFileSync(path.join(brain, 'relationship-ledger.json'), 'utf8'));
  disk.entries[0].seed_projection.status = 'pending';
  fs.writeFileSync(path.join(brain, 'relationship-ledger.json'), JSON.stringify(disk));
  const again = new RelationshipLedger(brain);
  assert.deepEqual(again.flushSeedTeaching(), { projected: 1, pending: 0 });
  assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').length, 1);
});

test('malformed metadata cannot consume owner authority and a retry does not mint it twice', async t => {
  const text = 'That was useful. Keep noticing connections like that.';
  const { brain, ctx } = fixture(t, text);
  let validations = 0;
  const ledger = new RelationshipLedger(brain, { validateCorrectionIngress: () => ++validations === 1 });
  const runtime = { ...ctx, relationshipLedger: ledger };
  const bad = await relationshipNoteTool.execute({ type: 'correction', title: 'Useful', statement: text,
    learning: { ...feedback('reinforce'), scope: '*' } }, runtime);
  assert.equal(bad.is_error, true);
  assert.equal(validations, 0);
  const input = { type: 'correction', title: 'Useful', statement: text, learning: feedback('reinforce') };
  const first = await relationshipNoteTool.execute(input, runtime);
  const retry = await relationshipNoteTool.execute(input, runtime);
  assert.equal(first.is_error, undefined, first.content);
  assert.equal(retry.is_error, undefined, retry.content);
  assert.equal(validations, 1);
  assert.equal(ledger.listEntries().length, 1);
});

function statusFeedbackFixture(t: { after(fn: () => void): void }) {
  const text = 'Keep routine machine status out of personal conversations unless I ask.';
  const base = fixture(t, text);
  let validations = 0;
  const ledger = new RelationshipLedger(base.brain, { validateCorrectionIngress: candidate => {
    validations++;
    return validations === 1 && JSON.stringify(candidate) === JSON.stringify(base.ingress);
  } });
  const witness = { schema: 'home23.learning-decision.v1', decisionId: 'context:actual-status-choice',
    scope: 'foreground.context', tags: ['operational', 'agency', 'agency_status', 'automatic'],
    sourceRefs: ['surface:AGENCY_STATUS'], criterion: 'owner-value', cellId: 'world.home' };
  writeLearningSnapshot(base.ctx.seedStateDir, [witness]);
  const runtime = { ...base.ctx, relationshipLedger: ledger };
  const input = { type: 'attenuation', title: 'Routine machine status', statement: text,
    learning: { ...feedback(), decisionId: witness.decisionId, scope: witness.scope, cellId: witness.cellId,
      tags: witness.tags, excludes: ['requested'], standing: true } };
  return { ...base, ledger, runtime, input, witness, validations: () => validations };
}

test('invented conduct tags fail before persistence or authority use and the same current correction can retry', async t => {
  const f = statusFeedbackFixture(t);
  const rejected = await relationshipNoteTool.execute({ ...f.input, learning: { ...f.input.learning,
    tags: ['routine-operational-status', 'personal-conversations'], excludes: ['direct requests for machine status'] } }, f.runtime);
  assert.equal(rejected.is_error, true, rejected.content);
  const diagnostic = JSON.parse(rejected.content);
  assert.equal(diagnostic.code, 'learning_metadata_context_mismatch');
  assert.equal(diagnostic.recorded, false);
  assert.equal(diagnostic.correctionAuthorityConsumed, false);
  assert.deepEqual(diagnostic.allowedTags, f.witness.tags);
  assert.deepEqual(diagnostic.unknownTags, ['routine-operational-status', 'personal-conversations']);
  assert.deepEqual(diagnostic.proseExcludes, ['direct requests for machine status']);
  assert.ok(diagnostic.knownExclusionTags.includes('requested'));
  assert.match(diagnostic.instruction, /Do not drop a narrowing condition/);
  assert.equal(f.validations(), 0);
  assert.equal(f.ledger.listEntries().length, 0);
  assert.equal(fs.existsSync(path.join(f.brain, 'relationship-ledger.json')), false);
  assert.equal(fs.existsSync(path.join(f.brain, 'relationship-ledger.events.jsonl')), false);

  const accepted = await relationshipNoteTool.execute(f.input, f.runtime);
  assert.equal(accepted.is_error, undefined, accepted.content);
  assert.equal(f.validations(), 1);
  const [entry] = f.ledger.listEntries();
  assert.equal(entry!.actor, 'jtr');
  assert.equal(entry!.statement, f.input.statement);
  assert.equal(entry!.learning!.decisionId, f.witness.decisionId);
  assert.deepEqual(entry!.learning!.tags, f.witness.tags);
  assert.deepEqual(entry!.learning!.excludes, ['requested']);
  assert.match(accepted.content, /Seed application=not yet confirmed/);
});

test('scope, cell and ambiguous identity mismatches cannot consume the current owner correction', async t => {
  const f = statusFeedbackFixture(t);
  for (const learning of [
    { ...f.input.learning, scope: 'execution:work' },
    { ...f.input.learning, cellId: 'world.other' },
  ]) {
    const rejected = await relationshipNoteTool.execute({ ...f.input, learning }, f.runtime);
    assert.equal(rejected.is_error, true, rejected.content);
    const diagnostic = JSON.parse(rejected.content);
    assert.equal(diagnostic.code, 'learning_metadata_context_mismatch');
    assert.equal(diagnostic.allowedScope, f.witness.scope);
    assert.equal(diagnostic.allowedCellId, f.witness.cellId);
  }
  writeLearningSnapshot(f.runtime.seedStateDir, [f.witness, { ...f.witness, scope: 'context.other' }]);
  const ambiguous = await relationshipNoteTool.execute(f.input, f.runtime);
  assert.equal(ambiguous.is_error, true, ambiguous.content);
  assert.equal(JSON.parse(ambiguous.content).code, 'learning_witness_ambiguous');
  assert.equal(f.validations(), 0);
  assert.equal(f.ledger.listEntries().length, 0);
  writeLearningSnapshot(f.runtime.seedStateDir, [f.witness]);
  assert.equal((await relationshipNoteTool.execute(f.input, f.runtime)).is_error, undefined);
  assert.equal(f.validations(), 1);
});

test('exclusions use runtime tokens without forbidding future canonical or known literal tags', async t => {
  const f = statusFeedbackFixture(t);
  for (const excludes of [['direct requests for machine status'], ['automatic']]) {
    const rejected = await relationshipNoteTool.execute({ ...f.input, learning: { ...f.input.learning, excludes } }, f.runtime);
    assert.equal(rejected.is_error, true, rejected.content);
    assert.equal(JSON.parse(rejected.content).code, 'learning_metadata_context_mismatch');
  }
  assert.equal(f.validations(), 0);
  writeLearningSnapshot(f.runtime.seedStateDir, [f.witness, { ...f.witness, decisionId: 'context:known-literal-tag',
    tags: ['operational', 'owner requested'] }]);
  const accepted = await relationshipNoteTool.execute({ ...f.input,
    learning: { ...f.input.learning, excludes: ['requested', 'urgent', 'owner requested'] } }, f.runtime);
  assert.equal(accepted.is_error, undefined, accepted.content);
  assert.deepEqual(f.ledger.listEntries()[0]!.learning!.excludes, ['requested', 'urgent', 'owner requested']);
  assert.equal(f.validations(), 1);
});

test('unavailable or missing Seed witnesses refuse tool teaching without guessing or spending authority', async t => {
  const f = statusFeedbackFixture(t);
  for (const runtime of [
    { ...f.runtime, seedStateDir: undefined },
    { ...f.runtime, seedStateDir: path.join(f.root, 'missing-seed') },
  ]) {
    const rejected = await relationshipNoteTool.execute(f.input, runtime);
    assert.equal(rejected.is_error, true, rejected.content);
    assert.equal(JSON.parse(rejected.content).code, 'learning_witness_unavailable');
  }
  const missing = await relationshipNoteTool.execute({ ...f.input,
    learning: { ...f.input.learning, decisionId: 'context:not-yet-retained' } }, f.runtime);
  assert.equal(missing.is_error, true, missing.content);
  assert.equal(JSON.parse(missing.content).code, 'learning_witness_not_retained');
  assert.equal(f.validations(), 0);
  assert.equal(f.ledger.listEntries().length, 0);
  assert.equal((await relationshipNoteTool.execute(f.input, f.runtime)).is_error, undefined);
  assert.equal(f.validations(), 1);
});

test('a retained lesson eligibility remains an exact preflight witness after the decision window moves', async t => {
  const f = statusFeedbackFixture(t);
  writeLearningSnapshot(f.runtime.seedStateDir, [], [{ lessonId: 'lesson:retained-status', scope: f.witness.scope,
    tags: f.witness.tags, excludes: ['requested'], sourceRefs: ['source:past-owner-feedback'],
    value: -0.25, basis: 'owner-feedback', authority: 'owner', criterion: 'owner-value',
    decisionId: f.witness.decisionId, eligibility: { ...f.witness, cellId: undefined },
    createdAt: '2026-10-29T00:00:00.000Z', corroborations: 0, active: true }]);
  const accepted = await relationshipNoteTool.execute(f.input, f.runtime);
  assert.equal(accepted.is_error, undefined, accepted.content);
  assert.equal(f.validations(), 1);
  assert.equal(f.ledger.listEntries()[0]!.learning!.cellId, 'world.home');
});

test('omitting cellId preserves identity-based Seed routing without inventing a target cell', async t => {
  const f = statusFeedbackFixture(t);
  const { cellId: _cellId, ...learning } = f.input.learning;
  const accepted = await relationshipNoteTool.execute({ ...f.input, learning }, f.runtime);
  assert.equal(accepted.is_error, undefined, accepted.content);
  assert.equal(f.validations(), 1);
  assert.equal(f.ledger.listEntries()[0]!.learning!.cellId, undefined);
  assert.equal(f.ledger.listEntries()[0]!.learning!.decisionId, f.witness.decisionId);
});

test('valid preflight preserves durable projection retries without consuming a second correction token', async t => {
  const f = statusFeedbackFixture(t);
  const events = path.join(f.brain, 'relationship-ledger.events.jsonl');
  fs.mkdirSync(events, { recursive: true });
  const pending = await relationshipNoteTool.execute(f.input, f.runtime);
  assert.equal(pending.is_error, undefined, pending.content);
  assert.match(pending.content, /source projection=pending/);
  assert.match(pending.content, /Seed application=not yet confirmed/);
  assert.equal(f.validations(), 1);
  fs.rmdirSync(events);
  const retried = await relationshipNoteTool.execute(f.input, f.runtime);
  assert.equal(retried.is_error, undefined, retried.content);
  assert.match(retried.content, /source projection=projected/);
  assert.equal(f.validations(), 1);
  assert.equal(f.ledger.listEntries().length, 1);
  assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').length, 1);
});

test('an exact stored supersession retries after target deactivation or witness loss without granting a changed claim authority', async t => {
  const f = statusFeedbackFixture(t);
  const lesson = { lessonId: 'lesson:actual-prior-status', scope: f.witness.scope,
    tags: f.witness.tags, excludes: ['requested'], sourceRefs: ['owner:previous-result'],
    value: -0.25, basis: 'owner-feedback', authority: 'owner', criterion: 'owner-value',
    decisionId: 'context:previous-status-choice', createdAt: '2026-10-29T00:00:00.000Z', corroborations: 0, active: true };
  writeLearningSnapshot(f.runtime.seedStateDir, [f.witness], [lesson]);
  const input = { ...f.input, learning: { ...f.input.learning, supersedes: [lesson.lessonId] } };
  const events = path.join(f.brain, 'relationship-ledger.events.jsonl');
  fs.mkdirSync(events, { recursive: true });
  const pending = await relationshipNoteTool.execute(input, f.runtime);
  assert.equal(pending.is_error, undefined, pending.content);
  assert.match(pending.content, /source projection=pending/);
  assert.equal(f.validations(), 1);
  const original = f.ledger.listEntries()[0]!;

  // An applied supersession makes its old target inactive. That does not
  // invalidate the authenticated source's own idempotent delivery retry.
  writeLearningSnapshot(f.runtime.seedStateDir, [f.witness], [{ ...lesson, active: false }]);
  fs.rmdirSync(events);
  const delivered = await relationshipNoteTool.execute(input, f.runtime);
  assert.equal(delivered.is_error, undefined, delivered.content);
  assert.match(delivered.content, /source projection=projected/);
  assert.equal(f.ledger.listEntries()[0]!.id, original.id);

  writeLearningSnapshot(f.runtime.seedStateDir, []);
  assert.equal((await relationshipNoteTool.execute(input, f.runtime)).is_error, undefined,
    'the source can retry after the retained witness window expires');
  fs.rmSync(f.runtime.seedStateDir, { recursive: true });
  assert.equal((await relationshipNoteTool.execute(input, f.runtime)).is_error, undefined,
    'a stored authenticated source can retry projection while Seed readback is unavailable');
  const eventBytes = fs.readFileSync(events);
  const sourceBytes = fs.readFileSync(path.join(f.brain, 'relationship-ledger.json'));
  for (const [changed, runtime] of [
    [{ ...input, statement: `${input.statement} A different claim.` }, f.runtime],
    [{ ...input, learning: { ...input.learning, excludes: ['requested', 'urgent'] } }, f.runtime],
    [{ ...input, type: 'correction' }, f.runtime],
    [input, { ...f.runtime, authenticatedUserMessage: { ...f.runtime.authenticatedUserMessage, messageRef: 'message:different' } }],
  ] as const) {
    const rejected = await relationshipNoteTool.execute(changed, runtime);
    assert.equal(rejected.is_error, true, rejected.content);
    assert.equal(JSON.parse(rejected.content).code, 'learning_witness_unavailable');
  }
  assert.equal(f.validations(), 1);
  assert.equal(f.ledger.listEntries().length, 1);
  assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(fs.readFileSync(events), eventBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.brain, 'relationship-ledger.json')), sourceBytes);
});

test('new mixed replacement and corroboration refuse note and update before authority, persistence or lifecycle changes', async t => {
  const f = statusFeedbackFixture(t);
  const existing = f.ledger.addEntry({ type: 'preference', title: 'Existing context', statement: 'An existing ordinary preference.' });
  const source = path.join(f.brain, 'relationship-ledger.json');
  const events = path.join(f.brain, 'relationship-ledger.events.jsonl');
  const sourceBytes = fs.readFileSync(source);
  const eventBytes = fs.readFileSync(events);
  const learning = { ...f.input.learning, supersedes: ['lesson:prior'], corroborates: ['lesson:supported'] };
  const note = await relationshipNoteTool.execute({ ...f.input, learning }, f.runtime);
  const update = await relationshipUpdateTool.execute({ id: existing.id, action: 'supersede', type: 'attenuation',
    statement: f.input.statement, learning }, f.runtime);
  for (const rejected of [note, update]) {
    assert.equal(rejected.is_error, true, rejected.content);
    const diagnostic = JSON.parse(rejected.content);
    assert.equal(diagnostic.code, 'learning_reference_operations_conflict');
    assert.equal(diagnostic.recorded, false);
    assert.equal(diagnostic.correctionAuthorityConsumed, false);
    assert.match(diagnostic.detail, /current owner message authorizes/);
  }
  assert.equal(f.validations(), 0);
  assert.equal(f.ledger.listEntries().length, 1);
  assert.equal(f.ledger.getEntry(existing.id)!.status, 'active');
  assert.deepEqual(fs.readFileSync(source), sourceBytes);
  assert.deepEqual(fs.readFileSync(events), eventBytes);
});

test('update cannot combine an automatic teaching replacement with corroboration', async t => {
  const f = statusFeedbackFixture(t);
  const recorded = await relationshipNoteTool.execute(f.input, f.runtime);
  assert.equal(recorded.is_error, undefined, recorded.content);
  const original = f.ledger.listEntries()[0]!;
  let validations = 0;
  const writer = new RelationshipLedger(f.brain, { validateCorrectionIngress: () => { validations++; return true; } });
  const source = path.join(f.brain, 'relationship-ledger.json');
  const sourceBytes = fs.readFileSync(source);
  const rejected = await relationshipUpdateTool.execute({ id: original.id, action: 'supersede',
    statement: f.input.statement, learning: { ...f.input.learning, corroborates: ['lesson:supported'] } }, {
    ...f.runtime, relationshipLedger: writer,
    authenticatedUserMessage: { ...f.runtime.authenticatedUserMessage, messageRef: 'message:revision' },
  });
  assert.equal(rejected.is_error, true, rejected.content);
  assert.equal(JSON.parse(rejected.content).code, 'learning_reference_operations_conflict');
  assert.equal(validations, 0);
  assert.equal(writer.listEntries().length, 1);
  assert.equal(writer.getEntry(original.id)!.status, 'active');
  assert.deepEqual(fs.readFileSync(source), sourceBytes);
});

test('an existing authenticated mixed-reference source retains only its exact native projection retry', async t => {
  const f = statusFeedbackFixture(t);
  const input = { ...f.input, learning: { ...f.input.learning, supersedes: ['lesson:prior'], corroborates: ['lesson:supported'] } };
  // Model a historical native source already accepted before tool preflight.
  // Its retry preserves history; it cannot turn into a new combined operation.
  const original = f.ledger.addEntry({ type: 'attenuation', title: input.title, statement: input.statement,
    provenance: { session_refs: [f.ingress.chatId] }, learning: input.learning as any }, f.ingress);
  assert.equal(original.actor, 'jtr');
  fs.rmSync(f.runtime.seedStateDir, { recursive: true });
  const events = path.join(f.brain, 'relationship-ledger.events.jsonl');
  const eventBytes = fs.readFileSync(events);
  const retried = await relationshipNoteTool.execute(input, f.runtime);
  assert.equal(retried.is_error, undefined, retried.content);
  assert.equal(f.validations(), 1);
  assert.equal(f.ledger.listEntries().length, 1);
  assert.equal(f.ledger.listEntries()[0]!.id, original.id);
  assert.deepEqual(fs.readFileSync(events), eventBytes);
  const changed = await relationshipNoteTool.execute({ ...input,
    learning: { ...input.learning, corroborates: ['lesson:different'] } }, f.runtime);
  assert.equal(changed.is_error, true, changed.content);
  assert.equal(JSON.parse(changed.content).code, 'learning_reference_operations_conflict');
  assert.equal(f.validations(), 1);
  assert.deepEqual(fs.readFileSync(events), eventBytes);
});

test('supersession uses the same preflight before changing the existing source entry', async t => {
  const f = statusFeedbackFixture(t);
  const existing = f.ledger.addEntry({ type: 'preference', title: 'Old context', statement: 'A saved ordinary preference.' });
  const file = path.join(f.brain, 'relationship-ledger.json');
  const original = fs.readFileSync(file);
  const rejected = await relationshipUpdateTool.execute({ id: existing.id, action: 'supersede', type: 'attenuation',
    statement: f.input.statement, learning: { ...f.input.learning, tags: ['personal-conversations'] } }, f.runtime);
  assert.equal(rejected.is_error, true, rejected.content);
  assert.equal(JSON.parse(rejected.content).code, 'learning_metadata_context_mismatch');
  assert.equal(f.validations(), 0);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(f.ledger.getEntry(existing.id)!.status, 'active');
  const accepted = await relationshipUpdateTool.execute({ id: existing.id, action: 'supersede', type: 'attenuation',
    statement: f.input.statement, learning: f.input.learning }, f.runtime);
  assert.equal(accepted.is_error, undefined, accepted.content);
  assert.equal(f.validations(), 1);
  assert.equal(f.ledger.getEntry(existing.id)!.status, 'superseded');
});

test('a projected source entry cannot be mistaken for an active Seed lesson to supersede', async t => {
  const f = statusFeedbackFixture(t);
  const original = await relationshipNoteTool.execute(f.input, f.runtime);
  assert.equal(original.is_error, undefined, original.content);
  const entry = f.ledger.listEntries()[0]!;
  const predicted = learningLessonId(entry.seed_projection!.event.event_id, entry.learning!.scope);
  let revisionValidations = 0;
  const ledger = new RelationshipLedger(f.brain, { validateCorrectionIngress: () => { revisionValidations++; return true; } });
  const result = await relationshipUpdateTool.execute({ id: entry.id, action: 'supersede',
    statement: f.input.statement, learning: f.input.learning }, { ...f.runtime, relationshipLedger: ledger });
  assert.equal(result.is_error, true, result.content);
  const diagnostic = JSON.parse(result.content);
  assert.equal(diagnostic.code, 'learning_supersession_target_unavailable');
  assert.deepEqual(diagnostic.missingLessonIds, [predicted]);
  assert.equal(revisionValidations, 0);
  assert.equal(ledger.listEntries().length, 1);
  assert.equal(ledger.getEntry(entry.id)!.status, 'active');
});

test('corroboration validates actual lesson attribution before spending correction authority', async t => {
  const f = statusFeedbackFixture(t);
  const lesson = { lessonId: 'lesson:actual-prior-status', scope: f.witness.scope,
    tags: f.witness.tags, excludes: ['requested'], sourceRefs: ['owner:previous-result'],
    value: -0.25, basis: 'owner-feedback', authority: 'owner', criterion: 'owner-value',
    decisionId: 'context:previous-status-choice', createdAt: '2026-10-29T00:00:00.000Z', corroborations: 0, active: true };
  for (const bad of [
    null,
    { ...lesson, active: false },
    { ...lesson, scope: 'execution:work' },
    { ...lesson, criterion: 'execution' },
    { ...lesson, value: 0.25 },
    { ...lesson, decisionId: f.witness.decisionId },
    { ...lesson, tags: ['operational', 'unrelated'] },
  ]) {
    writeLearningSnapshot(f.runtime.seedStateDir, [f.witness], bad ? [bad] : []);
    const rejected = await relationshipNoteTool.execute({ ...f.input,
      learning: { ...f.input.learning, corroborates: [lesson.lessonId] } }, f.runtime);
    assert.equal(rejected.is_error, true, rejected.content);
    assert.equal(JSON.parse(rejected.content).code, 'learning_corroboration_target_unavailable');
    assert.equal(f.validations(), 0);
    assert.equal(f.ledger.listEntries().length, 0);
  }
  writeLearningSnapshot(f.runtime.seedStateDir, [f.witness], [lesson]);
  const accepted = await relationshipNoteTool.execute({ ...f.input,
    learning: { ...f.input.learning, corroborates: [lesson.lessonId] } }, f.runtime);
  assert.equal(accepted.is_error, undefined, accepted.content);
  assert.equal(f.validations(), 1);
  assert.deepEqual(f.ledger.listEntries()[0]!.learning!.corroborates, [lesson.lessonId]);
});

test('same-scope lessons in another cell cannot be superseded or corroborated at this witness', async t => {
  const f = statusFeedbackFixture(t);
  const otherLesson = { lessonId: 'lesson:another-cell', scope: f.witness.scope,
    tags: f.witness.tags, excludes: ['requested'], sourceRefs: ['owner:another-cell-result'],
    value: -0.25, basis: 'owner-feedback', authority: 'owner', criterion: 'owner-value',
    decisionId: 'context:another-cell-choice', createdAt: '2026-10-29T00:00:00.000Z', corroborations: 0, active: true };
  writeLearningSnapshot(f.runtime.seedStateDir, [f.witness]);
  const checkpointPath = path.join(f.runtime.seedStateDir, 'checkpoints', 'ckpt_0001.json');
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  checkpoint.development['world.other'] = { experience: { version: 1, decisions: [], lessons: [otherLesson], seenFeedbackIds: [] } };
  checkpoint.stateHash = createHash('sha256').update(JSON.stringify({ cells: [], dispositions: {}, development: checkpoint.development })).digest('hex');
  const line = JSON.stringify({ seq: 1, prevHash: '0'.repeat(64), category: 'genesis', payload: {}, stateHashAfter: checkpoint.stateHash });
  checkpoint.ledgerCursor = createHash('sha256').update(line).digest('hex');
  fs.writeFileSync(path.join(f.runtime.seedStateDir, 'seed-ledger.jsonl'), `${line}\n`);
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));
  for (const field of ['supersedes', 'corroborates']) {
    const rejected = await relationshipNoteTool.execute({ ...f.input,
      learning: { ...f.input.learning, [field]: [otherLesson.lessonId] } }, f.runtime);
    assert.equal(rejected.is_error, true, rejected.content);
    assert.equal(JSON.parse(rejected.content).code, field === 'supersedes'
      ? 'learning_supersession_target_unavailable' : 'learning_corroboration_target_unavailable');
  }
  assert.equal(f.validations(), 0);
  assert.equal(f.ledger.listEntries().length, 0);
});

test('unlinked executable feedback is refused even when labelled standing', async t => {
  const text = 'Those memory messages are noise.';
  const { ledger, ctx } = fixture(t, text);
  const unlinked = { ...feedback(), decisionId: undefined };
  const result = await relationshipNoteTool.execute({ type: 'attenuation', title: 'Noise', statement: text,
    learning: unlinked }, ctx);
  assert.equal(result.is_error, true);
  assert.equal(ledger.listEntries().length, 0);
  const inventedStanding = await relationshipNoteTool.execute({ type: 'attenuation', title: 'Noise', statement: text,
    learning: { ...unlinked, standing: true } }, ctx);
  assert.equal(inventedStanding.is_error, true, 'a reaction is not an instruction to generalize forever');
});

test('an explicit standing instruction preserves its linked scope and exclusions', async t => {
  const text = 'From now on, send less routine memory commentary unless something needs action.';
  const { ledger, ctx } = fixture(t, text);
  const result = await relationshipNoteTool.execute({ type: 'attenuation', title: 'Routine commentary', statement: text,
    learning: { ...feedback(), standing: true } }, ctx);
  assert.equal(result.is_error, undefined, result.content);
  const entry = ledger.listEntries()[0]!;
  assert.equal(entry.actor, 'jtr');
  assert.equal(entry.learning?.standing, true);
  assert.equal(entry.learning?.decisionId, feedback().decisionId);
  assert.deepEqual(entry.learning?.excludes, ['critical', 'owner-requested']);
});

test('a narrow owner quote cannot mint an unlinked executable rule in another domain', async t => {
  const text = "Don't send more mild memory notices.";
  const { ledger, ctx } = fixture(t, text);
  const result = await relationshipNoteTool.execute({ type: 'attenuation', title: 'Invented broad scope', statement: text,
    learning: { ...feedback(), decisionId: undefined, standing: true,
      scope: 'foreground.context', tags: ['operational'] } }, ctx);
  assert.equal(result.is_error, true);
  assert.equal(ledger.listEntries().length, 0);
});

test('learning recall exposes bounded actual decision identities from only the runtime-bound Seed', async t => {
  const { root, ctx } = fixture(t, 'That was useful.');
  const stateDir = path.join(root, 'seed');
  const decisions = [
    { schema: 'home23.learning-decision.v1', decisionId: 'actual-memory-choice', scope: 'owner.outreach:machine.memory',
      tags: ['routine', 'mild'], sourceRefs: ['machine:observed-1'], criterion: 'owner-value' },
    { schema: 'home23.learning-decision.v1', decisionId: 'actual-other-choice', scope: 'context.operational',
      tags: ['operational'], sourceRefs: ['message:other'], criterion: 'owner-value' },
  ];
  writeLearningSnapshot(stateDir, decisions);
  const result = await relationshipRecallTool.execute({ learning: true, scope: 'owner.outreach:machine.memory', limit: 1 },
    { ...ctx, seedStateDir: stateDir });
  assert.equal(result.is_error, undefined, result.content);
  const inspected = JSON.parse(result.content);
  assert.equal(inspected.seedSequence, 1);
  assert.deepEqual(inspected.decisions.map((decision: any) => decision.decisionId), ['actual-memory-choice']);
  assert.doesNotMatch(result.content, /actual-other-choice/);
  assert.ok(inspected.decisions[0].sourceRefs.includes('machine:observed-1'));
  assert.deepEqual(inspected.decisions[0].evidence,
    { status: 'unavailable', reason: 'runtime_evidence_reader_unavailable' });
});

test('learning recall enriches only retained witnesses through the runtime-owned reader, without granting new authority', async t => {
  const { root, brain, ctx, ledger } = fixture(t, 'Keep routine machine status out of personal conversations unless I ask.');
  const stateDir = path.join(root, 'seed');
  const decision = { schema: 'home23.learning-decision.v1', decisionId: 'context:actual-status-choice',
    scope: 'foreground.context', tags: ['operational', 'agency', 'agency_status', 'automatic'],
    sourceRefs: ['surface:AGENCY_STATUS'], criterion: 'owner-value', observedAt: '2026-10-29T12:00:00.000Z' };
  writeLearningSnapshot(stateDir, [decision]);
  const event = { event_id: decision.decisionId, event_type: 'LearningDecisionObserved', actor: 'assembly',
    timestamp: decision.observedAt, session_id: 'coordination:channel:actual-work', payload: { ...decision,
      choice: 'admit', relevant: true, explicit: false,
      behavior: { kind: 'context-selection', surface: 'AGENCY_STATUS', component: 'routine-operational-status',
        description: 'Include routine mode and planning queue status in the model context.' } } };
  const source = path.join(brain, 'event-ledger.jsonl');
  fs.writeFileSync(source, `${JSON.stringify(event)}\n`);
  const original = fs.readFileSync(source);
  const read = createLearningDecisionEvidenceReader(source);
  let receivedIds: string[] = [];
  const result = await relationshipRecallTool.execute({ learning: true, scope: 'foreground.context',
    decisionId: 'forged-input-choice', ledgerPath: path.join(root, 'not-the-resident-ledger') }, {
    ...ctx, seedStateDir: stateDir, readLearningDecisionEvidence: async (witnesses: any[]) => {
      receivedIds = witnesses.map(witness => witness.decisionId);
      return read(witnesses);
    },
  });
  assert.equal(result.is_error, undefined, result.content);
  const inspected = JSON.parse(result.content);
  assert.deepEqual(receivedIds, [decision.decisionId]);
  assert.equal(inspected.decisions[0].evidence.status, 'verified');
  assert.equal(inspected.decisions[0].evidence.behavior.component, 'routine-operational-status');
  assert.equal(inspected.decisions[0].evidence.delivery.status, 'unavailable');
  assert.match(inspected.note, /outward reply was acceptable/);
  assert.match(inspected.note, /not equate every AGENCY/);
  assert.equal(ledger.listEntries().length, 0, 'explaining evidence cannot record teaching');
  assert.deepEqual(fs.readFileSync(source), original);
});

test('failed runtime evidence readback preserves actual witness identities without inventing descriptions', async t => {
  const { root, ctx } = fixture(t, 'That was useful.');
  const stateDir = path.join(root, 'seed');
  writeLearningSnapshot(stateDir, [{ schema: 'home23.learning-decision.v1', decisionId: 'context:retained',
    scope: 'foreground.context', tags: ['operational', 'agency', 'automatic'],
    sourceRefs: ['surface:AGENCY'], criterion: 'owner-value' }]);
  const result = await relationshipRecallTool.execute({ learning: true }, { ...ctx, seedStateDir: stateDir,
    readLearningDecisionEvidence: async () => { throw new Error('bounded ledger unavailable'); } });
  assert.equal(result.is_error, undefined, result.content);
  const inspected = JSON.parse(result.content);
  assert.equal(inspected.decisions[0].decisionId, 'context:retained');
  assert.deepEqual(inspected.decisions[0].evidence,
    { status: 'unavailable', reason: 'runtime_evidence_reader_unavailable' });
});

test('learning recall distinguishes an unknown human topic from actual available scopes', async t => {
  const { root, ctx } = fixture(t, 'Keep routine machine status out of personal conversations unless I ask.');
  const stateDir = path.join(root, 'seed');
  writeLearningSnapshot(stateDir, [
    { schema: 'home23.learning-decision.v1', decisionId: 'actual-foreground-choice', scope: 'foreground.context',
      tags: ['operational', 'agency', 'automatic'], sourceRefs: ['surface:AGENCY'], criterion: 'owner-value' },
    { schema: 'home23.learning-decision.v1', decisionId: 'actual-work-choice', scope: 'execution:work',
      tags: ['execution', 'work'], sourceRefs: ['work:actual'], criterion: 'execution' },
  ]);
  const runtime = { ...ctx, seedStateDir: stateDir };
  const unknown = await relationshipRecallTool.execute({ learning: true, scope: 'personal conversations' }, runtime);
  assert.equal(unknown.is_error, true, unknown.content);
  const diagnostic = JSON.parse(unknown.content);
  assert.equal(diagnostic.requestedScope, 'personal conversations');
  assert.equal(diagnostic.scopeStatus, 'unknown');
  assert.deepEqual([...diagnostic.availableScopes].sort(), ['execution:work', 'foreground.context']);
  assert.match(unknown.content, /omit|without.*scope/i);
  assert.deepEqual(diagnostic.decisions, []);
  assert.deepEqual(diagnostic.lessons, []);

  const all = await relationshipRecallTool.execute({ learning: true }, runtime);
  assert.equal(all.is_error, undefined, all.content);
  const unfiltered = JSON.parse(all.content);
  assert.deepEqual([...unfiltered.availableScopes].sort(), ['execution:work', 'foreground.context']);
  assert.equal(unfiltered.requestedScope, null);
  assert.deepEqual(unfiltered.decisions.map((decision: any) => decision.decisionId).sort(),
    ['actual-foreground-choice', 'actual-work-choice']);

  const matching = await relationshipRecallTool.execute({ learning: true, scope: 'foreground.context' }, runtime);
  assert.equal(matching.is_error, undefined, matching.content);
  const filtered = JSON.parse(matching.content);
  assert.equal(filtered.requestedScope, 'foreground.context');
  assert.deepEqual(filtered.decisions.map((decision: any) => decision.decisionId), ['actual-foreground-choice']);
});

test('only new authenticated feedback can supersede a learned contribution; lifecycle editing cannot erase it', async t => {
  const text = 'Those memory messages are noise. Send less of that.';
  const { brain, ledger, ctx } = fixture(t, text);
  await relationshipNoteTool.execute({ type: 'attenuation', title: 'Memory commentary', statement: text, learning: feedback() }, ctx);
  const original = ledger.listEntries()[0]!;
  writeLearningSnapshot(ctx.seedStateDir, [], [{ lessonId: learningLessonId(original.seed_projection!.event.event_id, original.learning!.scope),
    scope: original.learning!.scope, tags: original.learning!.tags, excludes: original.learning!.excludes,
    sourceRefs: [original.seed_projection!.event.event_id], value: -0.25, basis: 'owner-feedback', authority: 'owner', criterion: 'owner-value',
    decisionId: feedback().decisionId, eligibility: { schema: 'home23.learning-decision.v1', decisionId: feedback().decisionId,
      scope: feedback().scope, tags: feedback().tags, sourceRefs: ['machine:observed-1'], criterion: 'owner-value' },
    createdAt: '2026-10-29T00:00:00.000Z', corroborations: 0, active: true }]);
  const remove = await relationshipUpdateTool.execute({ id: original.id, action: 'remove' }, ctx);
  assert.equal(remove.is_error, true);
  assert.equal(ledger.getEntry(original.id)?.status, 'active');
  const revised = 'That was useful. Keep noticing connections like that.';
  const ingress = { chatId: 'chat:owner', messageRef: 'message:revision', userText: revised };
  let validations = 0;
  const writer = new RelationshipLedger(brain, { validateCorrectionIngress: candidate => {
    validations++;
    return validations === 1 && JSON.stringify(candidate) === JSON.stringify(ingress);
  } });
  const input = { id: original.id, action: 'supersede', type: 'correction', statement: revised, learning: feedback('reinforce') };
  const runtime = { ...ctx, relationshipLedger: writer,
    authenticatedUserMessage: { chatId: ingress.chatId, messageRef: ingress.messageRef, text: revised } };
  const replacement = await relationshipUpdateTool.execute(input, runtime);
  assert.equal(replacement.is_error, undefined, replacement.content);
  assert.equal(writer.getEntry(original.id)?.status, 'superseded');
  const active = writer.listEntries().find(entry => entry.id !== original.id)!;
  assert.equal(active.actor, 'jtr');
  assert.ok(active.learning?.supersedes?.includes(learningLessonId(original.seed_projection!.event.event_id, original.learning!.scope)));
  assert.ok(active.learning?.evidenceRefs.includes('message:revision'));
  assert.equal(validations, 1);
  writeLearningSnapshot(ctx.seedStateDir, [], [{ lessonId: learningLessonId(original.seed_projection!.event.event_id, original.learning!.scope),
    scope: original.learning!.scope, tags: original.learning!.tags, excludes: original.learning!.excludes,
    sourceRefs: [original.seed_projection!.event.event_id], value: -0.25, basis: 'owner-feedback', authority: 'owner', criterion: 'owner-value',
    decisionId: feedback().decisionId, createdAt: '2026-10-29T00:00:00.000Z', corroborations: 0, active: false }]);
  const retry = await relationshipUpdateTool.execute(input, runtime);
  assert.equal(retry.is_error, undefined, retry.content);
  assert.match(retry.content, new RegExp(`with ${active.id}`));
  assert.equal(validations, 1, 'an applied replacement retry cannot spend another owner token');
  assert.equal(writer.listEntries().length, 2, 'retry preserves the original teaching and its one authenticated replacement');
});

test('a projection identity conflict remains pending without changing recorded source bytes', async t => {
  const text = 'Stop routine memory commentary. It is noise.';
  const { brain, ledger, ctx } = fixture(t, text);
  await relationshipNoteTool.execute({ type: 'attenuation', title: 'Noise', statement: text, learning: feedback() }, ctx);
  const events = path.join(brain, 'relationship-ledger.events.jsonl');
  const conflicting = JSON.parse(fs.readFileSync(events, 'utf8'));
  conflicting.payload.head = 'A conflicting body with the same event identity.';
  const conflictBytes = `${JSON.stringify(conflicting)}\n`;
  fs.writeFileSync(events, conflictBytes);
  const source = path.join(brain, 'relationship-ledger.json');
  const stored = JSON.parse(fs.readFileSync(source, 'utf8'));
  stored.entries[0].seed_projection.status = 'pending';
  fs.writeFileSync(source, JSON.stringify(stored));
  const restored = new RelationshipLedger(brain);
  assert.deepEqual(restored.flushSeedTeaching(), { projected: 0, pending: 1 });
  assert.equal(fs.readFileSync(events, 'utf8'), conflictBytes);
  assert.match((restored.listEntries()[0] as any).seed_projection.error, /identity conflicts/);
});
