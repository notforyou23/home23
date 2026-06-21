const { expect } = require('chai');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const { ResearchAgent } = require('../../src/agents/research-agent');

describe('ResearchAgent handoff generation', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  it('emits a structured handoff with artifact refs, findings, and follow-up goals', () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-1',
        description: 'Research payer network expansion',
        successCriteria: []
      },
      { ideFirst: { enabled: true } },
      logger
    );

    agent.lastSynthesis = {
      summary: 'Summary of findings',
      findings: ['Finding 1', 'Finding 2', 'Finding 3']
    };
    agent.exportedFiles = [
      {
        filename: 'research_findings.json',
        path: '/tmp/research_findings.json',
        relativePath: '@outputs/research_findings.json',
        size: 128
      },
      {
        filename: 'sources.json',
        path: '/tmp/sources.json',
        relativePath: '@outputs/sources.json',
        size: 96
      }
    ];
    agent.followUpDirections = ['Validate payer contract timelines'];
    agent.sourcesFound = ['https://example.com/source-a', 'https://example.com/source-b'];

    const handoff = agent.generateHandoffSpec();

    expect(handoff).to.exist;
    expect(handoff.type).to.equal('HANDOFF');
    expect(handoff.toAgentType).to.equal('ide');
    expect(handoff.artifactRefs).to.have.length(2);
    expect(handoff.artifactRefs[0].relativePath).to.equal('@outputs/research_findings.json');
    expect(handoff.sourceRefs.map(item => item.label)).to.include('sources.json');
    expect(handoff.topFindings).to.deep.equal(['Finding 1', 'Finding 2', 'Finding 3']);
    expect(handoff.followUpGoals).to.deep.equal(['Validate payer contract timelines']);
    expect(handoff.sourceUrls).to.deep.equal(['https://example.com/source-a', 'https://example.com/source-b']);
  });

  it('fails closed when a source-required mission has no successful web searches', async () => {
    const agent = new ResearchAgent(
      {
        goalId: 'goal-source-required',
        description: 'Recover fan anecdotes from forums. For each result, record source_url, source_type, author, and anecdote_text.',
        successCriteria: ['Every finding must include a source_url']
      },
      {
        models: { enableWebSearch: true },
        providers: { 'ollama-cloud': { enabled: true } }
      },
      logger
    );

    agent.gatherPreFlightContext = async () => ({});
    agent.memory = { query: async () => [] };
    agent.exploreMemoryConnections = async () => [];
    agent.getHotTopics = async () => [];
    agent.checkExistingKnowledge = async () => ({ hasKnowledge: false });
    agent.generateResearchQueries = async () => [
      'site:archive.org "Legion of Mary" "Boarding House" 1975',
      'site:reddit.com/r/gratefuldead "Legion of Mary" 1975'
    ];
    agent.performWebSearch = async (query) => {
      throw new Error(`400 invalid_request_error for ${query}`);
    };
    agent.generateKnowledgeBasedResearch = async () => {
      throw new Error('knowledge fallback should not be used for source-required missions');
    };
    agent.reportProgress = async () => {};

    const result = await agent.execute();

    expect(result.success).to.equal(false);
    expect(result.status).to.equal('blocked_search_failed');
    expect(result.queriesAttempted).to.equal(2);
    expect(result.searchFailures).to.have.length(2);
  });
});
