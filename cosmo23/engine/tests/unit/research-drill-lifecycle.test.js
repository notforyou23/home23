'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Orchestrator } = require('../../src/core/orchestrator');
const { DrillLoop } = require('../../src/drill/drill-loop');
const { executeTool } = require('../../src/agent/tools');

const logger = { info() {}, warn() {}, error() {}, debug() {} };

describe('Product drill lifecycle isolation', () => {
  it('tracks drill progress and settles without entering a cognitive cycle', async () => {
    const heartbeats = [];
    let completionRequest = null;
    let completionFinished = false;
    let sleeps = 0;
    const loop = {
      productLoop: 'research',
      started: true,
      running: true,
      finished: false,
      mode: 'drilling',
      cyclesUsed: 1,
      turns: 0,
      activeWorkers: new Map([
        ['w1', { workerId: 'w1', worker: { turns: 1 } }]
      ]),
      doneReason: null,
      question: 'Test question',
      budgetExhaustedReason() { return null; },
      _promise: Promise.resolve()
    };
    const fake = {
      launchLoop: loop,
      running: true,
      logger: { info() {} },
      heartbeatWriter: { stamp: payload => heartbeats.push(payload) },
      drillProgressSignature: Orchestrator.prototype.drillProgressSignature,
      sleep: async () => {
        sleeps += 1;
        loop.cyclesUsed = 2;
        loop.turns = 3;
        loop.running = false;
        loop.finished = true;
        loop.mode = 'done';
        loop.doneReason = 'cycles_exhausted';
      },
      requestRunCompletion(reason, plan, trigger) {
        completionRequest = { reason, plan, trigger };
        this.runCompletionRequested = completionRequest;
      },
      async finishRequestedRunCompletion() {
        completionFinished = true;
      }
    };

    await Orchestrator.prototype.runProductDrillLifecycle.call(fake);

    expect(sleeps).to.equal(1);
    expect(heartbeats).to.have.length(1);
    expect(heartbeats[0].phase).to.equal('drilling');
    expect(heartbeats[0].cycle).to.equal(1);
    expect(completionRequest.reason).to.equal('drill_cycles_exhausted');
    expect(completionRequest.trigger).to.equal('drill');
    expect(completionFinished).to.equal(true);
  });

  it('marks the product task, milestone, and plan complete with real writeups', async () => {
    const runtimePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-drill-close-'));
    fs.mkdirSync(path.join(runtimePath, 'outputs'), { recursive: true });
    fs.writeFileSync(
      path.join(runtimePath, 'outputs', 'phase.md'),
      '# Phase result\n\nThe research phase landed a concrete finding.'
    );
    const calls = [];
    const stateStore = {
      async completeTask(id, patch) { calls.push({ type: 'task', id, patch }); },
      async getMilestone() { return { id: 'ms:research', title: 'Research', order: 1 }; },
      async upsertMilestone(value) { calls.push({ type: 'milestone', value }); },
      async updatePlan(id, patch) { calls.push({ type: 'plan', id, patch }); }
    };
    const drill = new DrillLoop({
      orchestrator: { logsDir: runtimePath, clusterStateStore: stateStore },
      logger: { info() {}, warn() {}, error() {} },
      plan: { shortPlan: { goal: 'Research', constraints: [] } },
      config: { logsDir: runtimePath, drill: { cycles: 1 } }
    });

    await drill.completePlanState('cycles_exhausted');

    expect(calls.map(call => call.type)).to.deep.equal(['task', 'milestone', 'plan']);
    expect(calls[0].patch.artifacts).to.deep.equal(['outputs/phase.md']);
    expect(calls[1].value.status).to.equal('COMPLETED');
    expect(calls[2].patch.status).to.equal('COMPLETED');
  });

  it('persists an immediate stop and normalizes in-flight workers and phases', async () => {
    const runtimePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-drill-stop-'));
    const harvestPath = path.join(runtimePath, 'outputs', 'candidates', 'findings.jsonl');
    fs.mkdirSync(path.dirname(harvestPath), { recursive: true });
    fs.writeFileSync(harvestPath, `${JSON.stringify({ content: 'durable partial harvest' })}\n`);
    const stopped = [];
    const drill = new DrillLoop({
      orchestrator: { logsDir: runtimePath },
      logger: { info() {}, warn() {}, error() {} },
      plan: { shortPlan: { goal: 'Research', constraints: [] } },
      config: { logsDir: runtimePath, drill: { cycles: 5 } }
    });
    const activePhase = {
      id: 'phase-1',
      number: 1,
      title: 'Active phase',
      mission: 'Keep drilling',
      status: 'active',
      cyclesUsed: 1,
      evidence: { streamed: 1 },
      writeups: []
    };
    const donePhase = {
      id: 'phase-2',
      number: 2,
      title: 'Done phase',
      mission: 'Already complete',
      status: 'done',
      cyclesUsed: 1,
      evidence: { streamed: 1 },
      writeups: ['outputs/done.md']
    };
    drill.running = true;
    drill.started = true;
    drill.mode = 'drilling';
    drill.currentGoal = {
      id: 'goal-1',
      number: 1,
      title: 'Research',
      status: 'active',
      phases: [activePhase, donePhase]
    };
    drill.activeWorkers.set('w1', {
      workerId: 'w1',
      worker: {
        turns: 2,
        stop() { stopped.push('w1'); }
      },
      phase: activePhase,
      goal: drill.currentGoal,
      cycle: 1,
      startedAt: Date.now()
    });
    await drill.persistState();

    const result = await drill.stop();
    const state = JSON.parse(fs.readFileSync(path.join(runtimePath, 'drill', 'state.json'), 'utf8'));
    const progress = fs.readFileSync(path.join(runtimePath, 'drill', 'progress.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));

    expect(result.workersNormalized).to.equal(1);
    expect(result.phasesNormalized).to.equal(1);
    expect(stopped).to.deep.equal(['w1']);
    expect(drill.activeWorkers.size).to.equal(0);
    expect(state.mode).to.equal('stopped');
    expect(state.activeWorkers).to.deep.equal([]);
    expect(state.goal.phases.map((phase) => phase.status)).to.deep.equal(['pending', 'done']);
    expect(progress.at(-1).type).to.equal('drill_stopped');
    expect(progress.at(-1).interruptedWorkers[0].workerId).to.equal('w1');
    expect(fs.readFileSync(harvestPath, 'utf8')).to.include('durable partial harvest');
  });

  it('persists the named receipt and the evidence that cleared the phase', async () => {
    const runtimePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-drill-clearance-'));
    const drill = new DrillLoop({
      logger,
      orchestrator: { logsDir: runtimePath },
      config: { logsDir: runtimePath, drill: { cycles: 2 } },
      plan: {
        shortPlan: {
          goal: 'Garcia partnership',
          seedPhases: [{
            title: 'Garcia interviews',
            mission: 'Collect finished interview evidence.',
            expectedOutput: '@outputs/garcia_interview_sources.json'
          }]
        }
      }
    });
    const goal = await drill.nextGoal(null);
    const phase = goal.phases[0];
    const worker = {
      drill: { goalNumber: 1, phaseNumber: 1 },
      plan: { shortPlan: { expectedOutput: phase.expectedOutput } },
      expectedOutput: phase.expectedOutput,
      evidence: { streamed: 0 },
      turns: 2,
      finished: true,
      finishSummary: 'Interview evidence complete.',
      fatalError: null
    };
    await executeTool('write_file', {
      path: 'garcia_interview_sources.json',
      content: JSON.stringify({
        entries: [{ quote: 'Hunter and I passed the words back and forth.', source: 'Interview' }],
        status: 'complete'
      })
    }, { runtimePath, logger, loop: worker });
    phase.status = 'active';
    drill.currentGoal = goal;
    drill.activeWorkers.set('w1', {
      workerId: 'w1',
      worker,
      phase,
      goal,
      cycle: 1,
      done: true
    });

    await drill.settleFinishedWorkers();
    await drill.persistState();
    const state = JSON.parse(fs.readFileSync(path.join(runtimePath, 'drill', 'state.json'), 'utf8'));

    expect(phase.status).to.equal('done');
    expect(state.goal.phases[0].expectedOutput).to.equal('outputs/garcia_interview_sources.json');
    expect(state.goal.phases[0].clearance).to.include({
      reason: 'finished_json',
      path: 'outputs/garcia_interview_sources.json'
    });
    expect(state.goal.phases[0].clearance.sha256).to.match(/^[a-f0-9]{64}$/);
  });
});
