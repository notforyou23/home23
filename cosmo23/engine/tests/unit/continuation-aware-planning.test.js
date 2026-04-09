/**
 * Integration tests for Continuation-Aware Planning
 *
 * Verifies that context change detection, PGS knowledge assessment,
 * planning prompt injection, and MetaCoordinator assessment loading
 * work together as a coherent system.
 */
const { expect } = require('chai');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { GuidedModePlanner } = require('../../src/core/guided-mode-planner');

// ── Valid plan JSON for mock LLM responses ────────────────────────────────────

const VALID_PLAN_JSON = JSON.stringify({
  strategy: 'test plan',
  agentMissions: [
    { type: 'research', mission: 'Test mission', tools: ['web_search'], priority: 'high', expectedOutput: 'Report' }
  ],
  initialGoals: ['Test goal'],
  spawnAgents: false,
  successCriteria: ['Test criteria'],
  deliverable: { type: 'markdown', filename: 'test.md', location: '@outputs/' }
});

// ── Shared helpers ───────────────────────────────────────────────────────────

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
}

function capturingLogger() {
  const logs = [];
  return {
    logs,
    info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
    debug: (msg, meta) => logs.push({ level: 'debug', msg, meta })
  };
}

function baseConfig(overrides = {}) {
  return {
    logsDir: '/tmp/cosmo-continuation-test',
    architecture: {
      roleSystem: {
        explorationMode: 'guided',
        guidedFocus: {
          domain: 'Test Domain',
          context: 'Test research context',
          executionMode: 'mixed',
          depth: 'deep'
        }
      }
    },
    coordinator: { agentTypeWeights: { research: 1, ide: 1 } },
    ideFirst: { enabled: true },
    models: {
      primary: 'test-primary',
      fast: 'test-fast',
      strategicModel: 'test-strategic'
    },
    mcp: { client: { enabled: false, servers: [] } },
    ...overrides
  };
}

function baseSubsystems(overrides = {}) {
  return {
    client: {
      generate: async () => ({ content: VALID_PLAN_JSON })
    },
    memory: {
      query: async () => [],
      nodes: new Map(),
      addNode: async () => ({ id: 'test-node' })
    },
    goals: { getGoals: () => [] },
    clusterStateStore: {
      getPlan: async () => null,
      listTasks: async () => [],
      listMilestones: async () => [],
      createPlan: async () => {},
      upsertMilestone: async () => {},
      upsertTask: async () => {},
      updatePlan: async () => {},
      getTask: async () => null,
      get: async () => null,
      set: async () => {}
    },
    agentExecutor: {
      registry: { getActiveCount: () => 0 },
      resultsQueue: { queue: [], history: [], processed: [] }
    },
    pathResolver: null,
    ...overrides
  };
}

function createPlanner(configOverrides = {}, subsystemOverrides = {}) {
  return new GuidedModePlanner(
    baseConfig(configOverrides),
    baseSubsystems(subsystemOverrides),
    silentLogger()
  );
}

