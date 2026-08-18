'use strict';

/**
 * The drill contract.
 *
 * Cosmo is a drill that keeps drilling for the cycles or the time specified.
 * The work is: take/invent a GOAL -> work it through its PHASES -> when the
 * goal is done, CREATE THE NEXT GOAL -> keep going until cycles or time are
 * spent, or the human stops it. The tool loop is the drill bit; a worker
 * finishing a writeup is a phase or a hole, not the end of the goal and not
 * the end of the drill.
 */

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DrillLoop } = require('../../src/drill/drill-loop');
const { GuidedModePlanner } = require('../../src/core/guided-mode-planner');
const { FORBIDDEN_PLAN_PHRASES } = require('../../src/agent/short-plan');
const { executeTool } = require('../../src/agent/tools');
const { AUTH_REVOKED_WATCH_MESSAGE } = require('../../../lib/auth-error');
const { RESEARCH_LAUNCH_VIEW } = require('../../../lib/research-launch');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tempRuntime(prefix = 'cosmo-drill-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Scripted goal-planning model: every goal has two phases, and every request
 * for the next goal produces one, so the chain never runs dry — only the
 * budget ends the drill.
 */
function goalClient() {
  let goalCount = 0;
  return {
    async createCompletion({ messages }) {
      const system = messages?.[0]?.content || '';
      if (/define research goals with concrete phases/i.test(system)) {
        goalCount += 1;
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                title: `Goal ${goalCount}: dig level ${goalCount}`,
                why: 'keep drilling',
                phases: [
                  { title: `Level ${goalCount} search`, mission: `Search level ${goalCount}` },
                  { title: `Level ${goalCount} writeup`, mission: `Write up level ${goalCount}` }
                ]
              })
            }
          }]
        };
      }
      return { choices: [{ message: { role: 'assistant', content: '{}' } }] };
    }
  };
}

/**
 * Scripted worker: the drill bit. Journals one candidate through the real
 * remember tool and finishes its phase — exactly the proven one-agent shape.
 */
