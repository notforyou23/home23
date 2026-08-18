'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Orchestrator } = require('../../src/core/orchestrator');
const { DrillLoop } = require('../../src/drill/drill-loop');

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
});
