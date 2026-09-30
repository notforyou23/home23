import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PGSAdapter } = require('../../../engine/src/cognition/pgs-adapter.js');
const { Critique } = require('../../../engine/src/cognition/critique.js');
const { UnifiedClient } = require('../../../engine/src/core/unified-client.js');
const { synthesize } = require('../../../shared/research-runtime/pgs-engine/src/synthesizer.js');
const logger = { info() {}, warn() {} };
const researchTaxonomy = /SPINE|FACET|ARTIFACT|Ranked Experiments|Commit Step/;
const thought = 'A corrected preference should change the next recommendation rather than make the owner explain it again.';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(providerGenerate) {
  // Exercise UnifiedClient's real assignment/effort forwarding without
  // credentials, network or an actual provider request.
  const client = Object.create(UnifiedClient.prototype);
  client.logger = logger;
  client.getModelAssignment = component => ({
    provider: 'openai-codex',
    model: component === 'pgsSweep' ? 'gpt-6-luna' : 'gpt-6.1-sol',
    ...(component === 'pgsSweep' ? {} : { reasoningEffort: 'high' }),
  });
  client.getOpenAICodexGPT5Client = () => ({ generate: providerGenerate });
  const nodes = new Map(Array.from({ length: 12 }, (_, index) => [String(index + 1), {
    id: String(index + 1), concept: index === 0
      ? 'CORRECTION: an earlier suggestion was the assistant’s framing, not an owner preference.'
      : `Supporting material ${index + 1}`,
  }]));
  const edges = new Map([['1->7', { weight: 1 }], ['1->2', { weight: 1 }]]);
  const adapter = new PGSAdapter({ unifiedClient: client, memory: { nodes, edges }, logger });
  assert.equal(adapter.available, true);
  const partitions = [
    { id: 'one', nodeIds: ['1', '2', '3', '4', '5', '6'] },
    { id: 'two', nodeIds: ['7', '8', '9', '10', '11', '12'] },
  ].map(partition => ({
    ...partition, nodeCount: 6, summary: `Material ${partition.id}`,
    keywords: ['correction'], adjacentPartitions: [],
  }));
  adapter.engine._getOrCreatePartitions = async () => partitions;
  return { adapter, critique: new Critique({ unifiedClient: client, logger }) };
}

const keptVerdict = {
  verdict: 'keep', confidence: 0.9, rationale: 'This is a grounded inquiry.',
  gaps: [], agendaCandidates: [], ownerOutreach: null, residentInitiative: null,
};

