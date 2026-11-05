const { expect } = require('chai');
const { IntrinsicGoalSystem } = require('../../src/goals/intrinsic-goals');

function mkSystem(opts = {}) {
  const logger = {
    warnCalls: [], infoCalls: [],
    debug: () => {}, info(...a) { this.infoCalls.push(a); },
    warn(...a) { this.warnCalls.push(a); }, error: () => {}
  };
  // Disable legacy fallback by default in tests — we want strict gate
  // semantics here. Individual tests can override via opts.doneWhenCfg.
  const doneWhenCfg = { autoSynthesizeLegacy: false, ...(opts.doneWhenCfg || {}) };
  const config = {
    goals: { maxGoals: 100, doneWhen: doneWhenCfg },
    roleSystem: {}
  };
  const sys = new IntrinsicGoalSystem(config, logger);
  sys.logger = logger; // ensure the test can read the captured logs
  return sys;
}

describe('addGoal gate (doneWhen required)', () => {
  it('rejects a goal with no doneWhen', () => {
    const sys = mkSystem();
    const goal = sys.addGoal({ description: 'Design an evidence taxonomy schema' });
    expect(goal).to.equal(null);
    expect(sys.logger.warnCalls.length).to.be.greaterThan(0);
    const msg = sys.logger.warnCalls.map(c => JSON.stringify(c)).join(' ');
    expect(msg).to.match(/doneWhen/i);
  });

  it('accepts a goal with a valid file_exists doneWhen', () => {
    const sys = mkSystem();
    const goal = sys.addGoal({
      description: 'Produce the correlation view sketch',
      doneWhen: {
        version: 1,
        criteria: [{ type: 'file_exists', path: 'correlation-view.md' }]
      }
    });
    expect(goal).to.not.equal(null);
    expect(goal.doneWhen).to.be.an('object');
    expect(goal.progress).to.equal(0);
  });

  it('rejects a vague judged criterion', () => {
    const sys = mkSystem();
    const goal = sys.addGoal({
      description: 'Think deeply about the void',
      doneWhen: { version: 1, criteria: [{ type: 'judged', criterion: 'it is done' }] }
    });
    expect(goal).to.equal(null);
  });
});

describe('progress computed from doneWhen', () => {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');

  it('flips to completed when all criteria satisfied', async () => {
    const sys = mkSystem();
    const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-'));
    sys.setDoneWhenEnv({ outputsDir, memory: { nodes: new Map() } });

    const goal = sys.addGoal({
      description: 'Write the correlation view sketch',
      doneWhen: { version: 1, criteria: [{ type: 'file_exists', path: 'correlation.md' }] }
    });
    expect(goal).to.not.equal(null);
    expect(goal.progress).to.equal(0);

    fs.writeFileSync(path.join(outputsDir, 'correlation.md'), '# ok');
    await sys.refreshProgressFromDoneWhen();

    const g = sys.getGoal(goal.id);
    expect(g.progress).to.equal(1);
    expect(g.status).to.equal('completed');
  });

  it('latches completed — verifier does not revert after file deleted', async () => {
    const sys = mkSystem();
    const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'closer-'));
    sys.setDoneWhenEnv({ outputsDir, memory: { nodes: new Map() } });
    const goal = sys.addGoal({
      description: 'Write the correlation view sketch',
      doneWhen: { version: 1, criteria: [{ type: 'file_exists', path: 'x.md' }] }
    });
    const f = path.join(outputsDir, 'x.md');
    fs.writeFileSync(f, 'x');
    await sys.refreshProgressFromDoneWhen();
    expect(sys.getGoal(goal.id).status).to.equal('completed');
    fs.unlinkSync(f);
    await sys.refreshProgressFromDoneWhen();
    expect(sys.getGoal(goal.id).status).to.equal('completed'); // still
  });
});
