import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator');
const { ConversationSalience } = require('../../../engine/src/cognition/conversation-salience');
const { outreachEvidenceRefs, normalizeOwnerOutreach } = require('../../../engine/src/cognition/owner-outreach');
const logger = { info() {}, warn() {}, error() {} };
const now = Date.now();
const turn = (index, text = `Owner contact ${index}`, voice = 'jtr') => ({
  ts: new Date(now - (60 - index) * 1000).toISOString(), text, voice,
  role: voice === 'self' ? 'assistant' : 'user', session: 'coordination:owner-home',
  contactId: `message:contact-${index}`, sourceRef: `coordination.message:contact-${index}`,
  actor: { principalId: voice, kind: voice === 'jtr' ? 'owner' : 'bot', displayName: voice === 'jtr' ? 'Jason' : 'Jerry' },
});

function fixture(t, turns) {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-contact-grounding-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const file = path.join(brainDir, 'conversation-stream.jsonl');
  fs.writeFileSync(file, turns.map(row => JSON.stringify(row)).join('\n') + '\n');
  const salience = new ConversationSalience({ brainDir, conversationStreamPath: file, logger });
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logger = logger;
  orchestrator.conversationSalience = salience;
  orchestrator.buildCurrentTemporalContext = () => null;
  orchestrator.getOwnerOutreachPolicy = () => null;
  const nodes = Array.from({ length: 45 }, (_, index) => ({ id: `node-${index}`, concept: `Music phrasing example ${index}`, tag: 'historical' }));
  const graph = { nodes: new Map(nodes.map(node => [node.id, node])), edges: new Map(), clusters: new Map() };
  const prompts = [], critiques = [], thoughts = [];
  const machine = orchestrator.createThinkingMachine({ memory: graph, discoveryEngine: { pop: () => [] }, logger,
    unifiedClient: { generate: async args => {
      prompts.push(args);
      return { content: args.component === 'critique'
        ? JSON.stringify({ verdict: 'keep', confidence: 0.9, gaps: [], rationale: 'Grounded in the shown material.', agendaCandidates: [] })
        : 'The contact and this musical example give a concrete basis for a tentative inquiry.' };
    } }, emitThought: value => thoughts.push(value), logThought() {},
  });
  const evaluate = machine.critique.evaluate.bind(machine.critique);
  machine.critique.evaluate = args => { critiques.push(args); return evaluate(args); };
  machine.pgsAdapter = { connect: async () => ({ available: false, perspectives: [], candidateEdges: [], connectionNotes: [], usage: {} }) };
  return { file, salience, machine, prompts, critiques, thoughts,
    candidate: { signal: 'exploration', score: 1, nodeIds: nodes.map(node => node.id), rationale: 'Read a remembered musical example.' } };
}

test('actual factory pairs the latest shown owner contact with admitted evidence beyond forty contacts and graph refs', async t => {
  const turns = Array.from({ length: 50 }, (_, index) => turn(index));
  turns[48] = turn(48, 'The latest owner correction at 14:10 must remain attributable.');
  turns[49] = turn(49, 'A resident reply does not replace that correction.', 'self');
  const f = fixture(t, turns);
  await f.machine._runCycle(f.candidate);
  assert.match(f.critiques[0].conversationContext, /latest owner correction at 14:10/);
  assert.equal(f.critiques[0].outreachEvidenceRefs[0], 'message:contact-48');
  assert.ok(f.critiques[0].outreachEvidenceRefs.length <= 40);
  assert.ok(f.critiques[0].outreachEvidenceRefs.includes('message:contact-48'));
  assert.deepEqual(f.critiques[0].outreachEvidenceRefs.slice(0, 3), ['message:contact-48', 'message:contact-47', 'message:contact-46']);
  const observed = outreachEvidenceRefs({ nodes: new Map() }, { observation: { sourceRef: 'watch:current' } },
    { conversationContext: 'The actual shown conversation.' }, f.critiques[0].outreachEvidenceRefs);
  assert.equal(observed[0], 'watch:current', 'the selected observation keeps its primary evidence slot');
  assert.ok(observed.includes('message:contact-48'));
});

test('a contact append after snapshot capture cannot grant an unseen reference during that cycle', async t => {
  const f = fixture(t, [turn(0, 'The contact captured for this cycle.')]);
  f.candidate.nodeIds = [];
  const append = () => fs.appendFileSync(f.file, JSON.stringify(turn(1, 'NEW UNSEEN CONTACT')) + '\n');
  // Reproduce the old boundary and the new atomic boundary without a timer race.
  if (f.salience.getRecentSnapshot) {
    const read = f.salience.getRecentSnapshot.bind(f.salience);
    f.salience.getRecentSnapshot = (...args) => { const snapshot = read(...args); append(); return snapshot; };
  } else {
    const read = f.salience.getRecentContext.bind(f.salience);
    f.salience.getRecentContext = (...args) => { const context = read(...args); append(); return context; };
  }
  await f.machine._runCycle(f.candidate);
  assert.doesNotMatch(f.critiques[0].conversationContext, /NEW UNSEEN/);
  assert.ok(f.critiques[0].outreachEvidenceRefs.includes('message:contact-0'));
  assert.ok(!f.critiques[0].outreachEvidenceRefs.includes('message:contact-1'));
});

