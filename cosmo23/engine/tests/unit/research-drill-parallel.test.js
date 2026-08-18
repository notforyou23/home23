'use strict';

/**
 * Parallel phases contract.
 *
 * A goal's open phases run in parallel — one worker per phase, the proven
 * tool loop as the bit, up to the concurrency cap. The coordinator assigns
 * phases, merges results when a goal completes, and invents the next goal.
 * Cycles/time bound the WHOLE drill, not each worker. A slow worker never
 * starves its siblings. Worker finish completes a phase, not the drill.
 * Brain writes keep goal/phase/worker provenance under interleaved bits.
 */

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DrillLoop } = require('../../src/drill/drill-loop');
const { DrillCoordinator } = require('../../src/drill/coordinator');
const { executeTool } = require('../../src/agent/tools');
const { AUTH_REVOKED_WATCH_MESSAGE } = require('../../../lib/auth-error');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tempRuntime(prefix = 'cosmo-drill-par-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/** Three-phase goals so parallelism is observable; merge + chain scripted. */
function threePhaseClient({ captureMergeUser } = {}) {
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
                  { title: `L${goalCount} search`, mission: `Search level ${goalCount}` },
                  { title: `L${goalCount} verify`, mission: `Verify level ${goalCount}` },
                  { title: `L${goalCount} writeup`, mission: `Write up level ${goalCount}` }
                ]
              })
            }
          }]
        };
      }
      if (/merge their results/i.test(system)) {
        if (captureMergeUser) captureMergeUser(messages?.[1]?.content || '');
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summary: `Merged level ${goalCount}: three lanes agree, one venue disputed.`,
                gaps: ['origin of the disputed venue']
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
 * Scripted bit with observable concurrency: records how many siblings were
 * in flight when it started, journals one candidate through the real
 * remember tool (carrying its own drill provenance), and finishes its phase.
 * options.holdPhase lets one phase's worker hang until released.
 */
function concurrencyWorkerFactory(runtimePath, { holdPhase = null, expectParallel = 1 } = {}) {
  const spawned = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let startedCount = 0;
  const hold = deferred();
  // Latch: the first wave's bits wait until expectParallel of them are in
  // flight, so overlap is observable regardless of scheduling speed. A drill
  // that launches fewer than expected hangs here and fails by timeout.
  const latch = deferred();
  const factory = (args) => {
    const worker = {
      drill: args.drill,
      plan: args.plan,
      turns: 0,
      running: false,
      started: false,
      finished: false,
      finishSummary: null,
      fatalError: null,
      concurrentAtStart: 0,
      _promise: null,
      start() {
        this.running = true;
        this.started = true;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        this.concurrentAtStart = inFlight;
        startedCount += 1;
        if (startedCount >= expectParallel) latch.resolve();
        this._promise = (async () => {
          this.turns = 2;
          await latch.promise;
          // Yield so sibling launches can interleave before completion.
          await new Promise((resolve) => setImmediate(resolve));
          if (holdPhase && this.drill.phaseNumber === holdPhase) {
            await hold.promise; // this bit is slow — siblings must not wait
          }
          await executeTool('remember', {
            content: `Finding from ${this.drill.workerId} (goal ${this.drill.goalNumber} phase ${this.drill.phaseNumber})`
          }, { runtimePath, logger, loop: this });
          this.finished = true;
          this.finishSummary = `Wrote outputs/g${this.drill.goalNumber}p${this.drill.phaseNumber}.md`;
          inFlight -= 1;
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
  factory.stats = () => ({ inFlight, maxInFlight });
  factory.release = () => hold.resolve();
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

function makeDrill({ runtimePath, client, createWorker, cycles = 6, maxConcurrent = 3, orchestrator } = {}) {
  const orch = orchestrator || makeOrchestrator(runtimePath);
  const drill = new DrillLoop({
    orchestrator: orch,
    logger,
    client: client || threePhaseClient(),
    createWorker,
    config: {
      logsDir: runtimePath,
      models: { primary: 'test-primary', fast: 'test-fast' },
      drill: { cycles, workerTurnsPerCycle: 6, maxConcurrent }
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

describe('Parallel phases: one worker per open phase', () => {
  let runtimePath;

  beforeEach(() => {
    runtimePath = tempRuntime();
  });

  it('a goal\'s open phases run at the same time, capped by maxConcurrent', async function () {
    this.timeout(10000);
    const createWorker = concurrencyWorkerFactory(runtimePath, { expectParallel: 3 });
    const drill = makeDrill({ runtimePath, createWorker, cycles: 3, maxConcurrent: 3 });

    drill.start();
    await drill._promise;

    // All three phases of goal 1 were in flight together.
    expect(createWorker.stats().maxInFlight).to.equal(3);
    expect(createWorker.spawned).to.have.length(3);
    const phases = createWorker.spawned.map((worker) => worker.drill.phaseNumber).sort();
    expect(phases).to.deep.equal([1, 2, 3]);
    // Each bit's mission names its parallel siblings and warns against
    // duplicating their work.
    const third = createWorker.spawned[2];
    expect(JSON.stringify(third.plan)).to.include('Phases running in parallel right now');
    expect(JSON.stringify(third.plan)).to.include('do not duplicate their work');
  });

  it('the concurrency cap is respected', async function () {
    this.timeout(10000);
    const createWorker = concurrencyWorkerFactory(runtimePath, { expectParallel: 2 });
    const drill = makeDrill({ runtimePath, createWorker, cycles: 6, maxConcurrent: 2 });

    drill.start();
    await drill._promise;

    expect(createWorker.stats().maxInFlight).to.equal(2);
  });

  it('one slow worker cannot starve the others — siblings finish while it hangs', async function () {
    this.timeout(10000);
    const createWorker = concurrencyWorkerFactory(runtimePath, { holdPhase: 1, expectParallel: 3 });
    const drill = makeDrill({ runtimePath, createWorker, cycles: 3, maxConcurrent: 3 });

    drill.start();

    // Wait until the two free siblings settled while phase 1 still hangs.
    await new Promise((resolve) => {
      const check = () => {
        const settled = createWorker.spawned.filter((worker) => worker.finished).length;
        if (settled >= 2) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    const held = createWorker.spawned.find((worker) => worker.drill.phaseNumber === 1);
    expect(held.finished).to.equal(false);
    expect(held.running).to.equal(true);
    const goalPhases = drill.currentGoal.phases;
    expect(goalPhases.find((phase) => phase.number === 2).status).to.equal('done');
    expect(goalPhases.find((phase) => phase.number === 3).status).to.equal('done');
    expect(goalPhases.find((phase) => phase.number === 1).status).to.equal('active');

    // Release the slow bit; the drill completes the goal and ends on budget.
    createWorker.release();
    await drill._promise;
    expect(drill.mode).to.equal('done');
    expect(goalPhases.find((phase) => phase.number === 1).status).to.equal('done');
  });

  it('cycles bound the WHOLE drill, not each worker: exactly N descents across parallel waves', async function () {
    this.timeout(10000);
    const createWorker = concurrencyWorkerFactory(runtimePath, { expectParallel: 3 });
    const drill = makeDrill({ runtimePath, createWorker, cycles: 5, maxConcurrent: 3 });

    drill.start();
    await drill._promise;

    expect(createWorker.spawned).to.have.length(5);
    expect(drill.cyclesUsed).to.equal(5);
    expect(drill.mode).to.equal('done');
    expect(drill.doneReason).to.equal('cycles_exhausted');
    expect(drill._orchestrator.completions[0].reason).to.equal('drill_cycles_exhausted');
  });

  it('the coordinator merges parallel phase results and the merge feeds the next goal', async function () {
    this.timeout(10000);
    const mergeUsers = [];
    const goalUsers = [];
    const client = threePhaseClient({ captureMergeUser: (user) => mergeUsers.push(user) });
    const inner = client.createCompletion.bind(client);
    client.createCompletion = async (args) => {
      const system = args.messages?.[0]?.content || '';
      if (/define research goals/i.test(system)) goalUsers.push(args.messages?.[1]?.content || '');
      return inner(args);
    };
    const createWorker = concurrencyWorkerFactory(runtimePath, { expectParallel: 3 });
    const drill = makeDrill({ runtimePath, createWorker, client, cycles: 6, maxConcurrent: 3 });

    drill.start();
    await drill._promise;

    // Goal 1's three phases were merged...
    expect(mergeUsers.length).to.be.at.least(1);
    expect(mergeUsers[0]).to.include('Phase results:');
    expect(mergeUsers[0]).to.include('g1p1.md');
    expect(mergeUsers[0]).to.include('g1p2.md');
    expect(mergeUsers[0]).to.include('g1p3.md');

    // ...and the merged summary fed the invention of goal 2.
    const goal2Prompt = goalUsers[1] || '';
    expect(goal2Prompt).to.include('Merged result of the completed goal');
    expect(goal2Prompt).to.include('three lanes agree');

    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const merged = progress.filter((entry) => entry.type === 'goal_merged');
    expect(merged.length).to.be.at.least(1);
    expect(merged[0].summary).to.include('three lanes agree');
    // Merge happens between goal completion and next-goal creation.
    const types = progress.map((entry) => entry.type);
    const mergeIndex = types.indexOf('goal_merged');
    const completeIndex = types.indexOf('goal_completed');
    const nextGoalIndex = types.indexOf('goal_created', types.indexOf('goal_created') + 1);
    expect(mergeIndex).to.be.lessThan(completeIndex + 1);
    expect(nextGoalIndex).to.be.greaterThan(completeIndex);
  });

  it('Brain writes keep goal/phase/worker provenance under interleaved parallel bits', async function () {
    this.timeout(10000);
    const createWorker = concurrencyWorkerFactory(runtimePath, { expectParallel: 3 });
    const drill = makeDrill({ runtimePath, createWorker, cycles: 3, maxConcurrent: 3 });

    drill.start();
    await drill._promise;

    const memory = drill._orchestrator.memory;
    const findingNodes = memory.added.filter((node) => node.tag === 'drill_finding');
    expect(findingNodes).to.have.length(3);
    const provenance = findingNodes.map((node) => node.metadata).sort((a, b) => a.phaseNumber - b.phaseNumber);
    for (const meta of provenance) {
      expect(meta.source).to.equal('drill');
      expect(meta.workerId).to.match(/^w\d+$/);
      expect(meta.goalNumber).to.equal(1);
    }
    // Three different workers, three different phases — no provenance was
    // flattened onto whichever bit settled last.
    expect(new Set(provenance.map((meta) => meta.workerId)).size).to.equal(3);
    expect(provenance.map((meta) => meta.phaseNumber)).to.deep.equal([1, 2, 3]);
    // The provenance came from each candidate row itself.
    const candidates = readJsonl(path.join(runtimePath, 'outputs', 'candidates', 'findings.jsonl'));
    for (const candidate of candidates) {
      expect(candidate.workerId).to.match(/^w\d+$/);
      expect(candidate.phaseNumber).to.be.a('number');
    }
  });

  it('a fatal 401 in one bit stops the drill AND its sibling bits', async function () {
    this.timeout(10000);
    const stopped = [];
    const hold = deferred();
    const factory = (args) => {
      const worker = {
        drill: args.drill,
        plan: args.plan,
        turns: 1,
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
            if (this.drill.phaseNumber === 2) {
              this.fatalError = AUTH_REVOKED_WATCH_MESSAGE;
              this.running = false;
              return;
            }
            await hold.promise; // siblings hang until stopped
            this.running = false;
          })();
          return { started: true };
        },
        stop() {
          stopped.push(this.drill.workerId);
          this.running = false;
          hold.resolve();
        }
      };
      return worker;
    };
    const drill = makeDrill({ runtimePath, createWorker: factory, cycles: 9, maxConcurrent: 3 });

    drill.start();
    await drill._promise;

    expect(drill.fatalError).to.equal(AUTH_REVOKED_WATCH_MESSAGE);
    expect(drill.mode).to.equal('error');
    // The hanging siblings were told to stop.
    expect(stopped.length).to.be.at.least(1);
  });

  it('the board state shows multiple workers in flight', async function () {
    this.timeout(10000);
    const createWorker = concurrencyWorkerFactory(runtimePath, { holdPhase: 1, expectParallel: 3 });
    const drill = makeDrill({ runtimePath, createWorker, cycles: 6, maxConcurrent: 3 });

    drill.start();
    // Snapshot while the held bit keeps phase 1 in flight.
    await new Promise((resolve) => {
      const check = () => (drill.activeWorkers.size >= 1 ? resolve() : setTimeout(check, 5));
      check();
    });
    const snapshot = drill.snapshot();
    expect(snapshot.maxConcurrent).to.equal(3);
    expect(snapshot.activeWorkers.length).to.be.at.least(1);
    for (const worker of snapshot.activeWorkers) {
      expect(worker.workerId).to.match(/^w\d+$/);
      expect(worker.phaseTitle).to.be.a('string');
    }
    const activePhases = snapshot.goal.phases.filter((phase) => phase.workerId);
    expect(activePhases.length).to.be.at.least(1);

    createWorker.release();
    await drill._promise;
  });
});

describe('Coordinator (Principal-shaped, not a desk panel)', () => {
  it('assigns open phases to free slots deterministically', () => {
    const coordinator = new DrillCoordinator({ logger });
    const phases = [{ number: 1 }, { number: 2 }, { number: 3 }];
    expect(coordinator.assignPhases(phases, 2)).to.deep.equal([{ number: 1 }, { number: 2 }]);
    expect(coordinator.assignPhases(phases, 0)).to.deep.equal([]);
    expect(coordinator.assignPhases([], 3)).to.deep.equal([]);
  });

  it('never composes review-what-is-already-here goals; degraded merge is honest concatenation', async () => {
    const coordinator = new DrillCoordinator({
      logger,
      config: { models: { fast: 'test' } },
      client: {
        async createCompletion() {
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  title: 'Bad goal',
                  phases: [{ title: 'Inventory', mission: 'Review what is already here before doing any research.' }]
                })
              }
            }]
          };
        }
      }
    });
    const { spec, degraded } = await coordinator.composeGoal({
      question: 'Q', questionContext: '', goalHistory: [], number: 1, origin: 'seed'
    });
    expect(degraded).to.equal(true);
    expect(JSON.stringify(spec).toLowerCase()).to.not.include('review what is already here');

    const merge = await new DrillCoordinator({ logger }).mergeGoal({
      number: 1,
      title: 'G',
      phases: [
        { number: 1, title: 'A', summary: 'found alpha' },
        { number: 2, title: 'B', summary: 'found beta' }
      ]
    });
    expect(merge.degraded).to.equal(true);
    expect(merge.summary).to.include('found alpha');
    expect(merge.summary).to.include('found beta');
  });
});

describe('The control center shows the parallel drill', () => {
  const publicDir = path.join(__dirname, '../../../public');

  it('the board renders workers in flight, not one lonely bit', () => {
    const indexSource = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    expect(indexSource).to.include('id="worker-strip"');
    const appSource = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    expect(appSource).to.include('renderWorkers');
    expect(appSource).to.include('activeWorkers');
    expect(appSource).to.include('workers in flight');
    expect(appSource).to.include('phase-worker-chip');
  });
});