function scriptedWorkerFactory(runtimePath, { finish = true, fatalAuth = false, turns = 3 } = {}) {
  const spawned = [];
  const factory = (args) => {
    const worker = {
      drill: args.drill,
      plan: args.plan,
      maxTurns: args.maxTurns,
      turns: 0,
      running: false,
      started: false,
      finished: false,
      finishSummary: null,
      fatalError: null,
      _promise: null,
      start() {
        this.running = true;
        this.started = true;
        this._promise = (async () => {
          this.turns = turns;
          if (fatalAuth) {
            this.fatalError = AUTH_REVOKED_WATCH_MESSAGE;
            this.running = false;
            return;
          }
          await executeTool('remember', {
            content: `Finding from cycle ${this.drill.cycle} (goal ${this.drill.goalNumber} phase ${this.drill.phaseNumber})`
          }, { runtimePath, logger, loop: this });
          if (finish) {
            await executeTool('write_file', {
              path: String(this.plan.shortPlan.expectedOutput).replace(/^outputs\//, ''),
              content: `# Phase ${this.drill.phaseNumber}\n\nFinding from cycle ${this.drill.cycle}.`
            }, { runtimePath, logger, loop: this });
            this.finished = true;
            this.finishSummary = `Wrote ${this.plan.shortPlan.expectedOutput}`;
          }
          this.running = false;
        })();
        return { started: true };
      },
      stop() { this.running = false; }
    };
    spawned.push(worker);
    return worker;
  };
  factory.spawned = spawned;
  return factory;
}

function makeOrchestrator(runtimePath) {
  const added = [];
  const completions = [];
  const events = [];
  return {
    logsDir: runtimePath,
    memory: {
      added,
      async addNode(concept, tag, embedding, metadata) {
        added.push({ concept, tag, metadata });
        return { id: `node_${added.length}` };
      }
    },
    _getEvents: () => ({ emitEvent: (type, payload) => events.push({ type, payload }) }),
    requestRunCompletion(reason, plan, trigger) {
      completions.push({ reason, plan, trigger });
      return true;
    },
    events,
    completions
  };
}

function makeDrill({ runtimePath, client, createWorker, cycles = 6, minutes = 0, maxConcurrent = 3, now, orchestrator } = {}) {
  const orch = orchestrator || makeOrchestrator(runtimePath);
  const drill = new DrillLoop({
    orchestrator: orch,
    logger,
    client: client || goalClient(),
    createWorker,
    now,
    config: {
      logsDir: runtimePath,
      models: { primary: 'test-primary', fast: 'test-fast' },
      drill: { cycles, maxRuntimeMinutes: minutes, workerTurnsPerCycle: 6, maxConcurrent }
    },
    plan: {
      shortPlan: {
        goal: 'Jerry Garcia anecdotes',
        constraints: ['Collect and write notable Jerry Garcia anecdotes.'],
        deliverable: 'Write the research into this run.',
        executionKind: 'tool_loop',
        claimedBy: 'launch_loop'
      }
    }
  });
  drill._orchestrator = orch;
  return drill;
}

describe('The drill: goal → phases → next goal', () => {
  let runtimePath;

  beforeEach(() => {
    runtimePath = tempRuntime();
  });

  it('a worker finishing its writeup completes a phase — never the drill', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const drill = makeDrill({ runtimePath, createWorker, cycles: 5 });

    drill.start();
    await drill._promise;

    // The first worker finished. The drill kept drilling.
    expect(createWorker.spawned.length).to.be.greaterThan(1);
    expect(createWorker.spawned[0].finished).to.equal(true);
    expect(drill.cyclesUsed).to.equal(5);
    expect(drill.mode).to.equal('done');
    expect(drill.doneReason).to.equal('cycles_exhausted');

    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const types = progress.map((entry) => entry.type);
    const firstFinish = progress.findIndex((entry) => entry.type === 'cycle_completed' && entry.workerFinished);
    const laterCycle = types.lastIndexOf('cycle_started');
    expect(firstFinish).to.be.greaterThan(-1);
    expect(laterCycle).to.be.greaterThan(firstFinish);
  });

  it('works a goal through its phases, then creates the NEXT goal — the chain is the drill', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const drill = makeDrill({ runtimePath, createWorker, cycles: 6 });

    drill.start();
    await drill._promise;

    // 6 cycles at 2 phases per goal: goals 1..3 → at least 2 completed goals
    // and goal chaining recorded in order.
    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const goalsCreated = progress.filter((entry) => entry.type === 'goal_created');
    const goalsCompleted = progress.filter((entry) => entry.type === 'goal_completed');
    expect(goalsCreated.length).to.be.at.least(3);
    expect(goalsCompleted.length).to.be.at.least(2);

    // Every completed goal was followed by the creation of the next one.
    const firstCompletion = progress.findIndex((entry) => entry.type === 'goal_completed');
    const nextCreation = progress.slice(firstCompletion).findIndex((entry) => entry.type === 'goal_created');
    expect(nextCreation).to.be.greaterThan(0);

    // Phases advanced within each goal: cycle records carry phase numbers 1 and 2.
    const phaseNumbers = new Set(progress.filter((entry) => entry.type === 'cycle_started').map((entry) => entry.phaseNumber));
    expect(phaseNumbers.has(1)).to.equal(true);
    expect(phaseNumbers.has(2)).to.equal(true);

    expect(drill.goalHistory.filter((goal) => goal.status === 'completed').length).to.be.at.least(2);
  });

  it('the cycle budget is real: exactly N descents, then done and the run closes out', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const drill = makeDrill({ runtimePath, createWorker, cycles: 4 });

    drill.start();
    await drill._promise;

    expect(createWorker.spawned.length).to.equal(4);
    expect(drill.cyclesUsed).to.equal(4);
    expect(drill.mode).to.equal('done');
    expect(drill.doneReason).to.equal('cycles_exhausted');
    expect(drill.finished).to.equal(true);

    expect(drill._orchestrator.completions).to.have.length(1);
    expect(drill._orchestrator.completions[0].reason).to.equal('drill_cycles_exhausted');
  });

  it('the time budget is real: the drill stops on the clock even with cycles remaining', async function () {
    this.timeout(10000);
    let clock = Date.now();
    const createWorker = scriptedWorkerFactory(runtimePath);
    const drill = makeDrill({
      runtimePath,
      createWorker,
      cycles: 100,
      minutes: 10,
      now: () => clock
    });
    // Each descent costs 6 minutes of wall clock.
    const originalCreate = drill.createWorker;
    drill.createWorker = (args) => {
      clock += 6 * 60000;
      return originalCreate(args);
    };

    drill.start();
    await drill._promise;

    expect(drill.mode).to.equal('done');
    expect(drill.doneReason).to.equal('time_exhausted');
    expect(drill.cyclesUsed).to.be.lessThan(100);
    expect(drill._orchestrator.completions[0].reason).to.equal('drill_time_exhausted');
  });

  it('a worker that does not finish keeps its phase active — the next cycle continues it', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath, { finish: false });
    // Serial mode (one bit) still works: maxConcurrent 1.
    const drill = makeDrill({ runtimePath, createWorker, cycles: 3, maxConcurrent: 1 });

    drill.start();
    await drill._promise;

    expect(drill.cyclesUsed).to.equal(3);
    // The phase never finished, so it stayed the active phase for all cycles.
    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const cyclePhases = progress.filter((entry) => entry.type === 'cycle_started').map((entry) => entry.phaseNumber);
    expect(cyclePhases).to.deep.equal([1, 1, 1]);
    // The continued-phase mission tells the bit to continue, not start over.
    const continuedWorker = createWorker.spawned[1];
    expect(JSON.stringify(continuedWorker.plan)).to.include('Continue it; do not start over');
  });

  it('operator notes steer the next cycle', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const drill = makeDrill({ runtimePath, createWorker, cycles: 4 });

    // Queue a note before the drill starts — the first cycle must carry it.
    fs.mkdirSync(path.join(runtimePath, 'drill'), { recursive: true });
    fs.appendFileSync(
      path.join(runtimePath, 'drill', 'notes.jsonl'),
      `${JSON.stringify({ id: 'note_1', text: 'Focus on 1973 tour legs', at: Date.now() })}\n`
    );

    drill.start();
    await drill._promise;

    for (const worker of createWorker.spawned) {
      expect(JSON.stringify(worker.plan)).to.include('Operator note: Focus on 1973 tour legs');
    }

    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const delivered = progress.filter((entry) => entry.type === 'note_delivered' && entry.text === 'Focus on 1973 tour legs');
    expect(delivered.length).to.equal(createWorker.spawned.length);
    expect(progress.some((entry) => entry.type === 'note_consumed')).to.equal(false);
  });

  it('journaled candidates reach the Brain at cycle end — and the drill\'s own life streams live', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const drill = makeDrill({ runtimePath, createWorker, cycles: 3 });

    drill.start();
    await drill._promise;

    const memory = drill._orchestrator.memory;
    // The bits journaled findings without a live Brain attached to their
    // context — the drill promoted them at settle, degraded-honest.
    const findings = memory.added.filter((node) => node.tag === 'drill_finding');
    expect(findings.length).to.equal(3);
    for (const node of findings) {
      expect(node.metadata.source).to.equal('drill');
      expect(node.metadata.cycle).to.be.a('number');
    }
    // The working stream wrote the Brain as it happened: goals and phase
    // transitions are in there too, not only remember() output.
    expect(memory.added.some((node) => node.tag === 'drill_goal')).to.equal(true);
    expect(memory.added.some((node) => node.tag === 'drill_phase')).to.equal(true);
    expect(drill.brainWrites).to.be.at.least(3);
    // Disk is the tape: the same stream is on disk for the desk.
    const stream = readJsonl(path.join(runtimePath, 'outputs', 'stream.jsonl'));
    expect(stream.some((entry) => entry.kind === 'goal')).to.equal(true);
    expect(stream.some((entry) => entry.kind === 'phase')).to.equal(true);
  });

  it('401 / revoked OAuth is fatal: one error stops the drill and tells the control center', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath, { fatalAuth: true });
    const drill = makeDrill({ runtimePath, createWorker, cycles: 10 });

    drill.start();
    await drill._promise;

    // Only the first parallel wave ever launched — the first fatal error
    // stopped the drill; no retry storm across the remaining budget.
    expect(createWorker.spawned.length).to.be.at.most(drill.maxConcurrent);
    expect(drill.cyclesUsed).to.be.lessThan(10);
    expect(drill.running).to.equal(false);
    expect(drill.mode).to.equal('error');
    expect(drill.fatalError).to.equal(AUTH_REVOKED_WATCH_MESSAGE);
    expect(drill.getStatus().status).to.equal('error');
    const errorEvents = drill._orchestrator.events.filter((event) => event.type === 'launch_loop_error');
    expect(errorEvents.length).to.be.greaterThan(0);
    expect(errorEvents[0].payload.message).to.equal(AUTH_REVOKED_WATCH_MESSAGE);
    // The drill did not spend the budget as if nothing happened.
    expect(drill.mode).to.not.equal('done');
  });

  it('a mocked 400 tool-schema refusal consumes none of a 40-cycle hunt and surfaces the failure', async function () {
    this.timeout(10000);
    let calls = 0;
    const schemaErrorClient = {
      async createCompletion() {
        calls += 1;
        const error = new Error("400 Invalid schema for function 'brain_query': 'required' must include every key in properties. Missing 'limit'.");
        error.status = 400;
        error.provider = 'openai-codex';
        throw error;
      }
    };
    const drill = makeDrill({
      runtimePath,
      client: schemaErrorClient,
      cycles: 40,
      maxConcurrent: 1
    });
    drill.plan.shortPlan.seedPhases = [{
      title: 'Schema-gated research',
      mission: 'Research only after the provider accepts Cosmo tools.'
    }];

    drill.start();
    await drill._promise;

    expect(calls).to.equal(1);
    expect(drill.cyclesUsed).to.equal(0);
    expect(drill.remainingCycles()).to.equal(40);
    expect(drill.mode).to.equal('error');
    expect(drill.providerError).to.include('Invalid schema');
    expect(drill.getStatus().status).to.equal('error');
    expect(drill._orchestrator.completions).to.have.length(0);

    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const refused = progress.filter(entry => entry.type === 'cycle_refused');
    expect(refused).to.have.length(1);
    expect(refused[0]).to.include({
      errorType: 'tool_schema_error',
      countedAsResearchCycle: false
    });
    expect(progress.find(entry => entry.type === 'drill_error')?.cyclesUsed).to.equal(0);
    expect(drill._orchestrator.events.some(event =>
      event.type === 'launch_loop_error'
      && event.payload.errorType === 'tool_schema_error'
    )).to.equal(true);
  });

  it('a degraded coordinator seeds once, then stops instead of minting deepen rounds', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const brokenClient = {
      async createCompletion() {
        return { choices: [{ message: { role: 'assistant', content: 'not json at all' } }] };
      }
    };
    const drill = makeDrill({ runtimePath, createWorker, client: brokenClient, cycles: 3 });

    drill.start();
    await drill._promise;

    expect(drill.degradedGoalGeneration).to.equal(true);
    expect(drill.cyclesUsed).to.equal(1);
    expect(drill.mode).to.equal('done');
    expect(drill.doneReason).to.equal('goal_generation_failed');
    expect(drill._orchestrator.completions[0].reason).to.equal('drill_goal_generation_failed');
    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const goals = progress.filter((entry) => entry.type === 'goal_created');
    expect(goals).to.have.length(1);
    expect(goals[0].title).to.equal('Jerry Garcia anecdotes');
    expect(JSON.stringify(goals)).to.not.include('Go deeper');
    const rejections = progress.filter((entry) => entry.type === 'goal_generation_rejected');
    const nextGoalRejections = rejections.filter((entry) => entry.goalNumber === 2);
    expect(nextGoalRejections).to.have.length(2);
    expect(nextGoalRejections.map((entry) => entry.attempt)).to.deep.equal([1, 2]);
    expect(nextGoalRejections.every((entry) =>
      entry.reason === 'non_json_response' && entry.payload === 'not json at all'
    )).to.equal(true);
    expect(progress.find((entry) => entry.type === 'drill_done')?.reason).to.equal('goal_generation_failed');
    // No forbidden review-what-is-here phrasing in any mission.
    for (const worker of createWorker.spawned) {
      const blob = JSON.stringify(worker.plan).toLowerCase();
      for (const phrase of FORBIDDEN_PLAN_PHRASES) {
        expect(blob).to.not.include(phrase.toLowerCase());
      }
    }
  });

  it('the coordinator can close a completed hunt before the cycle cap', async function () {
    this.timeout(10000);
    let goalCalls = 0;
    const client = {
      async createCompletion({ messages }) {
        const system = messages?.[0]?.content || '';
        if (/define research goals with concrete phases/i.test(system)) {
          goalCalls += 1;
          const content = goalCalls === 1
            ? {
                title: 'Resolve the 1973 source gap',
                why: 'One named hole remains.',
                phases: [{ title: '1973 primary sources', mission: 'Find and write up the missing 1973 primary sources.' }]
              }
            : { done: true, reason: 'The completed goal resolved the last distinct gap.' };
          return { choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] };
        }
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({ summary: 'The 1973 source gap is resolved.', gaps: [] })
            }
          }]
        };
      }
    };
    const createWorker = scriptedWorkerFactory(runtimePath);
    const drill = makeDrill({ runtimePath, createWorker, client, cycles: 10 });

    drill.start();
    await drill._promise;

    expect(createWorker.spawned).to.have.length(1);
    expect(drill.cyclesUsed).to.equal(1);
    expect(drill.doneReason).to.equal('research_complete');
    expect(drill.degradedGoalGeneration).to.equal(false);
    expect(drill._orchestrator.completions[0].reason).to.equal('drill_research_complete');
    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    expect(progress.filter((entry) => entry.type === 'goal_created')).to.have.length(1);
    expect(progress.find((entry) => entry.type === 'drill_done')?.reason).to.equal('research_complete');
  });

  it('drill state on disk shows the board: goal, phases, budgets, activity', async function () {
    this.timeout(10000);
    const createWorker = scriptedWorkerFactory(runtimePath);
    const drill = makeDrill({ runtimePath, createWorker, cycles: 4 });

    drill.start();
    await drill._promise;

    const state = JSON.parse(fs.readFileSync(path.join(runtimePath, 'drill', 'state.json'), 'utf8'));
    expect(state.question).to.equal('Jerry Garcia anecdotes');
    expect(state.mode).to.equal('done');
    expect(state.budgets.cyclesTotal).to.equal(4);
    expect(state.budgets.cyclesUsed).to.equal(4);
    expect(state.budgets.cyclesRemaining).to.equal(0);
    expect(state.goal).to.exist;
    expect(state.goal.phases.length).to.be.greaterThan(0);
    for (const phase of state.goal.phases) {
      expect(['pending', 'active', 'done']).to.include(phase.status);
    }
    expect(state.goalHistory.length).to.be.at.least(1);
  });
});

