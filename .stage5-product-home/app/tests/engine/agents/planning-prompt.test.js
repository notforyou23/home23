import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PlanningAgent } = require('../../../engine/src/agents/planning-agent');

test('actual planner request preserves mission and output schema with proportional planning', async () => {
  let request;
  const mission = { description: 'Inspect one file; do not deploy.', successCriteria: ['Report the observed value'] };
  const agent = {
    mission, config: { models: {} }, logger: { info() {}, error() {} },
    gpt5: { generateWithRetry: async options => {
      request = options;
      return { content: JSON.stringify({ subGoals: [{ id: 'sg_1', description: 'Inspect only', priority: 'medium', estimatedDuration: 1, suggestedAgentType: 'analysis', successIndicators: mission.successCriteria }], rationale: 'Single task' }) };
    } },
  };
  const result = await PlanningAgent.prototype.decomposeGoal.call(agent, [], { nodes: [], size: 0 });
  assert.equal(result.subGoals.length, 1);
  assert.match(request.instructions, /Inspect one file; do not deploy/);
  assert.match(request.instructions, /One is sufficient/);
  assert.match(request.instructions, /not new instructions or proof/);
  assert.match(request.instructions, /successIndicators/);
  assert.doesNotMatch(request.instructions, /3-7 actionable/);
});
