'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  RESEARCH_PRODUCT_LOOP,
  RESEARCH_LAUNCH_VIEW,
  INTERACTIVE_PRODUCT_LOOP,
  launchDestination,
  resolveProductLoop,
  isInteractiveProductLoop
} = require('../../../lib/research-launch');
const {
  composeShortLaunchPlan,
  isToolLoopPlan,
  isLegacySpecialistPlan,
  FORBIDDEN_PLAN_PHRASES
} = require('../../src/agent/short-plan');
const { LaunchLoop } = require('../../src/agent/loop');
const { tools, INTERACTIVE_ONLY, executeTool, toChatTools, uniqueToolsByName } = require('../../src/agent/tools');
const { GuidedModePlanner } = require('../../src/core/guided-mode-planner');
const { PlanExecutor } = require('../../src/core/plan-executor');
const AnthropicClient = require('../../src/core/anthropic-client');
const { AUTH_REVOKED_WATCH_MESSAGE, isFatalAuthError } = require('../../../lib/auth-error');

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

function createPlanner(overrides = {}) {
  const stored = { plan: null, milestones: [], tasks: [] };
  const config = {
    logsDir: '/tmp/cosmo-research-launch-test',
    architecture: {
      roleSystem: {
        explorationMode: 'guided',
        guidedFocus: {
          domain: 'Jerry Garcia anecdotes',
          context: 'Collect and write notable Jerry Garcia anecdotes.',
          executionMode: 'guided-exclusive',
          depth: 'normal'
        }
      }
    },
    models: { primary: 'test-primary' },
    mcp: { client: { enabled: false, servers: [] } },
    ...overrides.config
  };
  const subsystems = {
    client: { generate: async () => ({ content: '{}' }), createCompletion: async () => ({ choices: [] }) },
    clusterStateStore: {
      getPlan: async () => stored.plan,
      listTasks: async () => stored.tasks,
      listMilestones: async () => stored.milestones,
      createPlan: async (plan) => { stored.plan = plan; },
      upsertMilestone: async (ms) => { stored.milestones.push(ms); },
      upsertTask: async (task) => { stored.tasks.push(task); },
      updatePlan: async (id, update) => { stored.plan = { ...stored.plan, ...update }; }
    },
    agentExecutor: { registry: { getActiveCount: () => 0 } },
    memory: { query: async () => [], nodes: new Map(), addNode: async () => ({ id: 'n1' }) },
    ...overrides.subsystems
  };
  const planner = new GuidedModePlanner(config, subsystems, logger);
  planner._stored = stored;
  return planner;
}

