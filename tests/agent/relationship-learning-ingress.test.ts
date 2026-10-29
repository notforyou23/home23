import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { RelationshipLedger } from '../../src/agent/relationship-ledger.js';
import { relationshipNoteTool, relationshipRecallTool, relationshipUpdateTool } from '../../src/agent/tools/relationship.js';
import { learningLessonId } from '../../shared/seed-learning.cjs';

function fixture(t: { after(fn: () => void): void }, text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-learning-ingress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brain = path.join(root, 'jerry', 'brain');
  const ingress = { chatId: 'chat:owner', messageRef: 'message:feedback', userText: text };
  const ledger = new RelationshipLedger(brain, {
    validateCorrectionIngress: candidate => JSON.stringify(candidate) === JSON.stringify(ingress),
  });
  const ctx = { chatId: ingress.chatId, relationshipLedger: ledger,
    authenticatedUserMessage: { chatId: ingress.chatId, messageRef: ingress.messageRef, text } } as any;
  return { root, brain, ledger, ingress, ctx };
}

function feedback(direction: 'attenuate' | 'reinforce' = 'attenuate') {
  return { schema: 'home23.learning-feedback.v1', decisionId: 'decision:memory-watch:1',
    scope: 'owner.outreach:machine.memory', direction, basis: 'owner-feedback',
    tags: ['routine', 'mild'], excludes: ['critical', 'owner-requested'], evidenceRefs: [] };
}

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
  fs.mkdirSync(path.join(stateDir, 'checkpoints'), { recursive: true });
  const decisions = [
    { schema: 'home23.learning-decision.v1', decisionId: 'actual-memory-choice', scope: 'owner.outreach:machine.memory',
      tags: ['routine', 'mild'], sourceRefs: ['machine:observed-1'], criterion: 'owner-value' },
    { schema: 'home23.learning-decision.v1', decisionId: 'actual-other-choice', scope: 'context.operational',
      tags: ['operational'], sourceRefs: ['message:other'], criterion: 'owner-value' },
  ];
  const development = { 'world.home': { experience: { version: 1, decisions, lessons: [], seenFeedbackIds: [] } } };
  const stateHash = createHash('sha256').update(JSON.stringify({ cells: [], dispositions: {}, development })).digest('hex');
  const line = JSON.stringify({ seq: 1, prevHash: '0'.repeat(64), category: 'genesis', payload: {}, stateHashAfter: stateHash });
  fs.writeFileSync(path.join(stateDir, 'seed-ledger.jsonl'), `${line}\n`);
  fs.writeFileSync(path.join(stateDir, 'checkpoints', 'ckpt_0001.json'), JSON.stringify({
    version: 2, cells: [], dispositions: {}, stateHash,
    ledgerSeq: 1, ledgerCursor: createHash('sha256').update(line).digest('hex'),
    development,
  }));
  const result = await relationshipRecallTool.execute({ learning: true, scope: 'owner.outreach:machine.memory', limit: 1 },
    { ...ctx, seedStateDir: stateDir });
  assert.equal(result.is_error, undefined, result.content);
  const inspected = JSON.parse(result.content);
  assert.equal(inspected.seedSequence, 1);
  assert.deepEqual(inspected.decisions.map((decision: any) => decision.decisionId), ['actual-memory-choice']);
  assert.doesNotMatch(result.content, /actual-other-choice/);
  assert.ok(inspected.decisions[0].sourceRefs.includes('machine:observed-1'));
});

test('only new authenticated feedback can supersede a learned contribution; lifecycle editing cannot erase it', async t => {
  const text = 'Those memory messages are noise. Send less of that.';
  const { brain, ledger, ctx } = fixture(t, text);
  await relationshipNoteTool.execute({ type: 'attenuation', title: 'Memory commentary', statement: text, learning: feedback() }, ctx);
  const original = ledger.listEntries()[0]!;
  const remove = await relationshipUpdateTool.execute({ id: original.id, action: 'remove' }, ctx);
  assert.equal(remove.is_error, true);
  assert.equal(ledger.getEntry(original.id)?.status, 'active');
  const revised = 'That was useful. Keep noticing connections like that.';
  const ingress = { chatId: 'chat:owner', messageRef: 'message:revision', userText: revised };
  const writer = new RelationshipLedger(brain, { validateCorrectionIngress: candidate => JSON.stringify(candidate) === JSON.stringify(ingress) });
  const replacement = await relationshipUpdateTool.execute({ id: original.id, action: 'supersede', type: 'correction',
    statement: revised, learning: feedback('reinforce') }, { ...ctx, relationshipLedger: writer,
    authenticatedUserMessage: { chatId: ingress.chatId, messageRef: ingress.messageRef, text: revised } });
  assert.equal(replacement.is_error, undefined, replacement.content);
  assert.equal(writer.getEntry(original.id)?.status, 'superseded');
  const active = writer.listEntries().find(entry => entry.id !== original.id)!;
  assert.equal(active.actor, 'jtr');
  assert.ok(active.learning?.supersedes?.includes(learningLessonId(original.seed_projection!.event.event_id, original.learning!.scope)));
  assert.ok(active.learning?.evidenceRefs.includes('message:revision'));
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
