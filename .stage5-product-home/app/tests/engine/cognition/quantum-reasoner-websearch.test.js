import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { QuantumReasoner } = require('../../../engine/src/cognition/quantum-reasoner.js');

test('QuantumReasoner does not request web search when the assigned provider cannot support it', async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = oldKey || 'test-key';
  const calls = [];
  try {
    const qr = new QuantumReasoner({
      reasoning: {
        mode: 'quantum',
        parallelBranches: 1,
        collapseStrategy: 'best',
      },
      models: { enableWebSearch: true },
    }, { info() {}, warn() {}, error() {}, debug() {} });

    qr.gpt5 = {
      supportsWebSearch() {
        return { supported: false, provider: 'minimax' };
      },
      async generateWithWebSearch() {
        throw new Error('web search should not be requested');
      },
      async generate(opts) {
        calls.push(opts);
        return { content: 'NO_ACTION\nNo current action.', model: 'MiniMax-M3' };
      },
    };

    const result = await qr.generateSuperposition('test prompt', { allowWebSearch: true, cycle: 1 });

    assert.equal(calls.length, 1);
    assert.equal(result.superposition[0].usedWebSearch, false);
    assert.deepEqual(qr.lastPolicyDecision.webSearchAssignments, [0]);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  }
});
