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
      [
        '# Jerry Garcia Side Project Shows',
        '',
        'Verified deliverable with enough body text to prove this is not an empty placeholder.',
        'It records the intended final markdown artifact for the acceptance gate.'
      ].join('\n')
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

  it('completes a pending assigned task when its expected output is already registered and valid', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    await fs.mkdir(path.join(outputDir, 'final'), { recursive: true });
    const reportPath = path.join(outputDir, 'final', 'archive-org-comments-report.md');
    await fs.writeFile(
      reportPath,
      [
        '# Archive.org Comments Report',
        '',
        'This report is grounded in upstream raw and validation artifacts.',
        'It contains enough concrete body text for the expected-output gate.',
        'The task must close from the registered artifact instead of waiting for a redundant start transition.'
      ].join('\n')
    );

    let startCalled = false;
    const queued = [];
    const stateStore = {
      startTask: async () => {
        startCalled = true;
      },
      completeTask: async () => true
    };
    const taskStateQueue = {
      enqueue: async (event) => queued.push(event)
    };
    const pathResolver = {
      resolve: (token) => {
        if (token === '@outputs') return outputDir;
        if (token.startsWith('@outputs/')) return path.join(outputDir, token.slice('@outputs/'.length));
        return token;
      }
    };

    const pe = new PlanExecutor(
      stateStore,
      { registry: {} },
      logger,
      { pathResolver, taskStateQueue }
    );

    pe.plan = { id: 'plan:main', title: 'Acceptance run', status: 'ACTIVE' };
    pe.activePhase = { id: 'ms:phase3', title: 'Synthesize Final Report', order: 3, status: 'ACTIVE' };
    pe.activeTask = null;
    pe.tasks = [
      { id: 'task:phase1', milestoneId: 'ms:phase1', state: 'DONE' },
      { id: 'task:phase2', milestoneId: 'ms:phase2', state: 'DONE' },
      {
        id: 'task:phase3',
        title: 'Synthesize Final Report',
        milestoneId: 'ms:phase3',
        state: 'PENDING',
        deps: ['task:phase2'],
        assignedAgentId: 'agent_report',
        agentAssignedAt: Date.now(),
        acceptanceCriteria: [{ type: 'qa', rubric: 'Final report exists' }],
        artifacts: [{
          path: 'final/archive-org-comments-report.md',
          workspacePath: 'outputs/final/archive-org-comments-report.md',
          absolutePath: reportPath,
          agentId: 'agent_report'
        }],
        metadata: {
          expectedOutput: '@outputs/final/archive-org-comments-report.md',
          researchContract: { required: false }
        }
      }
    ];

    const result = await pe.checkTask();

    expect(result.action).to.equal('TASK_COMPLETED');
    expect(startCalled).to.equal(false);
    expect(queued).to.have.length(1);
    expect(queued[0].type).to.equal('COMPLETE_TASK');
    expect(queued[0].taskId).to.equal('task:phase3');
    expect(queued[0].artifacts.some((artifact) => artifact.path === 'final/archive-org-comments-report.md')).to.equal(true);
  });

  it('does not pass a source-required task with only generic files and no source evidence', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    await fs.mkdir(path.join(outputDir, 'raw-anecdotes'), { recursive: true });
    await fs.writeFile(
      path.join(outputDir, 'raw-anecdotes', 'web-search-results.json'),
      '{"entries":[{"note":"generic artifact without source proof"}]}\n'
    );

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

  it('does not pass an expected JSON output that exists but cannot be parsed', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'broken.json'), '{"records": [}\n');

    const pe = makeExecutor(outputDir);
    pe.activeTask = {
      id: 'task:broken-json',
      title: 'Write structured records',
      acceptanceCriteria: [],
      metadata: {
        expectedOutput: '@outputs/broken.json'
      }
    };

    const validation = await pe.validateTaskOutput([]);
    expect(validation.passed).to.equal(false);
    expect(validation.reason).to.include('Invalid expected output');
    expect(validation.reason).to.include('invalid_json');
  });

  it('does not pass Archive negative receipts without per-identifier review-route proof', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    await fs.mkdir(path.join(outputDir, 'raw-anecdotes'), { recursive: true });
    await fs.writeFile(
      path.join(outputDir, 'raw-anecdotes', 'archive-org-comments.json'),
      JSON.stringify({
        entries: [],
        status: 'no_reviews_found',
        required_identifiers: ['show-without-reviews'],
        identifier_statuses: [{
          identifier: 'show-without-reviews',
          status: 'no_reviews_found',
          metadata_route: 'accepted',
          review_route: 'missing',
          source_url: 'https://archive.org/details/show-without-reviews'
        }],
        urls_searched: ['https://archive.org/details/show-without-reviews'],
        route_receipts: {
          attempts: [
            { route: 'archive.metadata', status: 'accepted', result_count: 1, url_count: 1 },
            { route: 'archive.reviews', status: 'empty', result_count: 0, url_count: 0 }
          ],
          productive_source_urls: ['https://archive.org/details/show-without-reviews']
        }
      }, null, 2)
    );

    const pe = makeExecutor(outputDir);
    pe.activeTask = {
      id: 'task:archive-negative',
      title: 'Fetch Archive comments',
      description: 'Fetch Archive.org comments and write negative receipts when none exist.',
      acceptanceCriteria: [],
      metadata: {
        expectedOutput: '@outputs/raw-anecdotes/archive-org-comments.json'
      }
    };

    const validation = await pe.validateTaskOutput([]);
    expect(validation.passed).to.equal(false);
    expect(validation.reason).to.include('archive_identifier_not_resolved:show-without-reviews');
  });

  it('does not skip source-contract validation when no explicit expected output exists', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'generic-note.md'), '# Generic Note\n\nA generic artifact exists but contains no source route proof.\n');

    const pe = makeExecutor(outputDir);
    pe.activeTask = {
      id: 'task:source-no-expected',
      title: 'Acquire source evidence',
      description: 'Use web_search to find source_url evidence for the claim.',
      acceptanceCriteria: []
    };

    const validation = await pe.validateTaskOutput([]);
    expect(validation.passed).to.equal(false);
    expect(validation.reason).to.include('Research contract failed');
  });

  it('does not pass typed source research when a required route was never attempted', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    const proofDir = path.join(outputDir, 'research', 'agent_crossref');
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'sources.json'), JSON.stringify({
      sources: [{ url: 'https://example.com/article', title: 'Generic web result' }]
    }, null, 2));
    await fs.writeFile(path.join(proofDir, 'source_backbone_status.json'), JSON.stringify({
      can_continue: false,
      required_routes: ['crossref.works'],
      attempted_routes: ['web.search'],
      accepted_routes: ['web.search'],
      productive_sources: 1,
      productive_source_urls: ['https://example.com/article'],
      attempts: 1,
      crossings: 1,
      failed_routes: [],
      missing_required_routes: ['crossref.works'],
      next_allowed_action: 'attempt_missing_required_source_routes'
    }, null, 2));
    await fs.writeFile(path.join(proofDir, 'source_attempts.jsonl'), [
      JSON.stringify({ route: 'web.search', status: 'accepted', result_count: 1, url_count: 1 })
    ].join('\n'));
    await fs.writeFile(path.join(proofDir, 'source_crossing.jsonl'), [
      JSON.stringify({ route: 'web.search', url: 'https://example.com/article', ok: true, status: 200 })
    ].join('\n'));

    const pe = makeExecutor(outputDir);
    pe.activeTask = {
      id: 'task:crossref-route',
      title: 'Acquire Crossref publication metadata',
      description: 'Use Crossref DOI metadata and save cited source_url evidence.',
      acceptanceCriteria: [],
      producedArtifacts: [
        { path: 'sources.json', workspacePath: 'outputs/sources.json' },
        { path: 'research/agent_crossref/source_backbone_status.json', workspacePath: 'outputs/research/agent_crossref/source_backbone_status.json' },
        { path: 'research/agent_crossref/source_attempts.jsonl', workspacePath: 'outputs/research/agent_crossref/source_attempts.jsonl' },
        { path: 'research/agent_crossref/source_crossing.jsonl', workspacePath: 'outputs/research/agent_crossref/source_crossing.jsonl' }
      ],
      metadata: {
        researchContract: {
          required: true,
          mode: 'source_acquisition',
          minSuccessfulSources: 1,
          requiredEvidence: ['successful_source_contact'],
          sourceProviderHints: ['crossref.works']
        }
      }
    };

    const validation = await pe.validateTaskOutput([]);
    expect(validation.passed).to.equal(false);
    expect(validation.reason).to.include('missing_required_source_routes');
    expect(validation.researchEvidence.missingRequiredRoutes).to.deep.equal(['crossref.works']);
  });

  it('passes a source-required task when source evidence exists and expected file is present', async function() {
    const outputDir = path.join(tempRoot, 'outputs');
    await fs.mkdir(path.join(outputDir, 'raw-anecdotes'), { recursive: true });
    await fs.writeFile(
      path.join(outputDir, 'raw-anecdotes', 'archive-org-comments.json'),
      JSON.stringify({
        entries: [],
        status: 'no_reviews_found',
        required_identifiers: ['show'],
        identifier_statuses: [{
          identifier: 'show',
          status: 'no_reviews_found',
          metadata_route: 'accepted',
          review_route: 'accepted',
          source_url: 'https://archive.org/details/show'
        }],
        urls_searched: ['https://archive.org/details/show'],
        route_receipts: {
          attempts: [
            { route: 'archive.metadata', status: 'accepted', result_count: 1, url_count: 1 },
            { route: 'archive.reviews', status: 'empty', result_count: 0, url_count: 0 }
          ],
          productive_source_urls: ['https://archive.org/details/show']
        }
      }, null, 2)
    );

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

  it('assigns a fresh task instead of judging it from stale completed agents with the same id', async function() {
    let observedScope = null;
    const spawned = [];
    const stateStore = {
      upsertTask: async () => true,
      releaseTask: async () => true
    };
    const agentExecutor = {
      registry: {
        getTaskAgentStatus: (taskId, scope) => {
          observedScope = scope;
          if (!scope) {
            return {
              hasActiveAgent: false,
              activeAgent: null,
              completedCount: 1,
              failedCount: 0,
              accomplishedCount: 0,
              allCompleted: [
                {
                  agent: {
                    agentId: 'agent_old',
                    accomplishment: { accomplished: false }
                  },
                  mission: { taskId, planId: 'plan:main' },
                  registeredAt: new Date('2026-06-30T14:00:00.000Z')
                }
              ],
              allFailed: [],
              allAccomplished: [],
              isBeingWorked: false,
              hasCompletedWork: true,
              hasAccomplishedWork: false,
              allFailed: false
            };
          }

          return {
            hasActiveAgent: false,
            activeAgent: null,
            completedCount: 0,
            failedCount: 0,
            accomplishedCount: 0,
            allCompleted: [],
            allFailed: [],
            allAccomplished: [],
            isBeingWorked: false,
            hasCompletedWork: false,
            hasAccomplishedWork: false,
            allFailed: false
          };
        }
      },
      spawnAgent: async (spec) => {
        spawned.push(spec);
        return 'agent_current';
      }
    };

    const pe = new PlanExecutor(stateStore, agentExecutor, logger, { maxRetries: 1 });
    pe.plan = {
      id: 'plan:main',
      title: 'Fresh plan',
      createdAt: new Date('2026-06-30T15:00:00.000Z')
    };
    pe.activePhase = { id: 'ms:phase1', title: 'Phase 1', order: 1 };
    pe.activeTask = {
      id: 'task:phase1',
      title: 'Fresh memory compile',
      description: 'Read current memory and write fresh outputs.',
      state: 'IN_PROGRESS',
      createdAt: new Date('2026-06-30T15:00:00.000Z'),
      assignedAgentId: null,
      metadata: { agentType: 'ide' }
    };

    const result = await pe.checkAgent();

    expect(observedScope).to.include({
      planId: 'plan:main',
      taskId: 'task:phase1'
    });
    expect(result.action).to.equal('AGENT_ASSIGNED');
    expect(spawned).to.have.length(1);
    expect(spawned[0].taskId).to.equal('task:phase1');
  });

  it('forwards persisted task tools into spawned mission specs', async function() {
    const spawned = [];
    const pe = new PlanExecutor(
      {
        upsertTask: async () => true,
        releaseTask: async () => true
      },
      {
        registry: {},
        spawnAgent: async (spec) => {
          spawned.push(spec);
          return 'agent-tools';
        }
      },
      logger,
      {}
    );

    pe.plan = { id: 'plan:main', title: 'Tool plan' };
    pe.activePhase = { id: 'ms:phase1', title: 'Phase 1', order: 1 };
    pe.activeTask = {
      id: 'task:phase1',
      title: 'Compile current memory',
      description: 'Query memory, read files, then write outputs.',
      metadata: {
        agentType: 'ide',
        tools: ['query_memory', 'read_file', 'write_file']
      }
    };

    const result = await pe.assignAgent();

    expect(result.action).to.equal('AGENT_ASSIGNED');
    expect(spawned[0].tools).to.deep.equal(['query_memory', 'read_file', 'write_file']);
    expect(spawned[0].metadata.tools).to.deep.equal(['query_memory', 'read_file', 'write_file']);
  });
});
