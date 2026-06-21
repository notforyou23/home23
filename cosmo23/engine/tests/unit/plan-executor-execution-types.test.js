const { expect } = require('chai');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { PlanExecutor } = require('../../src/core/plan-executor');

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

describe('PlanExecutor Execution Agent Dispatch', function() {
  let pe;

  before(function() {
    try {
      const { PlanExecutor } = require('../../src/core/plan-executor');
      const logger = { info: ()=>{}, warn: ()=>{}, error: ()=>{}, debug: ()=>{} };
      // PlanExecutor constructor: (stateStore, agentExecutor, config, logger, options)
      const stateStore = { get: ()=>null, set: ()=>{}, getAll: ()=>[] };
      const agentExecutor = { registry: { getActiveAgentByTaskId: ()=>null } };
      pe = new PlanExecutor(stateStore, agentExecutor, { coordinator: {} }, logger);
    } catch (e) {
      this.skip();
    }
  });

  it('should dispatch dataacquisition from metadata', function() {
    const task = { title: 'Scrape data', description: 'Scrape product data', metadata: { agentType: 'dataacquisition' } };
    expect(pe.determineAgentType(task)).to.equal('dataacquisition');
  });

  it('should dispatch datapipeline from metadata', function() {
    const task = { title: 'Build DB', description: 'Transform data', metadata: { agentType: 'datapipeline' } };
    expect(pe.determineAgentType(task)).to.equal('datapipeline');
  });

  it('should dispatch infrastructure from metadata', function() {
    const task = { title: 'Setup', description: 'Docker setup', metadata: { agentType: 'infrastructure' } };
    expect(pe.determineAgentType(task)).to.equal('infrastructure');
  });

  it('should dispatch automation from metadata', function() {
    const task = { title: 'Automate', description: 'File org', metadata: { agentType: 'automation' } };
    expect(pe.determineAgentType(task)).to.equal('automation');
  });

  it('should detect scraping from keywords', function() {
    const task = { title: 'Scrape the site', description: 'Crawl all pages', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('dataacquisition');
  });

  it('should detect database creation from keywords', function() {
    const task = { title: 'Create database', description: 'Load data into database', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('datapipeline');
  });

  it('should detect docker/container from keywords', function() {
    const task = { title: 'Set up container', description: 'Provision docker environment', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('infrastructure');
  });

  it('should detect automation from keywords', function() {
    const task = { title: 'Organize files', description: 'Automate batch process for rename files', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('automation');
  });

  it('should still dispatch research from metadata', function() {
    const task = { title: 'Research X', description: 'Research topic', metadata: { agentType: 'research' } };
    expect(pe.determineAgentType(task)).to.equal('research');
  });

  it('should still dispatch ide from metadata', function() {
    const task = { title: 'Build feature', description: 'Write code', metadata: { agentType: 'ide' } };
    expect(pe.determineAgentType(task)).to.equal('ide');
  });

  it('should dispatch synthesis from metadata', function() {
    const task = { title: 'Synthesize', description: 'Create synthesis', metadata: { agentType: 'synthesis' } };
    expect(pe.determineAgentType(task)).to.equal('synthesis');
  });

  it('should dispatch analysis from metadata', function() {
    const task = { title: 'Analyze', description: 'Analyze data', metadata: { agentType: 'analysis' } };
    expect(pe.determineAgentType(task)).to.equal('analysis');
  });

  it('should fall back to ide for non-matching tasks', function() {
    const task = { title: 'Build a widget', description: 'Create the widget component', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('ide');
  });

  it('should fall back to research for research keywords', function() {
    const task = { title: 'Research AI trends', description: 'Find sources on AI', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('research');
  });
});

describe('PlanExecutor output-contract validation', function() {
  let tempRoot;

  beforeEach(async function() {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-plan-executor-'));
  });

  afterEach(async function() {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  function makeExecutor(outputDir) {
    const stateStore = {
      completeTask: async () => true,
      failTask: async () => true
    };
    const pathResolver = {
      resolve: (token) => {
        if (token === '@outputs') return outputDir;
        if (token.startsWith('@outputs/')) return path.join(outputDir, token.slice('@outputs/'.length));
        return token;
      }
    };
    return new PlanExecutor(stateStore, { registry: {} }, logger, { pathResolver });
  }

  it('does not pass a task when unrelated output files exist but the expected output is missing', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'summary.json'), '{"ok":true}\n');

    const pe = makeExecutor(outputDir);
    pe.activeTask = {
      id: 'task:synthesis_final',
      title: 'Assemble Final Deliverable',
      acceptanceCriteria: [
        {
          type: 'qa',
          rubric: 'Final deliverable exists at @outputs/jerry-garcia-side-projects-shows.md'
        }
      ],
      metadata: {
        expectedOutput: '@outputs/jerry-garcia-side-projects-shows.md',
        deliverableSpec: {
          filename: 'jerry-garcia-side-projects-shows.md',
          location: '@outputs/'
        }
      }
    };

    const missing = await pe.validateTaskOutput([]);
    expect(missing.passed).to.equal(false);
    expect(missing.reason).to.include('Missing expected output');

    await fs.writeFile(
      path.join(outputDir, 'jerry-garcia-side-projects-shows.md'),
      '# Jerry Garcia Side Project Shows\n\nVerified deliverable.\n'
    );

    const present = await pe.validateTaskOutput([]);
    expect(present.passed).to.equal(true);
    expect(present.artifacts.some((artifact) => artifact.path === 'jerry-garcia-side-projects-shows.md')).to.equal(true);
  });

  it('forwards validated artifacts through queued task completion', async function() {
    const queued = [];
    const taskStateQueue = {
      enqueue: async (event) => {
        queued.push(event);
      }
    };
    const pe = new PlanExecutor(
      { completeTask: async () => true },
      { registry: {} },
      logger,
      { taskStateQueue }
    );

    const artifacts = [{ path: 'required.md', artifactId: 'artifact_1' }];
    await pe.completeTask({ id: 'task:phase1', title: 'Phase 1' }, artifacts);

    expect(queued).to.have.length(1);
    expect(queued[0].artifacts).to.deep.equal(artifacts);
    expect(queued[0].producedArtifacts).to.deep.equal(artifacts);
  });

  it('does not pass a source-required task with only generic files and no source evidence', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    await fs.mkdir(path.join(outputDir, 'raw-anecdotes'), { recursive: true });
    await fs.writeFile(path.join(outputDir, 'raw-anecdotes', 'web-search-results.json'), '{"entries":[]}\n');

    const pe = makeExecutor(outputDir);
    pe.activeTask = {
      id: 'task:phase1',
      title: 'Execute web searches',
      description: 'Execute web_search queries and record source_url for every result.',
      acceptanceCriteria: [],
      metadata: {
        expectedOutput: '@outputs/raw-anecdotes/web-search-results.json',
        researchContract: {
          required: true,
          mode: 'web_research',
          minSuccessfulSources: 1,
          requiredEvidence: ['successful_source_contact'],
          reasonCodes: ['explicit_web_search']
        }
      }
    };

    const validation = await pe.validateTaskOutput([]);
    expect(validation.passed).to.equal(false);
    expect(validation.reason).to.include('Research contract failed');
  });

  it('passes a source-required task when source evidence exists and expected file is present', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    await fs.mkdir(path.join(outputDir, 'raw-anecdotes'), { recursive: true });
    await fs.writeFile(path.join(outputDir, 'raw-anecdotes', 'archive-org-comments.json'), '{"entries":[],"status":"no_comments_found"}\n');

    const pe = makeExecutor(outputDir);
    pe.activeTask = {
      id: 'task:phase2',
      title: 'Scrape Archive comments',
      description: 'Scrape Archive.org comments and save null results if none exist.',
      acceptanceCriteria: [],
      metadata: {
        expectedOutput: '@outputs/raw-anecdotes/archive-org-comments.json',
        researchContract: {
          required: true,
          mode: 'source_acquisition',
          minSuccessfulSources: 1,
          requiredEvidence: ['successful_source_contact'],
          reasonCodes: ['archive_research']
        }
      }
    };

    const validation = await pe.validateTaskOutput([
      {
        agent: {
          agentId: 'agent_data',
          acquisitionManifest: {
            sources: [{ url: 'https://archive.org/details/show', status: 200, bytes: 512 }],
            pagesAcquired: 0,
            filesDownloaded: 0,
            bytesAcquired: 512,
            errors: []
          },
          accomplishment: { metrics: { commandsRun: 2 } },
          results: []
        }
      }
    ]);

    expect(validation.passed).to.equal(true);
  });

  it('marks the active phase and plan blocked when failed tasks exhaust retries', async function() {
    const updates = { plans: [], milestones: [] };
    const pe = new PlanExecutor(
      {
        updatePlan: async (planId, patch) => {
          updates.plans.push({ planId, patch });
          return true;
        },
        upsertMilestone: async (milestone) => {
          updates.milestones.push(milestone);
          return true;
        }
      },
      { registry: {} },
      logger,
      { maxRetries: 1 }
    );

    pe.plan = { id: 'plan:main', title: 'Source research', status: 'ACTIVE' };
    pe.activePhase = { id: 'ms:phase1', title: 'Source phase', order: 1, status: 'ACTIVE' };
    pe.tasks = [
      {
        id: 'task:phase1',
        title: 'Search sources',
        state: 'FAILED',
        metadata: { retryCount: 1 },
        failureReason: 'Research contract failed: missing_source_evidence'
      }
    ];

    const result = await pe.handlePhaseBlocked(pe.tasks);

    expect(result.action).to.equal('PHASE_BLOCKED');
    expect(updates.milestones[0].status).to.equal('BLOCKED');
    expect(updates.plans[0].patch.status).to.equal('BLOCKED');
    expect(updates.plans[0].patch.blockedReason).to.include('All tasks failed');
  });
});