describe('Launch starts the drill', () => {
  it('startLaunchLoop default loop is the DrillLoop with real budgets', async function () {
    this.timeout(10000);
    const runtimePath = tempRuntime('cosmo-planner-drill-');
    const stored = { plan: null, milestones: [], tasks: [] };
    const orchestrator = makeOrchestrator(runtimePath);
    const config = {
      logsDir: runtimePath,
      architecture: {
        roleSystem: {
          explorationMode: 'guided',
          guidedFocus: {
            domain: 'Jerry Garcia anecdotes',
            context: 'Collect and write notable Jerry Garcia anecdotes.',
            executionMode: 'guided-exclusive'
          }
        }
      },
      models: { primary: 'test-primary', fast: 'test-fast' },
      drill: { cycles: 2, workerTurnsPerCycle: 4 },
      mcp: { client: { enabled: false, servers: [] } }
    };
    const emptyClient = {
      async createCompletion() {
        return { choices: [{ message: { role: 'assistant', content: '{}' } }] };
      }
    };
    const planner = new GuidedModePlanner(config, {
      client: emptyClient,
      orchestrator,
      clusterStateStore: {
        getPlan: async () => stored.plan,
        listTasks: async () => stored.tasks,
        listMilestones: async () => stored.milestones,
        createPlan: async (plan) => { stored.plan = plan; },
        upsertMilestone: async (milestone) => { stored.milestones.push(milestone); },
        upsertTask: async (task) => { stored.tasks.push(task); },
        updatePlan: async (id, update) => { stored.plan = { ...stored.plan, ...update }; }
      },
      agentExecutor: { registry: { getActiveCount: () => 0 } },
      memory: orchestrator.memory
    }, logger);

    await planner.planMission({ forceNew: true });
    const result = await planner.startLaunchLoop({ orchestrator, client: emptyClient });

    expect(result.started).to.equal(true);
    expect(result.productLoop).to.equal('research');

    const loop = planner._launchLoop;
    expect(loop).to.be.instanceOf(DrillLoop);
    expect(orchestrator.launchLoop).to.equal(loop);
    expect(loop.cyclesTotal).to.equal(2);

    const status = loop.getStatus();
    expect(status.productLoop).to.equal('research');
    expect(status.drill.budgets.cyclesTotal).to.equal(2);

    // Let the tiny drill run out so nothing leaks between tests. The empty
    // client means degraded single-phase goals and unfinished workers —
    // budget still ends the drill.
    await loop._promise;
    expect(loop.mode).to.equal('done');
    expect(loop.doneReason).to.equal('cycles_exhausted');
  });
});

