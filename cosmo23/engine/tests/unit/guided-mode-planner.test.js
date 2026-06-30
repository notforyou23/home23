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

  it('adds research contracts to source-required normalized missions', () => {
    const planner = createPlanner();

    const normalized = planner.normalizePlan(
      {
        strategy: 'Recover anecdotes',
        agentMissions: [
          {
            type: 'research',
            mission: 'Run web_search for "Legion of Mary Keystone fan recollections" and save source_url fields.',
            tools: ['web_search'],
            expectedOutput: '@outputs/raw-anecdotes/web-search-results.json'
          }
        ],
        deliverable: {
          type: 'markdown',
          filename: 'out.md',
          location: '@outputs/'
        }
      },
      { domain: 'Jerry side project anecdotes' },
      { researchDigest: planner.buildResearchDigest({}) }
    );

    const contract = normalized.agentMissions[0].metadata.researchContract;
    expect(contract.required).to.equal(true);
    expect(contract.mode).to.equal('web_research');
    expect(contract.requiredQueries).to.deep.equal(['Legion of Mary Keystone fan recollections']);
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

  it('uses a local continuation fallback instead of broad web research when prior context exists', async () => {
    const planner = createPlanner({
      subsystems: {
        client: {
          generate: async () => ({ content: 'not valid json' })
        }
      }
    });

    const plan = await planner.generateMissionPlan(
      {
        domain: 'Now Apply the substrate pressure-test criterion as a verdict',
        context: 'Use the reference outputs as necessary.'
      },
      { mcp: { tools: [] }, webSearch: true, codeExecution: false, agentTypes: ['research', 'ide'] },
      [],
      [],
      {
        hasContext: true,
        researchDigest: {
          topFindings: ['The graph supports retrieve-and-fill as a spine candidate.'],
          priorityGaps: ['Produce the final verdict table.'],
          artifactRefs: [{ path: '@outputs/pressure_test_artifact_manifest.json', label: 'manifest' }],
          processedSourceUrls: []
        },
        knowledgeAssessment: {
          answer: 'The brain already has local artifacts for the verdict; no broad source collection is needed.'
        }
      }
    );

    expect(plan.agentMissions).to.have.length(3);
    expect(plan.agentMissions.map(m => m.type)).to.deep.equal(['ide', 'ide', 'ide']);
    expect(plan.agentMissions.map(m => m.mission).join('\n')).to.not.include('Conduct comprehensive web research');
    expect(plan.agentMissions.map(m => m.tools || [])).to.deep.equal([['read_file', 'write_file'], ['read_file', 'write_file'], ['read_file', 'write_file']]);
    expect(plan.deliverable.filename).to.equal('guided_continuation_output.md');
  });

  it('rewrites generated web missions when the planning decision says local only', async () => {
    const planner = createPlanner({
      subsystems: {
        client: {
          generate: async () => ({
            content: JSON.stringify({
              strategy: 'bad web plan',
              requiredResources: ['web_search'],
              agentMissions: [
                {
                  type: 'research',
                  mission: 'Use web_search to conduct broad research on the thread.',
                  tools: ['web_search'],
                  priority: 'high',
                  expectedOutput: '@outputs/research.json'
                }
              ],
              initialGoals: ['collect sources']
            })
          })
        }
      }
    });

    const plan = await planner.generateMissionPlan(
      {
        domain: 'Substrate pressure-test spine verdict',
        context: 'Use the existing local artifacts only.'
      },
      { mcp: { tools: [] }, webSearch: true, codeExecution: false, agentTypes: ['research', 'ide'] },
      [],
      [],
      {
        hasContext: true,
        planningDecision: {
          threadRelation: 'refinement',
          evidenceMode: 'local_sufficient',
          webPolicy: 'none',
          rationale: 'local artifacts are sufficient',
          localArtifactCount: 3,
          externalGaps: []
        },
        researchDigest: {
          topFindings: ['prior finding'],
          priorityGaps: [],
          artifactRefs: [{ path: '@outputs/manifest.json', label: 'manifest' }],
          processedSourceUrls: []
        }
      }
    );

    expect(plan.requiredResources).to.not.include('web_search');
    expect(plan.agentMissions[0].type).to.equal('ide');
    expect(plan.agentMissions[0].tools).to.deep.equal(['read_file', 'write_file']);
    expect(plan.agentMissions[0].metadata.policyRewrite).to.equal('web_disallowed_by_planning_decision');
  });

  it('uses targeted web fallback only for explicit external evidence gaps', async () => {
    const planner = createPlanner({
      subsystems: {
        client: {
          generate: async () => ({ content: 'not valid json' })
        }
      }
    });

    const plan = await planner.generateMissionPlan(
      {
        domain: 'Thread Domain',
        context: 'Continue from current artifacts.'
      },
      { mcp: { tools: [] }, webSearch: true, codeExecution: false, agentTypes: ['research', 'ide'] },
      [],
      [],
      {
        hasContext: true,
        planningDecision: {
          threadRelation: 'refinement',
          evidenceMode: 'mixed',
          webPolicy: 'targeted',
          rationale: 'one external gap remains',
          localArtifactCount: 4,
          externalGaps: ['Missing primary source citation for claim A']
        },
        researchDigest: {
          topFindings: ['local finding'],
          priorityGaps: ['Missing primary source citation for claim A'],
          artifactRefs: [{ path: '@outputs/local.json', label: 'local' }],
          processedSourceUrls: []
        }
      }
    );

    expect(plan.agentMissions).to.have.length(2);
    expect(plan.agentMissions[0].type).to.equal('research');
    expect(plan.agentMissions[0].mission).to.include('targeted evidence gap');
    expect(plan.agentMissions[0].mission).to.not.include('Conduct comprehensive web research');
    expect(plan.agentMissions[1].type).to.equal('ide');
  });

  it('does not treat avoiding primary sources as a no-web request', () => {
    const planner = createPlanner();
    const decision = planner.buildPlanningDecision(
      {
        domain: 'very garcia side project anecdotes',
        context: 'find anecdotes specifically from fans or quotes from interviews. Avoid all primary sources - search secondary and forums, etc. for anecdotes on specific Jerry Garcia side project shows'
      },
      { webSearch: true },
      {}
    );

    expect(decision.noWebRequested).to.equal(false);
    expect(decision.webPolicy).to.not.equal('none');
    expect(decision.externalGaps.join('\n')).to.include('search secondary and forums');
  });

  it('fallback planning honors secondary/forum source preference instead of primary-source defaults', async () => {
    const planner = createPlanner({
      subsystems: {
        client: {
          generate: async () => ({ content: 'not valid json' })
        }
      }
    });

    const plan = await planner.generateMissionPlan(
      {
        domain: 'very garcia side project anecdotes',
        context: 'find anecdotes specifically from fans or quotes from interviews. Avoid all primary sources - search secondary and forums, etc. for anecdotes on specific Jerry Garcia side project shows'
      },
      { mcp: { tools: [] }, webSearch: true, codeExecution: false, agentTypes: ['research', 'ide'] },
      [],
      [],
      { hasContext: false, researchDigest: planner.buildResearchDigest({}) }
    );

    expect(plan.agentMissions[0].type).to.equal('research');
    expect(plan.agentMissions[0].tools).to.include('web_search');
    expect(plan.agentMissions.map(m => m.mission).join('\n')).to.include('secondary');
    expect(plan.agentMissions.map(m => m.mission).join('\n')).to.include('forums');
    expect(plan.agentMissions.map(m => m.sourceScope || '').join('\n')).to.not.include('primary external sources');
  });

  it('selects no-web planning decision for continuation with local artifacts', () => {
    const planner = createPlanner();
    const decision = planner.buildPlanningDecision(
      { domain: 'Thread Domain', context: 'Use the existing local artifacts to produce the verdict.' },
      { webSearch: true },
      {
        hasContext: true,
        researchDigest: {
          topFindings: ['finding'],
          completedMissions: ['prior mission'],
          priorityGaps: ['write verdict'],
          artifactRefs: [{ path: '@outputs/a.json' }],
          processedSourceUrls: []
        }
      }
    );

    expect(decision.evidenceMode).to.equal('local_sufficient');
    expect(decision.webPolicy).to.equal('none');
  });
});
