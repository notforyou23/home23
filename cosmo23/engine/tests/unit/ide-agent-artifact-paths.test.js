const { expect } = require('chai');

const { IDEAgent } = require('../../src/agents/ide-agent');

describe('IDEAgent artifact path prompting', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  it('prefers workspace-relative outputs paths over bare labels', () => {
    const agent = new IDEAgent(
      {
        goalId: 'goal-1',
        description: 'Assemble the research report',
        successCriteria: [],
        metadata: {
          artifactInputs: [
            {
              label: 'research_findings.json',
              path: 'research/agent_1/research_findings.json'
            }
          ],
          researchDigest: {
            artifactRefs: [
              {
                label: 'research_summary.md',
                path: 'research/agent_1/research_summary.md'
              }
            ]
          }
        }
      },
      {},
      logger
    );

    const prompt = agent.buildContextPrompt([], [], null, null, null);

    expect(agent.formatArtifactReferenceForPrompt({
      label: 'sources.json',
      path: 'research/agent_1/sources.json'
    })).to.equal('outputs/research/agent_1/sources.json');
    expect(prompt).to.include('outputs/research/agent_1/research_findings.json');
    expect(prompt).to.include('outputs/research/agent_1/research_summary.md');
    expect(prompt).to.not.include('\n- research_findings.json\n');
    expect(prompt).to.not.include('\n- research_summary.md\n');
  });
});