test('two completed sweeps feed one resident connection brief through extraction and critique', async () => {
  const sweepsStarted = deferred();
  const firstSweep = deferred();
  const secondSweep = deferred();
  const calls = [];
  const answer = '## Correction burden\nNode 1 connects to Node 7 through how a remembered correction changes the next recommendation; the wider pattern remains tentative.';
  const { adapter, critique } = fixture(async options => {
    calls.push(options);
    if (options.component === 'pgsSweep') {
      const index = calls.filter(call => call.component === 'pgsSweep').length;
      if (index === 2) sweepsStarted.resolve();
      return index === 1 ? firstSweep.promise : secondSweep.promise;
    }
    if (options.component === 'pgsSynthesis') return { content: answer, model: options.model };
    return { content: `\`\`\`json\n${JSON.stringify(keptVerdict)}\n\`\`\``, model: options.model };
  });
  const connecting = adapter.connect({ thought, referencedNodes: ['1'] });
  await sweepsStarted.promise;
  assert.equal(calls.length, 2);
  assert.ok(calls[0].messages[0].content.includes('CORRECTION: an earlier suggestion'));
  assert.ok(calls.every(call => call.messages[0].content.includes(thought)));
  const firstFindings = 'FIRST FINDINGS: Node 1 documents a corrected framing.';
  const secondFindings = 'SECOND FINDINGS: Node 7 supports remembering a preference.';
  firstSweep.resolve({ content: firstFindings });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2, 'synthesis must wait for the second sweep');
  secondSweep.resolve({ content: secondFindings });
  const result = await connecting;

  assert.deepEqual(calls.map(call => call.component), ['pgsSweep', 'pgsSweep', 'pgsSynthesis']);
  const synthesis = calls[2];
  assert.equal(synthesis.model, 'gpt-6.1-sol');
  assert.equal(synthesis.reasoningEffort, 'high');
  assert.equal(synthesis.signal, calls[0].signal);
  assert.equal(synthesis.signal.aborted, false);
  assert.doesNotMatch(synthesis.instructions, researchTaxonomy);
  assert.match(synthesis.instructions, /no minimum number of connections/);
  assert.match(synthesis.instructions, /Preserve memory authority and correction labels/);
  assert.match(synthesis.instructions, /superseded claims, or closed incidents/);
  assert.match(synthesis.instructions, /limited partition coverage/i);
  assert.ok(synthesis.messages[0].content.includes(thought));
  assert.ok(synthesis.messages[0].content.includes(firstFindings));
  assert.ok(synthesis.messages[0].content.includes(secondFindings));
  assert.equal(result.available, true);
  assert.equal(result.usage.partitionsTouched, 2);
  assert.equal(result.answer, answer);
  assert.deepEqual(result.candidateEdges.map(({ from, to }) => ({ from, to })), [{ from: '1', to: '7' }]);
  assert.deepEqual(result.connectionNotes[0].nodeIds, ['1', '7']);
  assert.deepEqual(result.perspectives[0].searchResult, ['1', '7']);

  const verdict = await critique.evaluate({ thought, pgsResult: result });
  assert.equal(verdict.verdict, 'keep');
  assert.equal(verdict.model, 'gpt-6.1-sol');
  assert.deepEqual(verdict.agendaCandidates, []);
  assert.equal(verdict.residentInitiative, null);
  const criticCall = calls[3];
  assert.equal(criticCall.component, 'critique');
  assert.ok(criticCall.messages[0].content.includes('1→7:'));
  assert.ok(criticCall.messages[0].content.includes(answer));
  assert.match(criticCall.instructions, /JSON inside a markdown code block/);
});

test('ordinary research synthesis retains its existing taxonomy and supplied material', async () => {
  let captured;
  const answer = await synthesize('Research question', [{
    partitionId: 'research', partitionSummary: 'Research material', nodesIncluded: 2,
    keywords: ['research'], sweepOutput: 'Original research findings.',
  }], { async generate(options) { captured = options; return { content: 'Research verdict.' }; } }, {
    totalNodes: 2, totalEdges: 1, totalPartitions: 1, selectedPartitions: 1,
  }, { synthesisMaxTokens: 3000 });
  assert.equal(answer, 'Research verdict.');
  for (const section of ['SPINE', 'FACET', 'ARTIFACT', 'Ranked Experiments', 'Commit Step']) {
    assert.ok(captured.instructions.includes(section), `research retains ${section}`);
  }
  assert.ok(captured.input.includes('Original research findings.'));
  assert.ok(captured.input.includes('Research question'));
  assert.equal(captured.reasoningEffort, 'high');
  assert.equal(captured.maxTokens, 3000);
});

test('no useful connection remains a valid resident result without fabricated graph edges or tasks', async () => {
  const answer = 'No useful connection emerges from the supplied findings; the thought can be evaluated on its own merits.';
  const calls = [];
  const { adapter, critique } = fixture(async options => {
    calls.push(options);
    if (options.component === 'pgsSweep') return { content: 'The partition does not establish a useful association.' };
    if (options.component === 'pgsSynthesis') return { content: answer };
    return { content: `\`\`\`json\n${JSON.stringify(keptVerdict)}\n\`\`\``, model: options.model };
  });
  const result = await adapter.connect({ thought, referencedNodes: ['1'] });
  assert.equal(result.available, true);
  assert.equal(result.note, null);
  assert.equal(result.answer, answer);
  assert.deepEqual(result.candidateEdges, []);
  assert.deepEqual(result.connectionNotes, []);
  assert.deepEqual(result.perspectives, []);
  assert.equal(calls.filter(call => call.component === 'pgsSynthesis').length, 1);
  const verdict = await critique.evaluate({ thought, pgsResult: result });
  assert.equal(verdict.verdict, 'keep');
  assert.deepEqual(verdict.agendaCandidates, []);
  assert.equal(verdict.ownerOutreach, null);
  assert.equal(verdict.residentInitiative, null);
  assert.ok(calls.at(-1).messages[0].content.includes(answer));
});
