const { expect } = require('chai');

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
});
