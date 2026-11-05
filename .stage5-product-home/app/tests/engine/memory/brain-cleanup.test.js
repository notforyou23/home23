import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyBrainCleanupCandidate,
  collectBrainCleanupCandidates,
} = require('../../../engine/src/memory/brain-cleanup.js');

test('brain cleanup classifies autonomous prompt-handling preamble as junk', () => {
  const node = {
    id: 'n1',
    tag: 'curator',
    concept: 'The user is asking me to produce output following the system instructions. Let me ground myself first by checking the current state.',
  };

  assert.equal(classifyBrainCleanupCandidate(node).reason, 'prompt_handling_preamble');
});

test('brain cleanup spares conversation and content-bearing operational claims', () => {
  assert.equal(classifyBrainCleanupCandidate({
    id: 'conversation-1',
    tag: 'conversation',
    concept: 'The user is asking me to clean the brain and keep conversation salient.',
  }), null);
  assert.equal(classifyBrainCleanupCandidate({
    id: 'claim-1',
    tag: 'analyst',
    concept: 'The dispatch ledger has zero writes for 1000 minutes and two chronic live problems are open.',
  }), null);
});

test('collectBrainCleanupCandidates reports counts by reason and honors limit', () => {
  const memory = {
    nodes: new Map([
      ['n1', { id: 'n1', tag: 'curator', concept: 'Let me ground this properly.' }],
      ['n2', { id: 'n2', tag: 'analyst', concept: 'The user wants me to answer. I should first check the relevant files and current state.' }],
      ['n3', { id: 'n3', tag: 'conversation', concept: 'Let me ground this properly.' }],
    ]),
  };

  const result = collectBrainCleanupCandidates(memory, { limit: 10 });

  assert.equal(result.totalCandidates, 2);
  assert.equal(result.byReason.short_meta_grounding_fragment, 1);
  assert.equal(result.byReason.prompt_handling_preamble, 1);
  assert.deepEqual(result.candidates.map(c => c.id), ['n1', 'n2']);
});
