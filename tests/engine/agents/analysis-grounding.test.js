import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AnalysisAgent } = require('../../../engine/src/agents/analysis-agent.js');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// An analysis mission with zero knowledge to analyse is a loop ticking:
// the machine reasoning at length about something it has no information on,
// then filing the result forever. Measured: ~10,152 nodes/generation.
// It must not RUN -- not run-and-discard. The LLM call is paid.
test('an analysis mission with zero relevant knowledge does not run', async () => {
  const agent = new AnalysisAgent({
    description: 'Analyze an empty topic with nothing in memory',
    successCriteria: ['Produce a grounded analysis'],
    maxDuration: 1000,
  }, { models: {} }, logger);

  agent.memory = { query: async () => [] };
  agent.getKnowledgeDomain = async () => {
    throw new Error('should not explore knowledge domain with zero relevant knowledge');
  };
  agent.getKnowledgeClusters = async () => {
    throw new Error('should not explore knowledge landscape with zero relevant knowledge');
  };
  agent.frameAnalysisProblem = async () => {
    throw new Error('should not run multi-perspective analysis with zero relevant knowledge');
  };
  agent.analyzePerspective = async () => {
    throw new Error('should not call the paid perspective LLM with zero relevant knowledge');
  };

  const result = await agent.execute();

  assert.equal(result.success, false);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.reason, 'zero_evidence');
  assert.equal(result.perspectivesAnalyzed, 0);
  assert.equal(result.insightsGenerated, 0);
  assert.equal(result.implicationsIdentified, 0);
  assert.equal(agent.results[0].status, 'needs_input');
  assert.equal(agent.results[0].reason, 'zero_evidence');
});

test('an analysis mission with real knowledge still runs and persists', async () => {
  const agent = new AnalysisAgent({
    description: 'Analyze a topic with real memory nodes',
    successCriteria: ['Produce a grounded analysis'],
    maxDuration: 1000,
  }, { models: {} }, logger);

  const stored = [];
  agent.memory = {
    query: async () => [{ id: 'n1', concept: 'existing node', tags: [] }],
    addNode: async (content, tag) => {
      stored.push({ content, tag });
      return { id: `node-${stored.length}` };
    },
    reinforceCooccurrence() {},
  };
  agent.getKnowledgeDomain = async () => ({ clusterId: 'c1', size: 1, nodes: [] });
  agent.getKnowledgeClusters = async () => new Map();
  agent.getStrategicContext = async () => null;
  agent.checkExistingKnowledge = async () => null;
  agent.checkAgentActivity = async () => null;
  agent.frameAnalysisProblem = async () => ({
    coreQuestion: 'What matters here?',
    keyAspects: ['aspect 1'],
    analysisApproach: 'systematic',
  });
  agent.analyzePerspective = async (fw) => `Perspective analysis for ${fw}`;
  agent.synthesizePerspectives = async () => ({
    summary: 'Grounded synthesis summary.',
    keyInsights: ['Insight one', 'Insight two'],
    mostNovel: 'Novel finding',
  });
  agent.identifyImplications = async () => ['Implication one', 'Implication two'];

  const result = await agent.execute();

  assert.equal(result.success, true);
  assert.equal(result.perspectivesAnalyzed, 3);
  assert.equal(result.insightsGenerated, 2);
  assert.equal(result.implicationsIdentified, 2);
  assert.equal(stored.filter((s) => s.tag === 'analysis_insight').length, 2);
  assert.equal(stored.filter((s) => s.tag === 'novel_implication').length, 2);
});

// No confirmed caller path sets these mission flags for 'analysis' missions
// today (see the Step 1 report), but the escape hatch mirrors
// SynthesisAgent.allowsZeroEvidenceSynthesis() so a future explicitly-
// requested ungrounded analysis is not eaten by the gate.
test('an explicitly-requested (allowZeroEvidence) analysis is not eaten by the gate', async () => {
  const agent = new AnalysisAgent({
    description: 'Reason from first principles about a hypothetical with no prior knowledge',
    successCriteria: ['Explore the hypothetical'],
    metadata: { allowZeroEvidence: true },
    maxDuration: 1000,
  }, { models: {} }, logger);

  const stored = [];
  agent.memory = {
    query: async () => [],
    addNode: async (content, tag) => {
      stored.push({ content, tag });
      return { id: `node-${stored.length}` };
    },
    reinforceCooccurrence() {},
  };
  agent.getKnowledgeDomain = async () => ({ clusterId: null, size: 0, nodes: [] });
  agent.getKnowledgeClusters = async () => new Map();
  agent.getStrategicContext = async () => null;
  agent.checkExistingKnowledge = async () => null;
  agent.checkAgentActivity = async () => null;
  agent.frameAnalysisProblem = async () => ({
    coreQuestion: 'What follows from the hypothetical?',
    keyAspects: ['aspect 1'],
    analysisApproach: 'systematic',
  });
  agent.analyzePerspective = async (fw) => `Perspective analysis for ${fw}`;
  agent.synthesizePerspectives = async () => ({
    summary: 'Explicit ungrounded synthesis summary.',
    keyInsights: ['Insight one'],
    mostNovel: 'Novel finding',
  });
  agent.identifyImplications = async () => ['Implication one'];

  const result = await agent.execute();

  assert.equal(result.success, true);
  assert.equal(result.perspectivesAnalyzed, 3);
  assert.equal(stored.filter((s) => s.tag === 'analysis_insight').length, 1);
});
