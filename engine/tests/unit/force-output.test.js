const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const {
  checkAndMaybeTrigger,
  buildDigestGoal,
  pickHighSignalNodes,
  countRecentOutputs,
} = require('../../src/goals/force-output');

function tmpDir(prefix = 'force-output-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkMemory(nodes) {
  const m = new Map();
  nodes.forEach(n => m.set(n.id, n));
  return { nodes: m };
}

function mkGoals() {
  const added = [];
  return {
    addGoal(data) {
      const g = { id: `goal_fake_${added.length + 1}`, ...data };
      added.push(g);
      return g;
    },
    _added: added,
  };
}

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('force-output.pickHighSignalNodes', () => {
  it('ranks answer-tagged nodes highest', () => {
    const memory = mkMemory([
      { id: 1, tag: 'curiosity', activation: 0.9, concept: 'high act but not an answer' },
      { id: 2, tag: 'resolved:pipeline', activation: 0.3, concept: 'answer A' },
      { id: 3, tag: 'finding', activation: 0.4, concept: 'answer B' },
    ]);
    const picks = pickHighSignalNodes(memory, 3);
    expect(picks.map(p => p.id)).to.include.members([2, 3]);
    expect(picks[0].score).to.be.greaterThan(picks[2].score);
  });

  it('returns empty for memory with no tagged nodes', () => {
    const memory = mkMemory([{ id: 1, tag: 'curiosity', activation: 0 }]);
    const picks = pickHighSignalNodes(memory, 5);
    expect(picks).to.have.length(0);
  });
});

describe('force-output.buildDigestGoal', () => {
  it('embeds node ids + tags in the description', () => {
    const goal = buildDigestGoal({
      cycle: 777,
      nodes: [
        { id: 42, tag: 'resolved:x', concept: 'alpha finding', score: 1 },
        { id: 99, tag: 'finding', concept: 'beta insight', score: 0.9 },
      ],
      surfaces: { 'RECENT.md': 'yesterday the pipe was broken' }
    });
    expect(goal.description).to.match(/#42/);
    expect(goal.description).to.match(/#99/);
    expect(goal.description).to.match(/what we don't know yet/i);
    expect(goal.doneWhen.criteria[0].type).to.equal('file_exists');
    expect(goal.doneWhen.criteria[0].path).to.match(/digest-777\.md/);
    expect(goal.source.origin).to.equal('force-output');
  });
});

describe('force-output.countRecentOutputs', () => {
  it('counts files with mtime > since', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.md'), 'x');
    fs.writeFileSync(path.join(dir, 'b.md'), 'x');
    const since = Date.now() - 60_000;
    expect(countRecentOutputs(dir, since)).to.equal(2);
  });

  it('returns 0 for non-existent dir', () => {
    expect(countRecentOutputs('/no/such/dir', Date.now())).to.equal(0);
  });
});

describe('force-output.checkAndMaybeTrigger', () => {
  it('triggers when N cycles elapse without a fresh output AND material exists', async () => {
    const outputsDir = tmpDir();
    const workspaceDir = tmpDir('ws-');
    fs.writeFileSync(path.join(workspaceDir, 'RECENT.md'), 'recent context');
    const memory = mkMemory([
      { id: 10, tag: 'finding', activation: 0.7, concept: 'finding 1' },
      { id: 11, tag: 'resolved:x', activation: 0.5, concept: 'finding 2' }
    ]);
    const goals = mkGoals();
    const state = { lastOutputCycle: 0, lastOutputCheckTime: Date.now() - 60_000 };
    const r = await checkAndMaybeTrigger({
      outputsDir, workspaceDir, memory, goals,
      cycle: 100, state, config: { everyNCycles: 100 }, logger
    });
    expect(r.triggered).to.equal(true);
    expect(goals._added).to.have.length(1);
    expect(goals._added[0].description).to.include('digest-100');
  });

  it('skips (does not fire) when no high-signal material exists', async () => {
    const outputsDir = tmpDir();
    const memory = mkMemory([
      { id: 10, tag: 'curiosity', activation: 0, concept: 'vague idea' }
    ]);
    const goals = mkGoals();
    const r = await checkAndMaybeTrigger({
      outputsDir, memory, goals,
      cycle: 100, state: { lastOutputCycle: 0 },
      config: { everyNCycles: 100 }, logger
    });
    expect(r.triggered).to.equal(false);
    expect(r.skipped).to.equal(true);
    expect(goals._added).to.have.length(0);
  });

  it('resets counter when a fresh file lands in outputs/', async () => {
    const outputsDir = tmpDir();
    fs.writeFileSync(path.join(outputsDir, 'shipped.md'), 'x');
    const memory = mkMemory([{ id: 10, tag: 'finding', activation: 0.9, concept: 'x' }]);
    const goals = mkGoals();
    const r = await checkAndMaybeTrigger({
      outputsDir, memory, goals,
      cycle: 500, state: { lastOutputCheckTime: Date.now() - 60_000 },
      config: { everyNCycles: 100 }, logger
    });
    expect(r.triggered).to.equal(false);
    expect(r.reason).to.equal('fresh-output');
    expect(r.state.lastOutputCycle).to.equal(500);
  });

  it('does nothing under the threshold', async () => {
    const outputsDir = tmpDir();
    const memory = mkMemory([{ id: 10, tag: 'finding', activation: 1, concept: 'x' }]);
    const goals = mkGoals();
    const r = await checkAndMaybeTrigger({
      outputsDir, memory, goals,
      cycle: 5, state: { lastOutputCycle: 0 },
      config: { everyNCycles: 100 }, logger
    });
    expect(r.triggered).to.equal(false);
    expect(r.reason).to.equal('under-threshold');
  });

  it('respects disabled config', async () => {
    const outputsDir = tmpDir();
    const memory = mkMemory([{ id: 10, tag: 'finding', activation: 1, concept: 'x' }]);
    const goals = mkGoals();
    const r = await checkAndMaybeTrigger({
      outputsDir, memory, goals,
      cycle: 500, state: { lastOutputCycle: 0 },
      config: { enabled: false, everyNCycles: 100 }, logger
    });
    expect(r.triggered).to.equal(false);
    expect(r.reason).to.equal('disabled');
  });
});
