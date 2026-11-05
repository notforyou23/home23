import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SynthesisAgent } = require('../../../engine/src/agents/synthesis-agent.js');
const { ResearchAgent } = require('../../../engine/src/agents/research-agent.js');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test('SynthesisAgent refuses to generate a report with zero evidence nodes', async () => {
  const agent = new SynthesisAgent({
    description: 'Summarize the state of an empty corpus',
    successCriteria: ['Produce a grounded summary'],
    metadata: { requireEvidence: true },
    maxDuration: 1000,
  }, { models: {} }, logger);

  agent.memory = { query: async () => [] };
  agent.checkExistingKnowledge = async () => null;
  agent.getStrategicContext = async () => null;
  agent.checkAgentActivity = async () => null;
  agent.createSynthesisStructure = async () => {
    throw new Error('should not structure zero-evidence synthesis');
  };

  const result = await agent.execute();

  assert.equal(result.success, false);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.reason, 'zero_evidence');
  assert.equal(result.metadata.sourcesConsulted, 0);
  assert.equal(agent.results[0].status, 'needs_input');
});

test('ResearchAgent refuses to verify claims when searches return no source URLs', async () => {
  const agent = new ResearchAgent({
    description: 'Verify the claim that a current event happened',
    successCriteria: ['Find source-backed facts'],
    metadata: { claimText: 'A current event happened and must be checked against sources.' },
    maxDuration: 1000,
  }, { models: { enableWebSearch: true }, providers: {} }, logger);

  agent.memory = { query: async () => [] };
  agent.exploreMemoryConnections = async () => [];
  agent.getHotTopics = async () => [];
  agent.checkExistingKnowledge = async () => null;
  agent.generateResearchQueries = async () => ['current topic'];
  agent.performWebSearch = async () => 'No web results found for "current topic".';
  agent.synthesizeFindings = async () => {
    throw new Error('should not synthesize zero-source research');
  };

  const result = await agent.execute();

  assert.equal(result.success, false);
  assert.equal(result.status, 'needs_evidence');
  assert.equal(result.reason, 'zero_sources');
  assert.equal(result.metadata.sourcesFound, 0);
  assert.equal(agent.results[0].status, 'needs_evidence');
});

test('ResearchAgent refuses model-prior fallback for verification when all searches fail', async () => {
  const agent = new ResearchAgent({
    description: 'Verify whether another current claim is true',
    successCriteria: ['Find source-backed facts'],
    metadata: { claimText: 'Another current claim must be checked against sources.' },
    maxDuration: 1000,
  }, { models: { enableWebSearch: true }, providers: {} }, logger);

  agent.memory = { query: async () => [] };
  agent.exploreMemoryConnections = async () => [];
  agent.getHotTopics = async () => [];
  agent.checkExistingKnowledge = async () => null;
  agent.generateResearchQueries = async () => ['another current topic'];
  agent.performWebSearch = async () => {
    throw new Error('search unavailable');
  };
  agent.generateKnowledgeBasedResearch = async () => {
    throw new Error('should not use model-prior fallback by default');
  };

  const result = await agent.execute();

  assert.equal(result.success, false);
  assert.equal(result.status, 'needs_evidence');
  assert.equal(result.reason, 'all_searches_failed');
  assert.equal(result.metadata.sourcesFound, 0);
});

test('ResearchAgent can still produce exploratory uncertified drafts with zero sources', async () => {
  const agent = new ResearchAgent({
    description: 'Research a broad background topic',
    successCriteria: ['Produce a useful exploratory briefing'],
    maxDuration: 1000,
  }, { models: { enableWebSearch: true }, providers: {}, logsDir: '/tmp/home23-test-logs' }, logger);

  const stored = [];
  agent.memory = {
    query: async () => [],
    addNode: async (content, tag) => {
      stored.push({ content, tag });
      return { id: `node-${stored.length}` };
    },
    reinforceCooccurrence() {},
  };
  agent.exploreMemoryConnections = async () => [];
  agent.getHotTopics = async () => [];
  agent.checkExistingKnowledge = async () => null;
  agent.generateResearchQueries = async () => ['background topic'];
  agent.performWebSearch = async () => 'No web results found for "background topic".';
  agent.synthesizeFindings = async () => ({
    summary: 'Uncertified background briefing.',
    findings: ['Background concept draft, not source-backed.'],
    successAssessment: 'Useful as a draft only.',
  });
  agent.identifyFollowUp = async () => [];
  agent.exportResearchCorpus = async () => {};

  const result = await agent.execute();

  assert.equal(result.success, true);
  assert.equal(result.metadata.status, 'uncertified_draft');
  assert.equal(result.metadata.groundingStrength, 'uncertified');
  assert.equal(stored[0].tag, 'research_uncertified');
});
