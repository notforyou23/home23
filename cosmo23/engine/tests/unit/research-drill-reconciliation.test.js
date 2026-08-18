'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  deriveDrillStatusTruth,
  reconcileDrillStateOnExit
} = require('../../../server/lib/drill-state-reconciliation');

function makeRun(prefix) {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(runPath, 'drill'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'outputs', 'raw'), { recursive: true });
  return runPath;
}

function activeState() {
  return {
    question: 'Crash-safe drill',
    mode: 'drilling',
    doneReason: null,
    finished: false,
    activeWorkers: [{
      workerId: 'w7',
      cycle: 7,
      goalNumber: 2,
      phaseNumber: 1,
      phaseTitle: 'Collect evidence'
    }],
    goal: {
      id: 'goal-2',
      number: 2,
      title: 'Deepen evidence',
      status: 'active',
      phases: [
        { number: 1, title: 'Collect evidence', status: 'active', workerId: 'w7' },
        { number: 2, title: 'Completed lane', status: 'done', workerId: null }
      ]
    },
    updatedAt: 10
  };
}

describe('Drill state reconciliation after cosmo-main exit', () => {
  it('reconciles active state, normalizes work, and appends interruption evidence', async () => {
    const runPath = makeRun('cosmo-drill-exit-');
    const statePath = path.join(runPath, 'drill', 'state.json');
    const harvestPath = path.join(runPath, 'outputs', 'raw', 'harvest.json');
    fs.writeFileSync(statePath, JSON.stringify(activeState(), null, 2));
    fs.writeFileSync(harvestPath, JSON.stringify({ records: ['kept'] }));

    const result = await reconcileDrillStateOnExit(runPath, {
      code: 1,
      signal: 'SIGTERM',
      at: 200
    });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const evidence = fs.readFileSync(path.join(runPath, 'drill', 'progress.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));

    expect(result.status).to.equal('reconciled');
    expect(state.mode).to.equal('interrupted');
    expect(state.activeWorkers).to.deep.equal([]);
    expect(state.goal.phases.map((phase) => phase.status)).to.deep.equal(['pending', 'done']);
    expect(state.goal.phases[0].workerId).to.equal(null);
    expect(state.interruption.signal).to.equal('SIGTERM');
    expect(evidence.at(-1).type).to.equal('drill_interrupted');
    expect(evidence.at(-1).workers[0].workerId).to.equal('w7');
    expect(JSON.parse(fs.readFileSync(harvestPath, 'utf8'))).to.deep.equal({ records: ['kept'] });
  });

  it('preserves naturally completed state byte-for-byte', async () => {
    const runPath = makeRun('cosmo-drill-done-');
    const statePath = path.join(runPath, 'drill', 'state.json');
    const done = {
      mode: 'done',
      doneReason: 'cycles_exhausted',
      finished: true,
      activeWorkers: [],
      goal: {
        number: 3,
        status: 'completed',
        phases: [{ number: 1, status: 'done' }]
      },
      marker: 'natural completion is authoritative'
    };
    const original = `${JSON.stringify(done, null, 2)}\n`;
    fs.writeFileSync(statePath, original);

    const result = await reconcileDrillStateOnExit(runPath, {
      code: 0,
      signal: null,
      at: 300
    });

    expect(result.status).to.equal('preserved');
    expect(fs.readFileSync(statePath, 'utf8')).to.equal(original);
    expect(fs.existsSync(path.join(runPath, 'drill', 'progress.jsonl'))).to.equal(false);
  });

  it('derives interrupted API truth when disk reconciliation cannot commit', async () => {
    const runPath = makeRun('cosmo-drill-reconcile-fail-');
    const statePath = path.join(runPath, 'drill', 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(activeState(), null, 2));
    const failingFs = {
      ...fs.promises,
      async writeFile(target, contents, options) {
        if (String(target).includes('.tmp-exit-')) {
          throw new Error('simulated read-only drill state');
        }
        return fs.promises.writeFile(target, contents, options);
      }
    };

    let failure = null;
    try {
      await reconcileDrillStateOnExit(
        runPath,
        { code: 137, signal: 'SIGKILL', at: 400 },
        { fs: failingFs }
      );
    } catch (error) {
      failure = error;
    }
    const staleDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const status = deriveDrillStatusTruth({
      drill: staleDisk,
      processOnline: false,
      recordedRunnerAlive: false,
      at: 401
    });

    expect(failure).to.be.instanceOf(Error);
    expect(failure.message).to.match(/simulated read-only drill state/);
    expect(staleDisk.mode).to.equal('drilling');
    expect(status.lifecycle).to.equal('interrupted');
    expect(status.running).to.equal(false);
    expect(status.derivedInterrupted).to.equal(true);
    expect(status.drill.mode).to.equal('interrupted');
    expect(status.drill.activeWorkers).to.deep.equal([]);
    expect(status.drill.goal.phases.map((phase) => phase.status)).to.deep.equal(['pending', 'done']);
    expect(status.drill.interruption.source).to.equal('api_status_derived');
  });
});
