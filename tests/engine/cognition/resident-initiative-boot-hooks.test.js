import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AgencyKernel } from '../../../engine/src/agency/resident-kernel.js';
import { ResidentInitiationDriver } from '../../../engine/src/agency/resident-initiation.js';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator');
const logger = { info() {}, warn() {}, error() {} };
const proposal = { purpose: 'exploration', scope: 'private_research',
  why: 'A sourced musical example gives a concrete reason to investigate phrasing across timbres.',
  nextMove: 'Compare the remembered MIDI guitar example with its earlier guitar performance in a private note.',
  stopCondition: 'Stop after one sourced comparison or state the missing evidence.', evidenceRefs: ['memory:guitar'] };

function deferredOrchestrator(logs = []) {
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.thinkingMachine = null;
  orchestrator.logger = { ...logger, info: (message, details) => logs.push({ message, details }) };
  orchestrator.buildCurrentTemporalContext = () => null;
  orchestrator.getOwnerOutreachPolicy = () => null;
  return orchestrator;
}

function createMachine(orchestrator, prompts = [], events = []) {
  const memory = { nodes: new Map([['guitar', { id: 'guitar', concept: 'An older MIDI guitar example.', tag: 'historical' }]]), edges: new Map(), clusters: new Map() };
  const machine = orchestrator.createThinkingMachine({ logger, memory, discoveryEngine: { pop: () => [] },
    unifiedClient: { generate: async args => {
      prompts.push(args);
      return { content: args.component === 'critique'
        ? JSON.stringify({ verdict: 'keep', confidence: 0.9, gaps: [], rationale: 'A sourced inquiry.', agendaCandidates: [], residentInitiative: proposal })
        : 'A sourced private comparison can test what musical phrasing preserves across timbres.' };
    } }, config: { eventLedger: { record: (type, id, payload) => events.push({ type, payload }) } },
    emitThought() {}, logThought() {} });
  machine.pgsAdapter = { connect: async () => ({ available: false, note: 'fixture', perspectives: [], candidateEdges: [], connectionNotes: [], usage: {} }) };
  orchestrator.thinkingMachine = machine;
  return machine;
}

test('normal deferred creation retains initiative callbacks and context before the first real cycle', async t => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-initiative-boot-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const kernel = new AgencyKernel({ brainDir, agentName: 'jerry', config: { enabled: true, mode: 'live' }, logger });
  const driver = new ResidentInitiationDriver({ kernel, brainDir, isPrimaryResident: () => true,
    sendInitiation: async () => assert.fail('This fixture does not execute a Work') });
  driver.initialize();
  const logs = [], orchestrator = deferredOrchestrator(logs), prompts = [], forwarded = [];
  // The entrypoint binds before start() constructs the ThinkingMachine.
  orchestrator.setResidentInitiativeHooks({
    onProposal: async (value, context) => { forwarded.push({ value, context }); return driver.propose(value, context); },
    getContext: () => driver.getContext(),
  });
  assert.equal(orchestrator.thinkingMachine, null);
  const machine = createMachine(orchestrator, prompts);
  assert.deepEqual(logs.filter(row => row.message === '[thinking-machine] resident initiative hooks bound'),
    [{ message: '[thinking-machine] resident initiative hooks bound', details: { proposal: true, context: true } }]);
  await machine._runCycle({ signal: 'exploration', score: 1, nodeIds: ['guitar'], rationale: 'A sourced musical question.' });
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].value, proposal);
  assert.ok(forwarded[0].context.evidenceRefs.includes('memory:guitar'));
  assert.match(prompts.find(value => value.component === 'critique').messages[0].content, /Resident moves already admitted/);
  const saved = JSON.parse(fs.readFileSync(path.join(brainDir, 'agency/resident-initiation.json')));
  assert.equal(Object.keys(saved.responsibilities).length, 1, 'The real driver received and durably tracked the proposal');
  assert.deepEqual(saved.admissions, {}, 'Proposal intake does not claim Core admission or delivery');
});

test('ordinary deferred creation has no initiative effect; late binding and clearing update the current machine', async () => {
  const logs = [], orchestrator = deferredOrchestrator(logs);
  const events = [], machine = createMachine(orchestrator, [], events);
  assert.equal(machine.onResidentInitiative, null);
  assert.equal(machine.getResidentInitiativeContext, null);
  assert.equal(logs.some(row => row.message === '[thinking-machine] resident initiative hooks bound'), false);
  await machine._runCycle({ signal: 'exploration', score: 1, nodeIds: ['guitar'], rationale: 'A sourced musical question.' });
  assert.equal(events.some(row => row.type === 'ResidentInitiativeProposed'), false);
  const onProposal = () => {}, getContext = () => 'existing responsibility';
  orchestrator.setResidentInitiativeHooks({ onProposal, getContext });
  assert.equal(machine.onResidentInitiative, onProposal);
  assert.equal(machine.getResidentInitiativeContext, getContext);
  orchestrator.setResidentInitiativeHooks({ onProposal: true, getContext: 'invalid' });
  assert.equal(machine.onResidentInitiative, null);
  assert.equal(machine.getResidentInitiativeContext, null);
});
