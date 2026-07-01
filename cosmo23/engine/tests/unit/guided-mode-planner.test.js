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

  it('extracts explicit phase expected output paths into machine-readable contracts', () => {
    const planner = createPlanner();

    const phases = planner.parseExplicitPhases(`
PHASE 1 - Scrape Archive.org Reviews:
Fetch Archive.org metadata for two known identifiers.
Required expectedOutput: @outputs/raw-anecdotes/archive-org-comments.json.

PHASE 2 - Validate Route Receipts:
Read the raw anecdotes file.
Write to outputs/validation/archive-org-comments-validation.json.
`);

    expect(phases).to.have.length(2);
    expect(phases[0].expectedOutput).to.equal('@outputs/raw-anecdotes/archive-org-comments.json');
    expect(phases[0].deliverables).to.deep.equal(['@outputs/raw-anecdotes/archive-org-comments.json']);
    expect(phases[1].expectedOutput).to.equal('@outputs/validation/archive-org-comments-validation.json');
  });

  it('parses explicit phase headers without trailing colons', () => {
    const planner = createPlanner();

    const phases = planner.parseExplicitPhases(`
PHASE 1 - Archive.org review acquisition
Use archive.metadata and archive.reviews.
Expected output: @outputs/raw-anecdotes/archive-org-comments.json

PHASE 2 - Final evidence-backed synthesis
Read the raw JSON.
Expected output: @outputs/jerry-side-project-anecdotes.md
`);

    expect(phases).to.have.length(2);
    expect(phases[0].name).to.equal('Archive.org review acquisition');
    expect(phases[0].expectedOutput).to.equal('@outputs/raw-anecdotes/archive-org-comments.json');
    expect(phases[1].name).to.equal('Final evidence-backed synthesis');
    expect(phases[1].expectedOutput).to.equal('@outputs/jerry-side-project-anecdotes.md');
  });

  it('preserves all explicit phases even when later phases read prior outputs', () => {
    const planner = createPlanner();

    const phases = planner.parseTaskPhases(`
PHASE 1 - Research Archive.org Reviews:
Use typed source provider acquisition, specifically archive.metadata and archive.reviews. Required expectedOutput: @outputs/raw-anecdotes/archive-org-comments.json.

PHASE 2 - Validate Route Receipts:
Read @outputs/raw-anecdotes/archive-org-comments.json. Required expectedOutput: @outputs/validation/archive-org-comments-validation.json.

PHASE 3 - Synthesize Final Report:
Read @outputs/raw-anecdotes/archive-org-comments.json and @outputs/validation/archive-org-comments-validation.json. Required expectedOutput: @outputs/final/archive-org-comments-report.md.
`);

    expect(phases.map(phase => phase.name)).to.deep.equal([
      'Research Archive.org Reviews',
      'Validate Route Receipts',
      'Synthesize Final Report'
    ]);
    expect(phases[1].expectedOutput).to.equal('@outputs/validation/archive-org-comments-validation.json');
    expect(phases[2].expectedOutput).to.equal('@outputs/final/archive-org-comments-report.md');
    expect(phases[2].dependencies).to.include('phase_2');
  });

  it('lets explicit phase output paths override missing or wrong planner mission outputs', () => {
    const planner = createPlanner();
    const taskPhases = planner.parseExplicitPhases(`
PHASE 1 - Scrape Archive.org Reviews:
Fetch Archive.org metadata for two known identifiers.
Required expectedOutput: @outputs/raw-anecdotes/archive-org-comments.json.
`);

    const normalized = planner.normalizePlan(
      {
        strategy: 'Fetch reviews',
        agentMissions: [
          {
            type: 'dataacquisition',
            mission: 'Fetch Archive.org reviews and save the records.',
            expectedOutput: '@outputs/wrong-file.json',
            metadata: { expectedOutput: '@outputs/wrong-metadata.json' }
          }
        ],
        deliverable: {
          type: 'json',
          filename: 'archive-org-comments.json',
          location: '@outputs/raw-anecdotes/'
        }
      },
      { domain: 'Archive.org acceptance' },
      { researchDigest: planner.buildResearchDigest({}), taskPhases }
    );

    expect(normalized.agentMissions[0].expectedOutput).to.equal('@outputs/raw-anecdotes/archive-org-comments.json');
    expect(normalized.agentMissions[0].metadata.expectedOutput).to.equal('@outputs/raw-anecdotes/archive-org-comments.json');
    expect(normalized.agentMissions[0].metadata.researchContract.required).to.equal(true);
  });

  it('uses explicit source phases as fresh executable research missions, not stale continuation templates', () => {
    const planner = createPlanner();
    const taskPhases = planner.parseTaskPhases(`
PHASE 1 - Research Archive.org Reviews:
Use typed source provider acquisition, specifically archive.metadata and archive.reviews, for identifiers: legion-of-mary-the-bottom-line-nyc-1975, legion-of-mary-oriental-theatre-wi-1975-wzmf. Required expectedOutput: @outputs/raw-anecdotes/archive-org-comments.json.
`);

    const decision = planner.buildPlanningDecision(
      { domain: 'Archive.org acceptance', context: taskPhases[0].rawText },
      { webSearch: true },
      { hasContext: true, threadAnchor: { title: 'Stale thread' }, taskPhases }
    );
    const normalized = planner.normalizePlan(
      {
        strategy: 'Stale local continuation',
        agentMissions: [
          {
            type: 'document_analysis',
            mission: 'Read local outputs only and write guided_continuation_inventory.json.',
            expectedOutput: '@outputs/guided_continuation_inventory.json',
            metadata: { expectedOutput: '@outputs/guided_continuation_inventory.json' }
          }
        ]
      },
      { domain: 'Archive.org acceptance', context: taskPhases[0].rawText },
      { researchDigest: planner.buildResearchDigest({}), taskPhases, planningDecision: decision }
    );

    expect(decision.webPolicy).to.equal('targeted');
    expect(decision.threadRelation).to.equal('fresh');
    expect(normalized.agentMissions[0].type).to.equal('research');
    expect(normalized.agentMissions[0].mission).to.include('archive.metadata');
    expect(normalized.agentMissions[0].mission).to.not.include('guided_continuation_inventory');
    expect(normalized.agentMissions[0].expectedOutput).to.equal('@outputs/raw-anecdotes/archive-org-comments.json');
    expect(normalized.agentMissions[0].metadata.researchContract.sourceProviderHints).to.include.members([
      'archive.metadata',
      'archive.reviews'
    ]);
  });

  it('persists explicit phase output contracts onto guided tasks when planner output omits them', async () => {
    const storedTasks = [];
    const explicitContext = `
PHASE 1 - Scrape Archive.org Reviews:
Fetch Archive.org metadata for two known identifiers.
Required expectedOutput: @outputs/raw-anecdotes/archive-org-comments.json.
`;
    const planner = createPlanner({
      config: {
        models: { enableWebSearch: true },
        architecture: {
          roleSystem: {
            explorationMode: 'guided',
            guidedFocus: {
              domain: 'Archive.org acceptance',
              context: explicitContext,
              executionMode: 'strict',
              depth: 'normal'
            }
          }
        }
      },
      subsystems: {
        client: {
          generate: async () => ({
            content: JSON.stringify({
              strategy: 'Fetch reviews',
              agentMissions: [
                {
                  type: 'dataacquisition',
                  mission: 'Fetch Archive.org reviews and save the records.',
                  tools: ['curl'],
                  priority: 'high'
                }
              ],
              initialGoals: ['Fetch the records']
            })
          })
        },
        clusterStateStore: {
          getPlan: async () => null,
          listTasks: async () => [],
          listMilestones: async () => [],
          createPlan: async () => {},
          upsertMilestone: async () => {},
          upsertTask: async (task) => storedTasks.push(task)
        }
      }
    });

    planner.assessKnowledgeState = async () => null;
    planner.buildPlanningContext = async () => ({ hasContext: false, researchDigest: planner.buildResearchDigest({}) });
    planner.persistPlanningDecision = async () => null;
    planner.clearPlanningFailure = async () => null;

    const plan = await planner.planMission({ forceNew: true });

    expect(plan.agentMissions[0].expectedOutput).to.equal('@outputs/raw-anecdotes/archive-org-comments.json');
    expect(storedTasks).to.have.length(1);
    expect(storedTasks[0].metadata.expectedOutput).to.equal('@outputs/raw-anecdotes/archive-org-comments.json');
    expect(storedTasks[0].metadata.researchContract.required).to.equal(true);
  });

  it('does not persist a generic synthesis task when an explicit final markdown phase exists', async () => {
    const storedTasks = [];
    const explicitContext = `
PHASE 1 - Research Archive.org Reviews:
Use typed source provider acquisition, specifically archive.metadata and archive.reviews, for identifiers: legion-of-mary-the-bottom-line-nyc-1975. Required expectedOutput: @outputs/raw-anecdotes/archive-org-comments.json.

PHASE 2 - Validate Route Receipts:
Read @outputs/raw-anecdotes/archive-org-comments.json. Required expectedOutput: @outputs/validation/archive-org-comments-validation.json. Validate that JSON parses and route_receipts.attempts includes archive.metadata and archive.reviews. Write JSON with problems:[] if valid.

PHASE 3 - Synthesize Final Report:
Read @outputs/raw-anecdotes/archive-org-comments.json and @outputs/validation/archive-org-comments-validation.json. Required expectedOutput: @outputs/final/archive-org-comments-report.md. Write markdown grounded only in the artifacts.
`;
    const planner = createPlanner({
      config: {
        models: { enableWebSearch: true },
        architecture: {
          roleSystem: {
            explorationMode: 'guided',
            guidedFocus: {
              domain: 'Archive.org acceptance',
              context: explicitContext,
              executionMode: 'strict',
              depth: 'normal'
            }
          }
        }
      },
      subsystems: {
        client: {
          generate: async () => ({
            content: JSON.stringify({
              strategy: 'Fetch, validate, and report from Archive.org reviews',
              agentMissions: [
                { type: 'research', mission: 'Fetch Archive.org reviews and save records.' },
                { type: 'research', mission: 'Validate archive.metadata and archive.reviews receipts.' },
                { type: 'document_analysis', mission: 'Write the final markdown report.' }
              ],
              deliverable: {
                type: 'markdown',
                filename: 'archive-org-comments-report.md',
                location: '@outputs/final/',
                requiredSections: ['raw extraction', 'validation', 'final synthesis'],
                minimumContent: 'assemble and synthesize all phase outputs'
              },
              initialGoals: ['Fetch records', 'Validate receipts', 'Write report']
            })
          })
        },
        clusterStateStore: {
          getPlan: async () => null,
          getTask: async () => null,
          listTasks: async () => [],
          listMilestones: async () => [],
          createPlan: async () => {},
          upsertMilestone: async () => {},
          upsertTask: async (task) => storedTasks.push(task)
        }
      }
    });

    planner.assessKnowledgeState = async () => null;
    planner.buildPlanningContext = async () => ({ hasContext: false, researchDigest: planner.buildResearchDigest({}) });
    planner.persistPlanningDecision = async () => null;
    planner.clearPlanningFailure = async () => null;

    const plan = await planner.planMission({ forceNew: true });

    expect(plan.agentMissions.map(mission => mission.expectedOutput)).to.deep.equal([
      '@outputs/raw-anecdotes/archive-org-comments.json',
      '@outputs/validation/archive-org-comments-validation.json',
      '@outputs/final/archive-org-comments-report.md'
    ]);
    expect(storedTasks.map(task => task.id)).to.deep.equal([
      'task:phase1',
      'task:phase2',
      'task:phase3'
    ]);
    expect(storedTasks.some(task => task.id === 'task:synthesis_final')).to.equal(false);
    expect(storedTasks[1].metadata.agentType).to.equal('ide');
    expect(storedTasks[1].metadata.researchContract.required).to.equal(false);
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

  it('does not count zero-node PGS assessment prose as usable local context', () => {
    const planner = createPlanner();
    const decision = planner.buildPlanningDecision(
      {
        domain: 'Jerry Garcia side project anecdotes',
        context: 'Search secondary sources, forums, Reddit, fan recollections, and interview quotes for anecdotes.'
      },
      { webSearch: true },
      {
        hasContext: false,
        threadAnchor: null,
        researchDigest: {
          topFindings: [],
          completedMissions: [],
          artifactRefs: [],
          priorityGaps: []
        },
        knowledgeAssessment: {
          answer: 'No local graph nodes were available for this topic.',
          data: {
            nodeCount: 0,
            partitionsSwept: 0
          }
        }
      }
    );

    expect(decision.localArtifactCount).to.equal(0);
    expect(decision.hasUsableLocalContext).to.equal(false);
    expect(decision.threadRelation).to.equal('fresh');
    expect(decision.webPolicy).to.equal('targeted');
  });

  it('does not spawn initial tier missions whose persisted task dependencies are unmet', async () => {
    const tasks = new Map([
      ['task:phase1', { id: 'task:phase1', state: 'PENDING', deps: [], metadata: {} }],
      ['task:phase2', { id: 'task:phase2', state: 'PENDING', deps: ['task:phase1'], assignedAgentId: null, metadata: {} }]
    ]);
    const spawned = [];
    let pendingTiers = null;
    const planner = createPlanner({
      subsystems: {
        clusterStateStore: {
          getTask: async (taskId) => tasks.get(taskId) || null,
          upsertTask: async (task) => tasks.set(task.id, task),
          set: async (key, value) => {
            if (key === 'pending_agent_tiers') pendingTiers = value;
          }
        },
        agentExecutor: {
          registry: { getActiveCount: () => 0 },
          spawnAgent: async (spec) => {
            spawned.push(spec);
            return 'agent-phase2';
          }
        }
      }
    });

    const agentIds = await planner.spawnInitialAgents({
      deliverable: { type: 'markdown', filename: 'out.md' },
      agentMissions: [
        { type: 'ide', mission: 'Compile local memory baseline', expectedOutput: '@outputs/memory.json' },
        { type: 'dataacquisition', mission: 'Scrape Reddit threads', expectedOutput: '@outputs/reddit.json' }
      ],
      researchDigest: planner.buildResearchDigest({})
    }, [
      { missionIdx: 0, goalId: 'goal-phase1' },
      { missionIdx: 1, goalId: 'goal-phase2' }
    ]);

    expect(agentIds).to.deep.equal([]);
    expect(spawned).to.have.length(0);
    expect(tasks.get('task:phase2').assignedAgentId).to.equal(null);
    expect(pendingTiers.tiers[0].missions.map(m => m.expectedOutput)).to.include('@outputs/reddit.json');
  });

  it('treats artifact validation phases as local work and does not add a generic final report agent', () => {
    const planner = createPlanner();
    const taskPhases = planner.parseTaskPhases(`
PHASE 1 - Research Archive.org Reviews:
Use typed source provider acquisition, specifically archive.metadata and archive.reviews, for identifiers: legion-of-mary-the-bottom-line-nyc-1975. Required expectedOutput: @outputs/raw-anecdotes/archive-org-comments.json.

PHASE 2 - Validate Route Receipts:
Read @outputs/raw-anecdotes/archive-org-comments.json. Required expectedOutput: @outputs/validation/archive-org-comments-validation.json. Validate that JSON parses and route_receipts.attempts includes archive.metadata and archive.reviews. Write JSON with problems:[] if valid.

PHASE 3 - Synthesize Final Report:
Read @outputs/raw-anecdotes/archive-org-comments.json and @outputs/validation/archive-org-comments-validation.json. Required expectedOutput: @outputs/final/archive-org-comments-report.md. Write markdown grounded only in the artifacts.
`);

    const normalized = planner.normalizePlan(
      {
        strategy: 'Archive acceptance',
        agentMissions: [
          { type: 'research', mission: 'acquire', expectedOutput: '@outputs/wrong-1.json' },
          { type: 'research', mission: 'validate with archive.metadata archive.reviews', expectedOutput: '@outputs/wrong-2.json' },
          { type: 'document_analysis', mission: 'synthesize', expectedOutput: '@outputs/wrong-3.md' }
        ],
        deliverable: { type: 'markdown', filename: 'guided_output.md', location: '@outputs/' }
      },
      { domain: 'Archive.org acceptance' },
      { researchDigest: planner.buildResearchDigest({}), taskPhases }
    );

    expect(normalized.agentMissions).to.have.length(3);
    expect(normalized.agentMissions[0].type).to.equal('research');
    expect(normalized.agentMissions[1].type).to.equal('ide');
    expect(normalized.agentMissions[1].metadata.researchContract.required).to.equal(false);
    expect(normalized.agentMissions[1].artifactInputs.map(input => input.path)).to.deep.equal([
      '@outputs/raw-anecdotes/archive-org-comments.json'
    ]);
    expect(normalized.agentMissions[2].type).to.equal('ide');
    expect(normalized.agentMissions[2].expectedOutput).to.equal('@outputs/final/archive-org-comments-report.md');
    expect(normalized.agentMissions.map(m => m.expectedOutput)).to.not.include('Complete markdown report document');
  });

  it('routes final artifact-only evidence reports to ide even when the planner proposes document_creation', () => {
    const planner = createPlanner();
    const taskPhases = planner.parseTaskPhases(`
PHASE 1 - Archive.org review acquisition
Use typed source provider acquisition, specifically archive.metadata and archive.reviews. Required expectedOutput: @outputs/raw-anecdotes/archive-org-comments.json.

PHASE 2 - Secondary fan/forum/social source acquisition
Use web_search for secondary sources. Required expectedOutput: @outputs/raw-anecdotes/forum-social-candidates.json.

PHASE 3 - Final evidence-backed synthesis
Read @outputs/raw-anecdotes/archive-org-comments.json and @outputs/raw-anecdotes/forum-social-candidates.json. Write a concise evidence-backed markdown report with confirmed extracted anecdotes, negative receipts, useful source routes, failed/empty routes, and next source families to pursue. Do not invent anecdotes. Required expectedOutput: @outputs/jerry-side-project-anecdotes.md.
`);

    const normalized = planner.normalizePlan(
      {
        strategy: 'Jerry side-project anecdotes',
        agentMissions: [
          { type: 'research', mission: 'archive', expectedOutput: '@outputs/raw-anecdotes/archive-org-comments.json' },
          { type: 'research', mission: 'secondary', expectedOutput: '@outputs/raw-anecdotes/forum-social-candidates.json' },
          { type: 'document_creation', mission: 'write final report', expectedOutput: '@outputs/wrong.md' }
        ],
        deliverable: { type: 'markdown', filename: 'guided_output.md', location: '@outputs/' }
      },
      { domain: 'Jerry Garcia side-project fan anecdotes' },
      { researchDigest: planner.buildResearchDigest({}), taskPhases }
    );

    expect(normalized.agentMissions).to.have.length(3);
    expect(normalized.agentMissions[2].type).to.equal('ide');
    expect(normalized.agentMissions[2].expectedOutput).to.equal('@outputs/jerry-side-project-anecdotes.md');
    expect(normalized.agentMissions[2].metadata.researchContract.required).to.equal(false);
    expect(normalized.agentMissions[2].artifactInputs.map(input => input.path)).to.deep.equal([
      '@outputs/raw-anecdotes/archive-org-comments.json',
      '@outputs/raw-anecdotes/forum-social-candidates.json'
    ]);
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