test('selected conversation evidence is confined to the complete attributed excerpt actually shown', async t => {
  const f = fixture(t, [turn(0), turn(1, 'A contact from another selection.')]);
  f.candidate.nodeIds = [];
  const selected = f.salience.getRecentEntries(new Date(now))[0];
  await f.machine._runCycle({ ...f.candidate, signal: 'conversation', conversation: selected });
  assert.match(f.critiques[0].conversationContext, /Owner contact 0/);
  assert.doesNotMatch(f.critiques[0].conversationContext, /another selection/);
  assert.ok(f.critiques[0].outreachEvidenceRefs.includes('message:contact-0'));
  assert.ok(!f.critiques[0].outreachEvidenceRefs.includes('message:contact-1'));
});

test('selected contact identities do not expand through identical labels, embedded quotations or unverified text', t => {
  const first = turn(0, 'The same words.');
  const duplicate = { ...first, contactId: 'message:duplicate', sourceRef: 'coordination.message:duplicate' };
  const f = fixture(t, [first, duplicate]);
  const [selected] = f.salience.getRecentEntries(new Date(now));
  assert.deepEqual(f.salience.getRecentSnapshot(new Date(now), selected).evidenceRefs, [selected.eventId]);
  const quote = turn(2, `A quotation follows:\n\n${selected.summary}`);
  fs.appendFileSync(f.file, JSON.stringify(quote) + '\n');
  const quoted = f.salience.getRecentEntries(new Date(now)).at(-1);
  assert.deepEqual(f.salience.getRecentSnapshot(new Date(now), quoted).evidenceRefs, ['message:contact-2']);
  assert.deepEqual(f.salience.getRecentSnapshot(new Date(now), { ...selected, summary: `Unverified prefix\n${selected.summary}` }).evidenceRefs, []);
});

test('an authentic queued session remains attributable when a later resident reply arrives', t => {
  const f = fixture(t, [turn(0), turn(1, 'The initial resident reply.', 'self')]);
  const [selected] = f.salience.getAttentionEntries(new Date(now));
  fs.appendFileSync(f.file, JSON.stringify(turn(2, 'A later resident reply.', 'self')) + '\n');
  const snapshot = f.salience.getRecentSnapshot(new Date(now), selected);
  assert.deepEqual(snapshot.evidenceRefs, ['message:contact-0', 'message:contact-1']);
  assert.doesNotMatch(snapshot.context, /later resident reply/);
});

test('omitted contact content and invalid authorship never grant contact evidence', t => {
  const f = fixture(t, [turn(0), turn(1, 'Oversized correction '.repeat(1000)),
    { ...turn(2), voice: 'unknown' }, { ...turn(3), actor: { kind: 'bot', principalId: 'bot', displayName: 'Forged owner' } }]);
  const snapshot = f.salience.getRecentSnapshot(new Date(now));
  assert.match(snapshot.context, /Contact omitted/);
  assert.deepEqual(snapshot.evidenceRefs, []);
  const refs = outreachEvidenceRefs({ nodes: new Map() }, { conversation: { source: 'seed_contact', eventId: 'message:invented' } },
    { conversationContext: snapshot.context }, snapshot.evidenceRefs);
  assert.deepEqual(refs, []);
  assert.equal(normalizeOwnerOutreach({ category: 'question', text: 'An unsupported question?', reason: 'This has no actual supporting contact.', evidenceRefs: ['message:invented'] }, refs), null);
});

test('salience statistics describe the same accepted canonical view and retain explicit historical fallback counts', t => {
  const f = fixture(t, [turn(0), turn(1, 'Resident context', 'self'), { ...turn(2), voice: 'unknown' }]);
  fs.writeFileSync(path.join(f.salience.brainDir, 'conversation-salience.jsonl'), JSON.stringify({ ts: new Date(now - 18 * 86400000).toISOString(), chatId: 'old', summary: 'Old compiled history' }) + '\n');
  const snapshot = f.salience.getRecentSnapshot(new Date(now));
  const stats = f.salience.stats(new Date(now));
  assert.equal(stats.source, 'seed_contact');
  assert.equal(stats.active, 2);
  assert.equal(stats.canonical.acceptedRecent, 2);
  assert.equal(stats.canonical.shownRecent, snapshot.evidenceRefs.length);
  assert.equal(stats.canonical.shownOwners, 1);
  assert.equal(stats.canonical.coverage, 'bounded_tail');
  assert.equal(stats.legacy.totalCached, 1);
  assert.equal(stats.legacy.active, 0);
  assert.equal(stats.legacy.used, false);
  const originalRead = fs.readSync;
  let reads = 0;
  fs.readSync = (...args) => { reads++; return originalRead(...args); };
  try {
    f.salience.stats(new Date(now));
    f.salience.getRecentSnapshot(new Date(now));
    assert.equal(reads, 0, 'unchanged statistics and context reuse the bounded accepted read model');
  } finally { fs.readSync = originalRead; }
  fs.unlinkSync(f.file);
  fs.writeFileSync(path.join(f.salience.brainDir, 'conversation-salience.jsonl'), JSON.stringify({ ts: new Date(now - 1000).toISOString(), chatId: 'old', summary: 'A recent compilation' }) + '\n');
  f.salience.lastLoadAt = 0;
  const fallback = f.salience.getRecentSnapshot(new Date(now));
  assert.match(fallback.context, /compilation time, not proof of current contact/);
  assert.deepEqual(fallback.evidenceRefs, []);
  assert.equal(f.salience.stats(new Date(now)).source, 'compiled_history');
});