describe('Cosmo research Launch contract', () => {
  it('Launch destination is the drill board, never Interactive', () => {
    expect(launchDestination()).to.equal('drill');
    expect(launchDestination()).to.equal(RESEARCH_LAUNCH_VIEW);
    expect(RESEARCH_LAUNCH_VIEW).to.not.equal('interactive');
  });

  it('Interactive is never the product loop, even if a leftover collapse asks for it', () => {
    expect(isInteractiveProductLoop()).to.equal(false);
    expect(resolveProductLoop(INTERACTIVE_PRODUCT_LOOP)).to.equal(RESEARCH_PRODUCT_LOOP);
    expect(resolveProductLoop('research')).to.equal(RESEARCH_PRODUCT_LOOP);
    expect(resolveProductLoop(undefined)).to.equal(RESEARCH_PRODUCT_LOOP);
  });

  it('control center Launch and Continue land on the drill board in app.js', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '../../../public/app.js'), 'utf8');
    expect(appSource).to.match(/const RESEARCH_LAUNCH_VIEW = 'drill'/);
    expect(appSource).to.match(/this\.switchView\(RESEARCH_LAUNCH_VIEW\)/);
    expect(appSource).to.not.match(/startDrill[\s\S]{0,900}switchView\('chat'\)/);
    expect(appSource).to.not.match(/continueDrill[\s\S]{0,900}switchView\('chat'\)/);
    expect(appSource).to.not.include('/api/launch/go');
  });

  it('refuses the living Mini leftover that emptied tonight\'s run', () => {
    const planner = fs.readFileSync(path.join(__dirname, '../../src/core/guided-mode-planner.js'), 'utf8');
    const executor = fs.readFileSync(path.join(__dirname, '../../src/core/plan-executor.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '../../../public/app.js'), 'utf8');

    expect(planner).to.not.include('Interactive is the product loop; engine Launch loop will not start');
    expect(planner).to.not.include('Fresh Launch: short plan → Interactive tool loop');
    expect(planner).to.not.include("productLoop: 'interactive'");
    expect(planner).to.not.include('subordinate: true');
    expect(executor).to.not.include('Launch tool loop owns this plan — not assigning a specialist');
    expect(executor).to.not.match(/executionKind === 'tool_loop'[\s\S]{0,400}return null;/);
    expect(app).to.match(/api\('\/api\/launch'/);
    expect(app).to.match(/api\(`\/api\/continue\//);
  });
});

describe('Short Launch plan', () => {
  it('is only goal, constraints, and deliverable', () => {
    const plan = composeShortLaunchPlan({
      domain: 'Jerry Garcia anecdotes',
      context: 'Collect notable stories. Write them up.'
    });
    expect(plan.goal).to.equal('Jerry Garcia anecdotes');
    expect(plan.constraints).to.deep.equal(['Collect notable stories. Write them up.']);
    expect(plan.deliverable).to.be.a('string').and.not.empty;
    expect(plan.executionKind).to.equal('tool_loop');
    expect(plan.claimedBy).to.equal('launch_loop');
    expect(Object.keys(plan)).to.have.members([
      'goal', 'constraints', 'deliverable', 'executionKind', 'claimedBy'
    ]);
  });

  it('never tells the model to review what is already here', () => {
    const plan = composeShortLaunchPlan({
      domain: 'Forrest research',
      context: 'Continue from last night'
    });
    const blob = JSON.stringify(plan).toLowerCase();
    for (const phrase of FORBIDDEN_PLAN_PHRASES) {
      expect(blob).to.not.include(phrase);
    }
  });

  it('planMission writes a tool_loop plan, not a 3-phase specialist recipe', async () => {
    const planner = createPlanner();
    const result = await planner.planMission({ forceNew: true });
    expect(result.executionKind).to.equal('tool_loop');
    expect(result.claimedBy).to.equal('launch_loop');
    expect(result.spawnAgents).to.equal(false);
    expect(result.agentMissions).to.deep.equal([]);
    expect(result.taskPhases).to.deep.equal([]);
    expect(result.shortPlan.goal).to.equal('Jerry Garcia anecdotes');
    expect(planner._stored.plan.executionKind).to.equal('tool_loop');
    expect(planner._stored.tasks).to.have.length(1);
    expect(planner._stored.tasks[0].assignedAgentId).to.equal('launch_loop');
    expect(planner._stored.milestones).to.have.length(1);
  });

  it('planMission does not run PGS review-what-is-here assessment', async () => {
    const planner = createPlanner();
    let assessed = false;
    planner.assessKnowledgeState = async () => {
      assessed = true;
      return { answer: 'should not run' };
    };
    planner.generateMissionPlan = async () => {
      throw new Error('old mission recipes are not the execution path');
    };
    const result = await planner.planMission({ forceNew: true });
    expect(assessed).to.equal(false);
    expect(result.executionKind).to.equal('tool_loop');
  });
});

describe('startLaunchLoop', () => {
  it('starts the research loop and never returns Interactive as the product loop', async () => {
    const planner = createPlanner();
    await planner.planMission({ forceNew: true });
    const started = [];
    const result = await planner.startLaunchLoop({
      productLoop: 'interactive',
      subordinate: true,
      createLoop: (args) => ({
        start() {
          started.push(args);
          this.running = true;
          this.started = true;
          return { started: true, productLoop: RESEARCH_PRODUCT_LOOP };
        }
      })
    });
    expect(result.started).to.equal(true);
    expect(result.productLoop).to.equal('research');
    expect(result.subordinate).to.equal(false);
    expect(started).to.have.length(1);
  });

  it('does not no-op a tool_loop plan', async () => {
    const planner = createPlanner();
    const plan = await planner.planMission({ forceNew: true });
    const result = await planner.startLaunchLoop({
      plan,
      createLoop: () => ({
        running: false,
        started: false,
        start() {
          this.running = true;
          this.started = true;
          return { started: true };
        }
      })
    });
    expect(result).to.deep.include({
      started: true,
      productLoop: 'research',
      subordinate: false
    });
  });
});

describe('PlanExecutor tool_loop', () => {
  it('does not assign nobody and do nothing', async () => {
    let ensured = 0;
    const pe = new PlanExecutor(
      {
        getPlan: async () => ({
          id: 'plan:main',
          status: 'ACTIVE',
          executionKind: 'tool_loop',
          claimedBy: 'launch_loop'
        }),
        listMilestones: async () => [{ id: 'ms:research', status: 'ACTIVE', order: 1, title: 'Research' }],
        listTasks: async () => [{
          id: 'task:research',
          state: 'IN_PROGRESS',
          title: 'Research',
          assignedAgentId: 'launch_loop',
          metadata: { executionKind: 'tool_loop' }
        }]
      },
      { registry: { getAgentIncludingCompleted: () => null, getTaskAgentStatus: () => ({}) } },
      logger,
      {
        ensureLaunchLoop: async () => {
          ensured += 1;
          return { started: true, productLoop: 'research', reused: false };
        }
      }
    );

    const tick = await pe.tick(1);
    expect(ensured).to.equal(1);
    expect(tick.action).to.equal('LAUNCH_LOOP_OWNS');
    expect(tick.productLoop).to.equal('research');

    pe.activeTask = { id: 'task:research', metadata: { executionKind: 'tool_loop' } };
    pe.plan = { executionKind: 'tool_loop' };
    const assigned = await pe.assignAgent();
    expect(assigned.action).to.equal('LAUNCH_LOOP_OWNS');
    expect(assigned.action).to.not.equal(null);
  });

  it('fails loud when the research loop cannot start', async () => {
    const pe = new PlanExecutor(
      { getPlan: async () => null },
      { registry: {} },
      logger,
      {}
    );
    pe.plan = { executionKind: 'tool_loop', status: 'ACTIVE' };
    const assigned = await pe.assignAgent();
    expect(assigned.action).to.equal('LAUNCH_LOOP_MISSING');
  });
});

describe('Research Launch loop and harness', () => {
  it('exposes files, shell, web, skills, coding, and candidate journal — not Interactive specialist spawn', () => {
    const names = tools.map((tool) => tool.name);
    expect(names).to.include.members([
      'read_file', 'write_file', 'run_command', 'web_search',
      'remember', 'list_skills', 'run_skill', 'coding_run', 'finish'
    ]);
    for (const blocked of INTERACTIVE_ONLY) {
      expect(names).to.not.include(blocked);
    }
  });

  it('toChatTools has unique function names and exactly one web_search', () => {
    const chatTools = toChatTools();
    const names = chatTools.map((tool) => tool.function.name);
    expect(new Set(names).size).to.equal(names.length);
    expect(names.filter((name) => name === 'web_search')).to.have.length(1);
    expect(names.filter((name) => name === 'coding_run')).to.have.length(1);
  });

  it('dedupes research tools by name when the imported list already has web_search', () => {
    const deduped = uniqueToolsByName([
      { name: 'web_search', description: 'first' },
      { name: 'read_file' },
      { name: 'web_search', description: 'second' },
      { name: 'coding_run' },
      { name: 'coding_run' }
    ]);
    expect(deduped.map((tool) => tool.name)).to.deep.equal(['web_search', 'read_file', 'coding_run']);
    expect(deduped[0].description).to.equal('first');
  });

  it('runs a model turn that calls tools and can finish', async () => {
    const calls = [];
    const loop = new LaunchLoop({
      logger,
      plan: composeShortLaunchPlan({ domain: 'Test topic', context: 'Write a note.' }),
      config: { models: { primary: 'test' } },
      client: {
        createCompletion: async ({ tools: modelTools, messages }) => {
          calls.push({ toolCount: modelTools.length, messages });
          if (calls.length === 1) {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  tool_calls: [{
                    id: 'call_1',
                    function: { name: 'finish', arguments: JSON.stringify({ summary: 'Wrote outputs/note.md' }) }
                  }]
                }
              }]
            };
          }
          return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
        }
      }
    });

    const start = loop.start();
    expect(start.started).to.equal(true);
    expect(start.productLoop).to.equal('research');
    await loop._promise;
    expect(loop.finished).to.equal(true);
    expect(loop.finishSummary).to.equal('Wrote outputs/note.md');
    expect(loop.turns).to.be.at.least(1);
    expect(calls[0].toolCount).to.be.greaterThan(5);
  });

  it('journals remember() as a candidate — the DRILL writes the Brain at cycle end, not the worker mid-turn', async () => {
    const runtimePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-launch-remember-'));
    let added = 0;
    const result = await executeTool('remember', { content: 'Garcia once played a 3-hour set.' }, {
      runtimePath,
      orchestrator: {
        memory: {
          addNode: async () => {
            added += 1;
            return { id: 'should-not-write-mid-turn' };
          }
        }
      },
      logger,
      loop: { drill: { cycle: 2, goalNumber: 1, phaseNumber: 1 } }
    });
    expect(result).to.include('Journaled candidate finding');
    expect(added).to.equal(0);
    const journal = fs.readFileSync(path.join(runtimePath, 'outputs', 'candidates', 'findings.jsonl'), 'utf8');
    const row = JSON.parse(journal.trim());
    expect(row.type).to.equal('candidate_finding');
    expect(row.promoted).to.equal(false);
    expect(row.content).to.include('Garcia');
    expect(row.cycle).to.equal(2);
    expect(row.goalNumber).to.equal(1);
    expect(row.phaseNumber).to.equal(1);
  });

  it('classifies leftover tool_loop plans as research, not legacy specialists', () => {
    expect(isToolLoopPlan({ executionKind: 'tool_loop', claimedBy: 'plan_executor' })).to.equal(true);
    expect(isLegacySpecialistPlan({ id: 'plan:main', status: 'ACTIVE' })).to.equal(true);
    expect(isLegacySpecialistPlan({ executionKind: 'tool_loop' })).to.equal(false);
  });
});

describe('Fatal Anthropic OAuth / 401', () => {
  it('classifies 401, authentication_error, and revoked OAuth as fatal', () => {
    expect(isFatalAuthError({ status: 401, message: 'Unauthorized' })).to.equal(true);
    expect(isFatalAuthError({ type: 'authentication_error' })).to.equal(true);
    expect(isFatalAuthError(new Error('OAuth access token has been revoked'))).to.equal(true);
    expect(isFatalAuthError('[Error: OAuth access token has been revoked]')).to.equal(true);
    expect(isFatalAuthError({
      hadError: true,
      errorType: 'unknown_error',
      content: '[Error: OAuth access token has been revoked]'
    })).to.equal(true);
    expect(isFatalAuthError('Garcia once got a 401 at the Fillmore')).to.equal(false);
    expect(isFatalAuthError({ hadError: true, errorType: 'rate_limit_error' })).to.equal(false);
  });

  it('stops the Launch loop after one revoked-OAuth turn — no 80-turn retry storm', async () => {
    const events = [];
    const errors = [];
    const loop = new LaunchLoop({
      logger: {
        ...logger,
        error: (message, meta) => errors.push({ message, meta })
      },
      plan: composeShortLaunchPlan({ domain: 'Jerry Garcia anecdotes', context: 'Collect stories.' }),
      config: { models: { primary: 'claude-fable' } },
      maxTurns: 80,
      orchestrator: {
        _getEvents: () => ({
          emitEvent: (type, event) => events.push({ type, event })
        })
      },
      client: {
        createCompletion: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '[Error: OAuth access token has been revoked]'
            }
          }],
          hadError: true,
          errorType: 'authentication_error',
          retryable: false
        })
      }
    });

    let calls = 0;
    const original = loop.client.createCompletion;
    loop.client.createCompletion = async (...args) => {
      calls += 1;
      return original(...args);
    };

    loop.start();
    await loop._promise;

    expect(calls).to.equal(1);
    expect(loop.turns).to.equal(1);
    expect(loop.running).to.equal(false);
    expect(loop.finished).to.equal(false);
    expect(loop.fatalError).to.equal(AUTH_REVOKED_WATCH_MESSAGE);
    expect(loop.getStatus().status).to.equal('error');
    expect(loop.messages.some((msg) => msg.content === 'Continue. Use tools. Call finish when the deliverable is written.')).to.equal(false);
    expect(errors.some((row) => row.message === AUTH_REVOKED_WATCH_MESSAGE)).to.equal(true);
    expect(events.some((row) => row.type === 'launch_loop_error' && row.event.message === AUTH_REVOKED_WATCH_MESSAGE)).to.equal(true);
  });

  it('stops the Launch loop when createCompletion throws 401', async () => {
    let calls = 0;
    const loop = new LaunchLoop({
      logger,
      plan: composeShortLaunchPlan({ domain: 'Jerry Garcia anecdotes', context: 'Collect stories.' }),
      config: { models: { primary: 'claude-fable' } },
      maxTurns: 80,
      client: {
        createCompletion: async () => {
          calls += 1;
          const err = new Error('OAuth access token has been revoked');
          err.status = 401;
          err.type = 'authentication_error';
          throw err;
        }
      }
    });

    loop.start();
    await loop._promise;

    expect(calls).to.equal(1);
    expect(loop.turns).to.equal(1);
    expect(loop.running).to.equal(false);
    expect(loop.fatalError).to.equal(AUTH_REVOKED_WATCH_MESSAGE);
  });

  it('does not treat a research mention of 401 as a dead token', async () => {
    let calls = 0;
    const loop = new LaunchLoop({
      logger,
      plan: composeShortLaunchPlan({ domain: 'Test topic', context: 'Write a note.' }),
      config: { models: { primary: 'test' } },
      maxTurns: 3,
      client: {
        createCompletion: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Garcia once got a 401 at the Fillmore. Writing that down.'
                }
              }]
            };
          }
          return {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'call_finish',
                  function: { name: 'finish', arguments: JSON.stringify({ summary: 'Wrote the anecdote' }) }
                }]
              }
            }]
          };
        }
      }
    });

    loop.start();
    await loop._promise;
    expect(loop.fatalError).to.equal(null);
    expect(loop.finished).to.equal(true);
    expect(calls).to.equal(2);
  });

  it('does not retry hadError authentication_error — fail closed after one attempt', async () => {
    const logs = [];
    let calls = 0;
    const client = Object.create(AnthropicClient.prototype);
    client.logger = {
      info: (message) => logs.push(String(message)),
      warn: (message) => logs.push(String(message)),
      error: (message) => logs.push(String(message)),
      debug: () => {}
    };
    client.generate = async () => {
      calls += 1;
      return {
        content: '[Error: OAuth access token has been revoked]',
        hadError: true,
        errorType: 'authentication_error',
        retryable: false
      };
    };

    const result = await client.generateWithRetry({ component: 'execution', purpose: 'agentic_loop' }, 3);

    expect(calls).to.equal(1);
    expect(result.errorType).to.equal('authentication_error');
    expect(logs.some((line) => /Retry 1\/3/.test(line))).to.equal(false);
    expect(logs.some((line) => /All retries exhausted/.test(line))).to.equal(false);
  });

  it('AnthropicClient does not Retry 1/3 a revoked OAuth token', async () => {
    const logs = [];
    let calls = 0;
    const client = Object.create(AnthropicClient.prototype);
    client.logger = {
      info: (message) => logs.push(String(message)),
      warn: (message) => logs.push(String(message)),
      error: (message) => logs.push(String(message)),
      debug: () => {}
    };
    client.generate = async () => {
      calls += 1;
      const err = new Error('OAuth access token has been revoked');
      err.status = 401;
      return client._buildErrorResponse(err);
    };

    const result = await client.generateWithRetry({ component: 'execution', purpose: 'agentic_loop' }, 3);

    expect(calls).to.equal(1);
    expect(result.hadError).to.equal(true);
    expect(result.errorType).to.equal('authentication_error');
    expect(result.retryable).to.equal(false);
    expect(logs.some((line) => /Retry 1\/3/.test(line))).to.equal(false);
    expect(logs.some((line) => /All retries exhausted/.test(line))).to.equal(false);
    expect(logs.some((line) => line.includes(AUTH_REVOKED_WATCH_MESSAGE))).to.equal(true);
  });

  it('classifies SDK 401 without error.type as authentication_error, not unknown_error', () => {
    const client = Object.create(AnthropicClient.prototype);
    const err = new Error('OAuth access token has been revoked');
    err.status = 401;
    const built = client._buildErrorResponse(err);
    expect(built.errorType).to.equal('authentication_error');
    expect(built.errorType).to.not.equal('unknown_error');
    expect(built.retryable).to.equal(false);
    expect(isFatalAuthError(built)).to.equal(true);
  });
});
