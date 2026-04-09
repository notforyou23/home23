const { expect } = require('chai');

const { GuidedModePlanner } = require('../../src/core/guided-mode-planner');

function createPlanner(overrides = {}) {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  const config = {
    logsDir: '/tmp/cosmo-guided-planner-test',
    architecture: {
      roleSystem: {
        explorationMode: 'guided',
        guidedFocus: {
          domain: 'JGB Health expansion',
          context: 'Continue the investigation and close the evidence gaps',
          executionMode: 'mixed',
          depth: 'deep'
        }
      }
    },
    coordinator: {
      agentTypeWeights: {
        research: 1,
        ide: 1
      }
    },
    ideFirst: { enabled: true },
    models: {},
    mcp: { client: { enabled: false, servers: [] } },
    ...overrides.config
  };

  const subsystems = {
    client: {
      generate: async () => ({ content: '{"strategy":"plan","agentMissions":[],"initialGoals":[]}' })
    },
    memory: {
      query: async () => [],
      nodes: new Map()
    },
    goals: {
      getGoals: () => []
    },
    clusterStateStore: {
      getPlan: async () => null,
      listTasks: async () => [],
      listMilestones: async () => []
    },
    agentExecutor: {
      registry: { getActiveCount: () => 0 },
      resultsQueue: { queue: [], history: [], processed: [] }
    },
    ...overrides.subsystems
  };

  return new GuidedModePlanner(config, subsystems, logger);
}

describe('GuidedModePlanner', () => {
  it('switches planning prompts into continuation mode when prior context exists', () => {
    const planner = createPlanner();
    const prompt = planner.buildPlanningPrompt(
      { domain: 'Thread Domain', context: 'Thread Context', depth: 'deep' },
      { mcp: { tools: [] }, webSearch: true, codeExecution: false, agentTypes: ['research', 'ide'] },
      [],
      [],
      {
        hasContext: true,
        threadAnchor: { title: 'Existing Thread' },
        completedTasks: [{ summary: 'Completed prior source collection' }],
        reviewGaps: ['Missing corroboration for payer partnerships'],
        recentFindings: ['Initial expansion claims are under-sourced'],
        processedSourceUrls: ['https://example.com/source-1']
      }
    );

    expect(prompt).to.include('Advance the existing research thread without repeating completed work');
    expect(prompt).to.include('"sourceScope"');
    expect(prompt).to.include('"artifactInputs"');
  });

  it('normalizes planner missions with coordination metadata and digest context', () => {
    const planner = createPlanner();
    const digest = {
      topFindings: ['Finding A'],
      artifactRefs: [{ path: '/tmp/finding.json', label: 'finding.json' }],
      priorityGaps: ['Gap A'],
      processedSourceUrls: ['https://example.com/a']
    };

    const normalized = planner.normalizePlan(
      {
        strategy: 'Continue the investigation',
        agentMissions: [
          {
            type: 'research',
            mission: 'Collect the missing evidence',
            priority: 'high'
          }
        ],
        deliverable: {
          type: 'markdown',
          filename: 'out.md',
          location: '@outputs/'
        }
      },
      { domain: 'Thread Domain' },
      { researchDigest: digest }
    );

    expect(normalized.agentMissions[0].metadata.guidedMission).to.equal(true);
    expect(normalized.agentMissions[0].metadata.researchDigest.topFindings).to.deep.equal(['Finding A']);
    expect(normalized.agentMissions[0].sourceScope).to.be.a('string');
    expect(normalized.agentMissions[0].artifactInputs).to.be.an('array');
  });

  it('falls through to domain-based defaults when planner output is not valid JSON', async () => {
    const planner = createPlanner({
      subsystems: {
        client: {
          generate: async () => ({ content: 'not valid json' })
        }
      }
    });

    // With the three-tier cascade, invalid JSON from both tiers falls through
    // to Tier 3 domain-based defaults — it should never throw, always produce a plan
    const plan = await planner.generateMissionPlan(
      { domain: 'Thread Domain', context: 'Thread Context' },
      { mcp: { tools: [] }, webSearch: true, codeExecution: false, agentTypes: ['research', 'ide'] },
      [],
      [],
      { hasContext: false, researchDigest: planner.buildResearchDigest({}) }
    );

    // Tier 3 should have generated domain-based defaults
    expect(plan.agentMissions).to.be.an('array');
    expect(plan.agentMissions.length).to.be.at.least(2);
    expect(plan.strategy).to.include('Thread Domain');
  });
});