describe('The control center is what you open', () => {
  const publicDir = path.join(__dirname, '../../../public');

  it('Launch and Continue land on the drill board, never Interactive', () => {
    expect(RESEARCH_LAUNCH_VIEW).to.equal('watch');
    const appSource = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    expect(appSource).to.match(/const RESEARCH_LAUNCH_VIEW = 'watch'/);
    expect(appSource).to.match(/this\.switchView\(RESEARCH_LAUNCH_VIEW\)/);
    expect(appSource).to.match(/api\('\/api\/launch'/);
    expect(appSource).to.match(/api\(`\/api\/continue\//);
    expect(appSource).to.not.match(/startDrill[\s\S]{0,900}switchView\('chat'\)/);
    expect(appSource).to.not.match(/continueDrill[\s\S]{0,900}switchView\('chat'\)/);
    expect(appSource).to.not.include('/api/launch/go');
  });

  it('the Watch desk is the drill without removing the other product surfaces', () => {
    const indexSource = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    expect(indexSource).to.include('id="view-watch"');
    expect(indexSource).to.include('id="drill-phases"');
    expect(indexSource).to.include('id="drill-cycles"');
    expect(indexSource).to.include('id="drill-time-left"');
    expect(indexSource).to.include('id="view-brains"');
    expect(indexSource).to.include('id="view-map"');
    expect(indexSource).to.include('id="view-query"');
    expect(fs.existsSync(path.join(publicDir, 'js', 'brain-map.js'))).to.equal(true);
    expect(fs.existsSync(path.join(publicDir, 'js', 'intelligence-tab.js'))).to.equal(true);
    expect(fs.existsSync(path.join(publicDir, 'js', 'hub-tab.js'))).to.equal(true);
  });

  it('the board shows the drill: goal, phase, next goal, remaining budgets, stop, steer', () => {
    const appSource = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    expect(appSource).to.include('renderDrillStatus');
    expect(appSource).to.include('drill-goal');
    expect(appSource).to.include('drill-time-left');
    expect(appSource).to.include("api('/api/drill/status')");
    expect(appSource).to.include("'/api/drill/note'");
    expect(appSource).to.include("api('/api/stop'");
    expect(appSource).to.include('Receipt required:');
    expect(appSource).to.include('Cleared by');
  });
});

describe('Write-first close and persisted notes', () => {
  it('a later worker on a taped phase is told WRITE FIRST and sees the harvest digest', async function () {
    this.timeout(10000);
    const runtimePath = tempRuntime();
    const createWorker = scriptedWorkerFactory(runtimePath, { finish: false });
    const drill = makeDrill({ runtimePath, createWorker, cycles: 2, maxConcurrent: 1 });

    drill.start();
    await drill._promise;

    expect(createWorker.spawned).to.have.length(2);
    const second = JSON.stringify(createWorker.spawned[1].plan);
    expect(second).to.include('WRITE FIRST');
    expect(second).to.include('Harvest digest from this phase');
    expect(second).to.include('Finding from cycle 1');
  });

  it('tape without a writeup cannot close a phase — /tmp dumps never count', async function () {
    this.timeout(10000);
    const runtimePath = tempRuntime();
    const createWorker = scriptedWorkerFactory(runtimePath, { finish: false });
    const originalCreate = createWorker;
    // First descent harvests onto the tape. Second claims done with a /tmp dump.
    let descents = 0;
    const factory = (args) => {
      descents += 1;
      const worker = originalCreate(args);
      const body = worker.start;
      worker.start = function start() {
        const result = body.call(this);
        const prior = this._promise;
        this._promise = prior.then(async () => {
          if (descents === 1) return;
          fs.writeFileSync(path.join(os.tmpdir(), `hidden-writeup-${Date.now()}.md`), '# hidden\n');
          this.finished = true;
          this.finishSummary = 'dumped to /tmp';
        });
        return result;
      };
      return worker;
    };
    factory.spawned = createWorker.spawned;
    const drill = makeDrill({ runtimePath, createWorker: factory, cycles: 2, maxConcurrent: 1 });

    drill.start();
    await drill._promise;

    expect(drill.currentGoal.phases[0].status).to.not.equal('done');
    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const rejected = progress.filter((entry) => entry.type === 'cycle_completed' && entry.rejectedReason === 'missing_receipt');
    expect(rejected.length).to.be.greaterThan(0);
  });
});
