import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Critique } = require('../../../engine/src/cognition/critique');
const { ThinkingMachine } = require('../../../engine/src/cognition/thinking-machine');

const proposal = { purpose: 'exploration', scope: 'private_research',
  why: 'The owner is interested in how musical phrasing survives changes of timbre.',
  nextMove: 'Compare the remembered MIDI guitar example with the owner conversation; form one grounded question about phrasing.',
  stopCondition: 'Stop after one sourced comparison, or disclose missing evidence without making up a musical claim.',
  evidenceRefs: ['memory:guitar'] };
const logger = { info() {}, warn() {} };

test('a kept musical inquiry can propose bounded initiative without an operational agenda', async () => {
  const prompts = [];
  const critique = new Critique({ logger, unifiedClient: { generate: async prompt => {
    prompts.push(prompt);
    return { content: JSON.stringify({ verdict: 'keep', confidence: 0.9, agendaCandidates: [], residentInitiative: proposal }) };
  } } });
  const verdict = await critique.evaluate({ thought: 'Musical phrasing may carry identity across timbre.', outreachEvidenceRefs: ['memory:guitar'] });
  assert.deepEqual(verdict.residentInitiative, proposal);
  assert.deepEqual(verdict.agendaCandidates, []);
  assert.match(prompts[0].instructions, /Interests need not pretend to be machine faults/);
  assert.match(prompts[0].instructions, /grant no authority/);
});

test('unsupported source references, invented authority and discarded thoughts cannot initiate work', async () => {
  for (const change of [{ evidenceRefs: ['invented:proof'] }, { authorityLevel: 'L4' }, { scope: 'public_publish' }]) {
    const critique = new Critique({ logger, unifiedClient: { generate: async () => ({ content: JSON.stringify({ verdict: 'keep', residentInitiative: { ...proposal, ...change } }) }) } });
    assert.equal((await critique.evaluate({ outreachEvidenceRefs: ['memory:guitar'] })).residentInitiative, null);
  }
  const critique = new Critique({ logger, unifiedClient: { generate: async () => ({ content: JSON.stringify({ verdict: 'discard', residentInitiative: proposal }) }) } });
  assert.equal((await critique.evaluate({ outreachEvidenceRefs: ['memory:guitar'] })).residentInitiative, null);
});

test('the actual thinking cycle forwards a kept initiative separately from agenda and publication', async () => {
  const admitted = []; const published = []; const events = [];
  const graph = { nodes: new Map([['guitar', { id: 'guitar', concept: 'An old MIDI guitar example.', tag: 'historical' }]]), edges: new Map(), clusters: new Map() };
  const machine = new ThinkingMachine({ logger, memory: graph, discoveryEngine: { pop: () => [] },
    unifiedClient: { generate: async args => ({ content: args.component === 'critique'
      ? JSON.stringify({ verdict: 'keep', confidence: 0.9, gaps: [], rationale: 'A grounded inquiry.', agendaCandidates: [], residentInitiative: proposal })
      : 'A musical comparison is worth checking before claiming phrasing is invariant.' }) },
    config: { eventLedger: { record: (type, id, payload) => events.push({ type, payload }) }, agendaStore: { add() { assert.fail('Inquiry must not manufacture an agenda task'); } } },
    emitThought: () => {}, logThought: () => {} });
  machine.pgsAdapter = { connect: async () => ({ available: false, perspectives: [], candidateEdges: [], connectionNotes: [], usage: {} }) };
  machine.setResidentInitiativeHandler(async (value, context) => { admitted.push({ value, context }); return { pursuit: { id: 'ap_guitar' }, decision: { route: 'watch' } }; });
  machine.setPublishHooks({ onCriticVerdict: value => published.push(value) });
  await machine._runCycle({ signal: 'exploration', score: 1, nodeIds: ['guitar'], rationale: 'A sourced musical question.' });
  assert.equal(admitted.length, 1);
  assert.deepEqual(admitted[0].value, proposal);
  assert.ok(admitted[0].context.evidenceRefs.includes('memory:guitar'));
  assert.equal(published.length, 1);
  assert.ok(events.some(event => event.type === 'ResidentInitiativeProposed' && event.payload.pursuitId === 'ap_guitar'));
});