async function createTempDir(prefix = 'cosmo-continuation-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function cleanupDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Context Change Detection — Integration with planner decision tree
// ═══════════════════════════════════════════════════════════════════════════════

describe('Continuation-Aware Planning — Context Change Detection Integration', () => {

  it('reworded context with same domain does NOT set contextRedirect when LLM says "same"', async () => {
    // Full integration: exercise the planMission detection block with an existing plan
    // whose context differs textually but the LLM deems it semantically the same.
    const generateCalls = [];
    const planner = createPlanner({}, {
      client: {
        generate: async (opts) => {
          generateCalls.push(opts);
          if (opts.purpose === 'context_comparison') {
            return { content: 'same' };
          }
          // For generateMissionPlan — return a minimal valid plan
          return { content: VALID_PLAN_JSON };
        }
      },
      clusterStateStore: {
        getPlan: async () => ({
          id: 'plan:main',
          status: 'ACTIVE',
          _sourceContext: 'Investigate healthcare market trends',
          _sourceDomain: 'Healthcare',
          title: 'Healthcare',
          version: 1
        }),
        listTasks: async () => [
          { id: 'task:1', state: 'PENDING', planId: 'plan:main' }
        ],
        listMilestones: async () => [
          { id: 'ms:1', status: 'ACTIVE', planId: 'plan:main' }
        ],
        createPlan: async () => {},
        upsertMilestone: async () => {},
        upsertTask: async () => {},
        updatePlan: async () => {},
        getTask: async () => null,
        get: async () => null
      }
    });

    // Set config to use the same domain but reworded context
    planner.config.architecture.roleSystem.guidedFocus = {
      domain: 'Healthcare',
      context: 'Look into healthcare market trends and dynamics',
      executionMode: 'mixed',
      depth: 'deep'
    };

    const result = await planner.planMission();

    // The planner should have called the LLM for context comparison
    const contextCall = generateCalls.find(c => c.purpose === 'context_comparison');
    expect(contextCall).to.exist;

    // Since LLM said "same", the plan should be resumed (not regenerated)
    // When plan is ACTIVE with active tasks and no contextRedirect, planner resumes
    expect(result).to.not.be.null;
    expect(result.spawnAgents).to.equal(false);
    // Result should NOT have planningContext (resume path doesn't generate a new context)
    expect(result.planningContext).to.be.undefined;
  });

  it('different domain always sets contextRedirect (no LLM call needed)', async () => {
    let contextComparisonCalled = false;
    let archiveCalled = false;

    const planner = createPlanner({}, {
      client: {
        generate: async (opts) => {
          if (opts.purpose === 'context_comparison') {
            contextComparisonCalled = true;
            return { content: 'same' };
          }
          return { content: VALID_PLAN_JSON };
        }
      },
      clusterStateStore: {
        getPlan: async () => ({
          id: 'plan:main',
          status: 'ACTIVE',
          _sourceContext: 'Research healthcare trends',
          _sourceDomain: 'Healthcare',
          title: 'Healthcare',
          version: 1
        }),
        listTasks: async () => [
          { id: 'task:1', state: 'PENDING', planId: 'plan:main' }
        ],
        listMilestones: async () => [
          { id: 'ms:1', status: 'ACTIVE', planId: 'plan:main' }
        ],
        createPlan: async () => {},
        upsertMilestone: async (ms) => {},
        upsertTask: async (t) => {},
        updatePlan: async (id, update) => {
          if (update.status === 'ARCHIVED') archiveCalled = true;
        },
        getTask: async () => null,
        get: async () => null,
        set: async () => {}
      }
    });

    // Domain changes from Healthcare to Finance
    planner.config.architecture.roleSystem.guidedFocus = {
      domain: 'Finance',
      context: 'Research healthcare trends',
      executionMode: 'mixed',
      depth: 'deep'
    };

    const result = await planner.planMission();

    // No semantic context comparison should be performed when domain differs
    expect(contextComparisonCalled).to.equal(false);
    // Old plan should be archived (contextRedirect = true)
    expect(archiveCalled).to.equal(true);
    // New plan should be generated (has planningContext)
    expect(result).to.not.be.null;
    expect(result.planningContext).to.exist;
    expect(result.planningContext.contextRedirect).to.equal(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PGS Assessment Integration with planMission
// ═══════════════════════════════════════════════════════════════════════════════

describe('Continuation-Aware Planning — PGS Assessment Integration', () => {

  it('assessKnowledgeState is called from planMission and populates planningContext.knowledgeAssessment', async () => {
    let assessCalled = false;
    const planner = createPlanner({}, {
      client: {
        generate: async () => ({ content: VALID_PLAN_JSON })
      }
    });

    // Monkey-patch assessKnowledgeState to verify it's called and inject a mock result
    const originalAssess = planner.assessKnowledgeState.bind(planner);
    planner.assessKnowledgeState = async function(guidedFocus, runPath) {
      assessCalled = true;
      return {
        answer: 'The brain has strong coverage of X but lacks Y.',
        data: {
          timestamp: new Date().toISOString(),
          nodeCount: 200,
          partitionsSwept: 4,
          answer: 'The brain has strong coverage of X but lacks Y.'
        },
        jsonPath: path.join(runPath || '/tmp', 'coordinator', 'planning-assessment-test.json'),
        mdPath: path.join(runPath || '/tmp', 'coordinator', 'planning-assessment-test.md')
      };
    };

    const result = await planner.planMission();

    expect(assessCalled).to.equal(true);
    expect(result).to.not.be.null;
    expect(result.planningContext).to.exist;
    expect(result.planningContext.knowledgeAssessment).to.exist;
    expect(result.planningContext.knowledgeAssessment.answer).to.include('strong coverage');
    expect(result.planningContext.knowledgeAssessment.data.nodeCount).to.equal(200);
    expect(result.planningContext.assessmentPath).to.include('planning-assessment');
  });

  it('planMission succeeds even when assessKnowledgeState throws', async () => {
    const logger = capturingLogger();
    const config = baseConfig();
    const subsystems = baseSubsystems({
      client: {
        generate: async () => ({ content: VALID_PLAN_JSON })
      }
    });

    const planner = new GuidedModePlanner(config, subsystems, logger);

    // Make assessKnowledgeState throw
    planner.assessKnowledgeState = async () => {
      throw new Error('PGS engine completely broken');
    };

    const result = await planner.planMission();

    // Plan should still be generated successfully
    expect(result).to.not.be.null;
    expect(result.planningContext).to.exist;
    // knowledgeAssessment should be absent (not set because it threw)
    expect(result.planningContext.knowledgeAssessment).to.be.undefined;

    // Warning should be logged
    const warnLog = logger.logs.find(
      l => l.level === 'warn' && l.msg && l.msg.includes('Knowledge assessment failed')
    );
    expect(warnLog).to.exist;
  });

  it('planMission succeeds when assessKnowledgeState returns null', async () => {
    const planner = createPlanner();

    // Return null (e.g., empty brain)
    planner.assessKnowledgeState = async () => null;

    const result = await planner.planMission();

    expect(result).to.not.be.null;
    expect(result.planningContext).to.exist;
    // knowledgeAssessment should be absent
    expect(result.planningContext.knowledgeAssessment).to.be.undefined;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Planning Prompt Injection
// ═══════════════════════════════════════════════════════════════════════════════

describe('Continuation-Aware Planning — Planning Prompt Injection', () => {

  it('buildPlanningPrompt includes BRAIN KNOWLEDGE ASSESSMENT section when assessment is present', () => {
    const planner = createPlanner();
    const guidedFocus = { domain: 'Climate Science', context: 'Assess ice sheet dynamics', depth: 'deep' };
    const resources = { mcp: { tools: [] }, webSearch: true, codeExecution: false, agentTypes: ['research', 'ide'] };
    const planningContext = {
      hasContext: false,
      contextRedirect: false,
      knowledgeAssessment: {
        answer: 'Brain covers atmospheric CO2 levels well. Ice sheet mass balance data is sparse. No ocean current models found.'
      }
    };

    const prompt = planner.buildPlanningPrompt(guidedFocus, resources, [], [], planningContext);

    expect(prompt).to.include('## BRAIN KNOWLEDGE ASSESSMENT (PGS Deep Sweep)');
    expect(prompt).to.include('Ice sheet mass balance data is sparse');
    expect(prompt).to.include('## PLANNING INSTRUCTION');
    expect(prompt).to.include('DO NOT create research phases for topics shown as well-covered');
    expect(prompt).to.include('Create research phases ONLY for specific gaps');
    expect(prompt).to.include('Start the plan from the first phase that requires genuinely NEW work');
  });

  it('buildPlanningPrompt works normally when no assessment is present', () => {
    const planner = createPlanner();
    const guidedFocus = { domain: 'Climate Science', context: 'Assess ice sheet dynamics', depth: 'deep' };
    const resources = { mcp: { tools: [] }, webSearch: true, codeExecution: false, agentTypes: ['research', 'ide'] };
    const planningContext = {
      hasContext: false,
      contextRedirect: false
      // no knowledgeAssessment
    };

    const prompt = planner.buildPlanningPrompt(guidedFocus, resources, [], [], planningContext);

    // Should NOT include assessment sections
    expect(prompt).to.not.include('## BRAIN KNOWLEDGE ASSESSMENT');
    expect(prompt).to.not.include('## PLANNING INSTRUCTION');

    // Should still include the standard prompt structure
    expect(prompt).to.include('TASK DEFINITION:');
    expect(prompt).to.include('Domain: Climate Science');
    expect(prompt).to.include('YOUR JOB:');
    expect(prompt).to.include('OUTPUT FORMAT (JSON):');
  });

  it('buildPlanningPrompt includes PLANNING INSTRUCTION with delta-planning instructions', () => {
    const planner = createPlanner();
    const guidedFocus = { domain: 'Test', context: 'ctx' };
    const resources = { mcp: { tools: [] }, webSearch: false, codeExecution: false, agentTypes: ['research'] };
    const planningContext = {
      hasContext: false,
      knowledgeAssessment: {
        answer: 'Some knowledge exists about topic X.'
      }
    };

    const prompt = planner.buildPlanningPrompt(guidedFocus, resources, [], [], planningContext);

    // The PLANNING INSTRUCTION block should contain delta-planning guidance
    const instructionIdx = prompt.indexOf('## PLANNING INSTRUCTION');
    expect(instructionIdx).to.be.greaterThan(-1);

    const afterInstruction = prompt.substring(instructionIdx);
    expect(afterInstruction).to.include('DO NOT create research phases for topics shown as well-covered');
    expect(afterInstruction).to.include('Create research phases ONLY for specific gaps identified as missing or shallow');
    expect(afterInstruction).to.include('start directly with data processing, database creation, or synthesis phases');
  });

  it('buildPlanningPrompt skips continuation context when contextRedirect is true', () => {
    const planner = createPlanner();
    const guidedFocus = { domain: 'New Direction', context: 'A totally new topic' };
    const resources = { mcp: { tools: [] }, webSearch: false, codeExecution: false, agentTypes: ['research'] };
    const planningContext = {
      hasContext: true,
      contextRedirect: true,
      threadAnchor: { title: 'Old thread' },
      completedTasks: [{ summary: 'Old task done' }],
      reviewGaps: ['Old gap'],
      recentFindings: ['Old finding'],
      processedSourceUrls: ['https://old.example.com']
    };

    const prompt = planner.buildPlanningPrompt(guidedFocus, resources, [], [], planningContext);

    // Should NOT include continuation info (because contextRedirect = true)
    expect(prompt).to.not.include('EXISTING RESEARCH THREAD CONTEXT');
    expect(prompt).to.not.include('Old task done');
    expect(prompt).to.not.include('Old gap');
    // The standard prompt should reference fresh planning
    expect(prompt).to.include('Plan research missions');
  });

  it('buildPlanningPrompt includes continuation context when hasContext is true and no redirect', () => {
    const planner = createPlanner();
    const guidedFocus = { domain: 'Test', context: 'ctx' };
    const resources = { mcp: { tools: [] }, webSearch: false, codeExecution: false, agentTypes: ['research'] };
    const planningContext = {
      hasContext: true,
      contextRedirect: false,
      threadAnchor: { title: 'Existing thread anchor' },
      completedTasks: [{ summary: 'Task A completed' }],
      reviewGaps: ['Evidence gap in area B'],
      recentFindings: ['Finding C discovered'],
      processedSourceUrls: ['https://example.com/source1']
    };

    const prompt = planner.buildPlanningPrompt(guidedFocus, resources, [], [], planningContext);

    expect(prompt).to.include('EXISTING RESEARCH THREAD CONTEXT');
    expect(prompt).to.include('Task A completed');
    expect(prompt).to.include('Evidence gap in area B');
    expect(prompt).to.include('Finding C discovered');
    expect(prompt).to.include('https://example.com/source1');
    expect(prompt).to.include('Advance the existing research thread');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. MetaCoordinator Assessment Loading
// ═══════════════════════════════════════════════════════════════════════════════

describe('Continuation-Aware Planning — MetaCoordinator Assessment Loading', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await createTempDir('cosmo-metacoord-test-');
  });

  afterEach(async () => {
    await cleanupDir(tmpDir);
  });

  // We test the assessment file loading logic from makeStrategicDecisions
  // by extracting the file-reading pattern and verifying its behavior.
  // Full MetaCoordinator instantiation requires many heavy dependencies,
  // so we test the assessment loading logic in isolation.

  async function loadAssessmentFromDir(coordinatorDir) {
    // This replicates the exact logic from MetaCoordinator.makeStrategicDecisions (lines 3104-3144)
    let planningAssessmentContext = '';
    try {
      const assessmentFiles = await fs.readdir(coordinatorDir);
      const assessmentJsonFiles = assessmentFiles
        .filter(f => f.startsWith('planning-assessment-') && f.endsWith('.json'))
        .sort()
        .reverse(); // Newest first

      if (assessmentJsonFiles.length > 0) {
        const latestPath = path.join(coordinatorDir, assessmentJsonFiles[0]);
        const rawData = await fs.readFile(latestPath, 'utf8');
        const assessmentData = JSON.parse(rawData);

        planningAssessmentContext = `

## PLANNING ASSESSMENT (PGS Brain Sweep at Startup)

The following assessment was produced by a deep PGS sweep before planning.
It shows what the brain knows and what gaps exist:

${assessmentData.answer || 'No assessment answer available.'}

## ASSESSMENT GUIDANCE

Use this to evaluate whether current agent work is addressing the identified gaps.
Flag if:
- Agents are researching topics already marked as well-covered
- Identified gaps are not being addressed by any active agent
- Execution phases (datapipeline, infrastructure) should be prioritized over redundant research
- The plan needs adjustment based on progress since this assessment
`;
      }
    } catch (err) {
      // Non-fatal: same as MetaCoordinator behavior
    }
    return planningAssessmentContext;
  }

  it('includes assessment in prompt when planning-assessment-*.json exists', async () => {
    // Create a mock assessment file
    const assessmentData = {
      timestamp: '2026-03-22T12:00:00Z',
      domain: 'Climate Science',
      context: 'Ice sheet dynamics',
      nodeCount: 350,
      partitionsSwept: 6,
      answer: 'Brain has strong coverage of Arctic ice metrics. Antarctic data is incomplete. No ocean heat transport models found.',
      sweepResults: [],
      metadata: {}
    };
    const filename = 'planning-assessment-2026-03-22T12-00-00-000Z.json';
    await fs.writeFile(
      path.join(tmpDir, filename),
      JSON.stringify(assessmentData, null, 2),
      'utf8'
    );

    const result = await loadAssessmentFromDir(tmpDir);

    expect(result).to.include('## PLANNING ASSESSMENT (PGS Brain Sweep at Startup)');
    expect(result).to.include('Arctic ice metrics');
    expect(result).to.include('Antarctic data is incomplete');
    expect(result).to.include('## ASSESSMENT GUIDANCE');
    expect(result).to.include('Agents are researching topics already marked as well-covered');
  });

  it('selects the newest assessment file when multiple exist', async () => {
    // Older file
    const olderData = {
      answer: 'OLDER assessment — should not be selected',
      nodeCount: 100, partitionsSwept: 2
    };
    await fs.writeFile(
      path.join(tmpDir, 'planning-assessment-2026-03-20T10-00-00-000Z.json'),
      JSON.stringify(olderData),
      'utf8'
    );

    // Newer file
    const newerData = {
      answer: 'NEWER assessment — should be selected',
      nodeCount: 500, partitionsSwept: 8
    };
    await fs.writeFile(
      path.join(tmpDir, 'planning-assessment-2026-03-22T18-00-00-000Z.json'),
      JSON.stringify(newerData),
      'utf8'
    );

    const result = await loadAssessmentFromDir(tmpDir);

    expect(result).to.include('NEWER assessment');
    expect(result).to.not.include('OLDER assessment');
  });

  it('returns empty string when no assessment file exists', async () => {
    // Directory is empty (no assessment files)
    const result = await loadAssessmentFromDir(tmpDir);
    expect(result).to.equal('');
  });

  it('handles gracefully when coordinator directory does not exist', async () => {
    const result = await loadAssessmentFromDir(path.join(tmpDir, 'nonexistent-subdir'));
    // Should return empty string without throwing
    expect(result).to.equal('');
  });

  it('handles malformed JSON in assessment file gracefully', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'planning-assessment-2026-03-22T12-00-00-000Z.json'),
      'NOT VALID JSON {{{',
      'utf8'
    );

    const result = await loadAssessmentFromDir(tmpDir);
    // Should not throw, returns empty
    expect(result).to.equal('');
  });

  it('uses "No assessment answer available." when answer field is missing', async () => {
    const data = {
      nodeCount: 50,
      partitionsSwept: 1
      // no 'answer' field
    };
    await fs.writeFile(
      path.join(tmpDir, 'planning-assessment-2026-03-22T12-00-00-000Z.json'),
      JSON.stringify(data),
      'utf8'
    );

    const result = await loadAssessmentFromDir(tmpDir);
    expect(result).to.include('No assessment answer available.');
  });

  it('ignores non-assessment files in the directory', async () => {
    // Write non-matching files
    await fs.writeFile(path.join(tmpDir, 'review-plan-001.json'), '{}', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'strategic-snapshot.json'), '{}', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'planning-assessment-2026-03-22.md'), '# Markdown', 'utf8');

    const result = await loadAssessmentFromDir(tmpDir);
    // None match planning-assessment-*.json pattern
    expect(result).to.equal('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. End-to-end: Assessment flows from planMission into planning prompt
// ═══════════════════════════════════════════════════════════════════════════════

describe('Continuation-Aware Planning — End-to-End Prompt Flow', () => {

  it('assessment generated by planMission is included in the LLM planning call', async () => {
    let planningPromptSeen = null;

    const planner = createPlanner({}, {
      client: {
        generate: async (opts) => {
          // Capture the planning prompt (passed as user message content)
          const userMsg = opts.messages?.find(m => m.role === 'user');
          if (userMsg?.content?.includes('TASK DEFINITION:')) {
            planningPromptSeen = userMsg.content;
          }
          return { content: VALID_PLAN_JSON };
        }
      }
    });

    // Inject a mock assessment
    planner.assessKnowledgeState = async () => ({
      answer: 'Brain covers topic A well. Topic B has no data. Topic C needs deeper analysis.',
      data: {
        timestamp: new Date().toISOString(),
        nodeCount: 300,
        partitionsSwept: 5,
        answer: 'Brain covers topic A well. Topic B has no data. Topic C needs deeper analysis.'
      },
      jsonPath: '/tmp/coordinator/planning-assessment-test.json',
      mdPath: '/tmp/coordinator/planning-assessment-test.md'
    });

    await planner.planMission();

    expect(planningPromptSeen).to.not.be.null;
    expect(planningPromptSeen).to.include('## BRAIN KNOWLEDGE ASSESSMENT (PGS Deep Sweep)');
    expect(planningPromptSeen).to.include('Topic B has no data');
    expect(planningPromptSeen).to.include('## PLANNING INSTRUCTION');
    expect(planningPromptSeen).to.include('DO NOT create research phases for topics shown as well-covered');
  });

  it('planMission without assessment produces prompt without assessment section', async () => {
    let planningPromptSeen = null;

    const planner = createPlanner({}, {
      client: {
        generate: async (opts) => {
          const userMsg = opts.messages?.find(m => m.role === 'user');
          if (userMsg?.content?.includes('TASK DEFINITION:')) {
            planningPromptSeen = userMsg.content;
          }
          return { content: VALID_PLAN_JSON };
        }
      }
    });

    // Assessment returns null (empty brain or PGS failure)
    planner.assessKnowledgeState = async () => null;

    await planner.planMission();

    expect(planningPromptSeen).to.not.be.null;
    expect(planningPromptSeen).to.not.include('## BRAIN KNOWLEDGE ASSESSMENT');
    expect(planningPromptSeen).to.not.include('## PLANNING INSTRUCTION');
    // Standard prompt structure should still exist
    expect(planningPromptSeen).to.include('TASK DEFINITION:');
    expect(planningPromptSeen).to.include('YOUR JOB:');
  });

  it('contextRedirect plan includes assessment but excludes continuation context', async () => {
    let planningPromptSeen = null;

    const planner = createPlanner({}, {
      client: {
        generate: async (opts) => {
          const userMsg = opts.messages?.find(m => m.role === 'user');
          if (userMsg?.content?.includes('TASK DEFINITION:')) {
            planningPromptSeen = userMsg.content;
          }
          return { content: VALID_PLAN_JSON };
        }
      },
      clusterStateStore: {
        getPlan: async () => ({
          id: 'plan:main',
          status: 'ACTIVE',
          _sourceContext: 'Old research direction',
          _sourceDomain: 'OldDomain',
          title: 'OldDomain',
          version: 1
        }),
        listTasks: async () => [
          { id: 'task:1', state: 'PENDING', planId: 'plan:main' }
        ],
        listMilestones: async () => [
          { id: 'ms:1', status: 'ACTIVE', planId: 'plan:main' }
        ],
        createPlan: async () => {},
        upsertMilestone: async () => {},
        upsertTask: async () => {},
        updatePlan: async () => {},
        getTask: async () => null,
        get: async () => null,
        set: async () => {}
      },
      // Provide memory matches so hasContext would be true
      memory: {
        query: async () => [{ content: 'old finding', similarity: 0.9 }],
        nodes: new Map(),
        addNode: async () => ({ id: 'node' })
      }
    });

    // Domain change triggers contextRedirect
    planner.config.architecture.roleSystem.guidedFocus = {
      domain: 'NewDomain',
      context: 'New research context',
      executionMode: 'mixed',
      depth: 'deep'
    };

    // Inject assessment
    planner.assessKnowledgeState = async () => ({
      answer: 'Assessment for new direction: very little known.',
      data: {
        timestamp: new Date().toISOString(),
        nodeCount: 10,
        partitionsSwept: 1,
        answer: 'Assessment for new direction: very little known.'
      },
      jsonPath: '/tmp/test-assessment.json',
      mdPath: '/tmp/test-assessment.md'
    });

    await planner.planMission();

    expect(planningPromptSeen).to.not.be.null;
    // Assessment should be included
    expect(planningPromptSeen).to.include('## BRAIN KNOWLEDGE ASSESSMENT');
    expect(planningPromptSeen).to.include('very little known');
    // Continuation context should be excluded (contextRedirect = true)
    expect(planningPromptSeen).to.not.include('EXISTING RESEARCH THREAD CONTEXT');
  });
});
