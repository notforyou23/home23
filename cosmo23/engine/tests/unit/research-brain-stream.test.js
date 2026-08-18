'use strict';

/**
 * Disk is the tape; the Brain reads the tape.
 *
 * Nothing stays boxed in the LLM turn, the console, or a chat bubble:
 * - EVERY successful fetch leaves a Sources receipt — web_search hits,
 *   curl/scripts via run_command, coding_run against a URL, and harvested
 *   material written into outputs/. Search is one tool, not the research.
 * - The Brain gets the working stream as it happens: goals, phase
 *   starts/closes, worker thoughts, harvests, offshoots, findings — not a
 *   highlight reel, not wait-until-remember.
 * - A phase completing without remember() is fine IF the stream already
 *   wrote. Hidden work with nothing in the Brain is the failure.
 * - The desk sees the stream, not only candidates/findings.jsonl.
 */

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { executeTool } = require('../../src/agent/tools');
const { LaunchLoop } = require('../../src/agent/loop');
const { DrillLoop } = require('../../src/drill/drill-loop');
const { writeBrainStream } = require('../../src/agent/brain-stream');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tempRuntime(prefix = 'cosmo-stream-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function makeMemory() {
  const added = [];
  return {
    added,
    async addNode(concept, tag, embedding, metadata) {
      added.push({ concept, tag, metadata });
      return { id: `node_${added.length}` };
    }
  };
}

function workerContext(runtimePath, { memory = null, loop } = {}) {
  return {
    runtimePath,
    logger,
    orchestrator: { logsDir: runtimePath, ...(memory ? { memory } : {}) },
    loop: loop !== undefined
      ? loop
      : { drill: { cycle: 7, workerId: 'w7', goalNumber: 2, phaseNumber: 1 } }
  };
}

function sourcesAt(runtimePath) {
  return readJsonl(path.join(runtimePath, 'outputs', 'sources.jsonl'));
}

function streamAt(runtimePath) {
  return readJsonl(path.join(runtimePath, 'outputs', 'stream.jsonl'));
}

describe('Every successful fetch leaves a Sources receipt — search is one tool, not the research', () => {
  it('a run_command fetch of a URL leaves a receipt, a stream entry, and a Brain node', async () => {
    const runtimePath = tempRuntime();
    const memory = makeMemory();
    const context = workerContext(runtimePath, { memory });

    const result = await executeTool('run_command', {
      command: 'echo fetched https://old.reddit.com/r/gratefuldead/top.json'
    }, context);
    expect(result).to.include('fetched');

    const receipts = sourcesAt(runtimePath);
    expect(receipts).to.have.length(1);
    expect(receipts[0].tool).to.equal('run_command');
    expect(receipts[0].urls.join(' ')).to.include('old.reddit.com/r/gratefuldead');
    expect(receipts[0].cycle).to.equal(7);
    expect(receipts[0].workerId).to.equal('w7');
    expect(receipts[0].goalNumber).to.equal(2);
    expect(receipts[0].phaseNumber).to.equal(1);

    const harvest = streamAt(runtimePath).filter((entry) => entry.kind === 'harvest');
    expect(harvest).to.have.length(1);
    expect(harvest[0].content).to.include('run_command');
    expect(harvest[0].workerId).to.equal('w7');
    expect(harvest[0].brain).to.equal('live');
    expect(memory.added.some((node) => node.tag === 'drill_harvest')).to.equal(true);
    expect(context.loop.evidence.streamed).to.equal(1);
  });

  it('a FAILED fetch leaves no receipt — receipts mean the fetch happened', async () => {
    const runtimePath = tempRuntime();
    const context = workerContext(runtimePath);

    const result = await executeTool('run_command', {
      command: 'node -e "process.exit(22)" https://example.com/dead-endpoint'
    }, context);
    expect(result).to.include('Command failed');
    expect(sourcesAt(runtimePath)).to.have.length(0);
    expect(streamAt(runtimePath)).to.have.length(0);
  });

  it('a command that fetches nothing leaves no receipt', async () => {
    const runtimePath = tempRuntime();
    const context = workerContext(runtimePath);
    await executeTool('run_command', { command: 'echo no urls involved here' }, context);
    expect(sourcesAt(runtimePath)).to.have.length(0);
  });

  it('write_file of harvested raw into outputs/ leaves a receipt and streams the harvest', async () => {
    const runtimePath = tempRuntime();
    const memory = makeMemory();
    const context = workerContext(runtimePath, { memory });

    const result = await executeTool('write_file', {
      path: 'raw/reddit-top.json',
      content: '{"source":"https://old.reddit.com/r/gratefuldead/top.json","children":[{"title":"story"}]}'
    }, context);
    expect(result).to.include('File written');

    const receipts = sourcesAt(runtimePath);
    expect(receipts).to.have.length(1);
    expect(receipts[0].tool).to.equal('write_file');
    expect(receipts[0].query).to.equal('outputs/raw/reddit-top.json');
    expect(receipts[0].urls.join(' ')).to.include('old.reddit.com');
    expect(receipts[0].workerId).to.equal('w7');

    const harvest = streamAt(runtimePath).filter((entry) => entry.kind === 'harvest');
    expect(harvest).to.have.length(1);
    expect(harvest[0].content).to.include('outputs/raw/reddit-top.json');
    expect(memory.added.some((node) => node.tag === 'drill_harvest')).to.equal(true);
    expect(context.loop.evidence.streamed).to.equal(1);
  });

  it('a rejected write_file leaves no receipt', async () => {
    const runtimePath = tempRuntime();
    const context = workerContext(runtimePath);
    const result = await executeTool('write_file', {
      path: '../../outside.txt',
      content: 'nope'
    }, context);
    expect(result).to.include('Error');
    expect(sourcesAt(runtimePath)).to.have.length(0);
  });
});

describe('The Brain gets the working stream as it happens', () => {
  it('worker thoughts stream to the tape and the Brain mid-run — not boxed in the LLM turn', async () => {
    const runtimePath = tempRuntime();
    const memory = makeMemory();
    let calls = 0;
    const loop = new LaunchLoop({
      logger,
      orchestrator: { logsDir: runtimePath, memory },
      plan: { shortPlan: { goal: 'Wembley 1972', constraints: [], deliverable: 'Write it.' } },
      config: { models: { primary: 'test' } },
      drill: { cycle: 5, workerId: 'w5', goalNumber: 3, phaseNumber: 2 },
      maxTurns: 4,
      client: {
        createCompletion: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'The 1972 Wembley tapes disagree with the printed setlist — chasing the soundboard copy next.'
                }
              }]
            };
          }
          return {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call_w',
                    function: { name: 'write_file', arguments: JSON.stringify({ path: 'wembley.md', content: '# Wembley\n\nSetlist conflict documented.' }) }
                  },
                  {
                    id: 'call_f',
                    function: { name: 'finish', arguments: JSON.stringify({ summary: 'Setlist conflict documented' }) }
                  }
                ]
              }
            }]
          };
        }
      }
    });

    loop.start();
    await loop._promise;

    // The thought reached the Brain and the tape with full provenance.
    const thoughts = memory.added.filter((node) => node.tag === 'drill_thought');
    expect(thoughts).to.have.length(1);
    expect(thoughts[0].concept).to.include('Wembley tapes disagree');
    expect(thoughts[0].metadata.workerId).to.equal('w5');
    expect(thoughts[0].metadata.goalNumber).to.equal(3);
    const taped = streamAt(runtimePath).filter((entry) => entry.kind === 'thought');
    expect(taped).to.have.length(1);
    expect(taped[0].brain).to.equal('live');

    // Thought is on the tape; the writeup is what lets finish land.
    expect(loop.finished).to.equal(true);
    expect(loop.finishSummary).to.equal('Setlist conflict documented');
  });

  it('remember() findings land on the tape as stream entries too', async () => {
    const runtimePath = tempRuntime();
    const memory = makeMemory();
    await executeTool('remember', { content: 'Garcia sat in with Merl Saunders through 1973.' },
      workerContext(runtimePath, { memory }));

    const taped = streamAt(runtimePath).filter((entry) => entry.kind === 'finding');
    expect(taped).to.have.length(1);
    expect(taped[0].brain).to.equal('live');
    expect(memory.added.filter((node) => node.tag === 'drill_finding')).to.have.length(1);
  });

  it('settle-time harvest promotes only rows the live stream missed — no double Brain writes', async () => {
    const runtimePath = tempRuntime();
    const memory = makeMemory();
    const dir = path.join(runtimePath, 'outputs', 'candidates');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'findings.jsonl'), [
      JSON.stringify({ content: 'already live', brain: 'live', cycle: 1, workerId: 'w1' }),
      JSON.stringify({ content: 'journaled while the Brain was down', brain: 'journaled', cycle: 1, workerId: 'w1' })
    ].join('\n') + '\n');

    const drill = new DrillLoop({
      orchestrator: { logsDir: runtimePath, memory },
      logger,
      config: { logsDir: runtimePath, drill: { cycles: 1 } }
    });
    const harvested = await drill.harvestCandidates();

    expect(harvested).to.equal(2); // both rows were seen...
    const promoted = memory.added.filter((node) => node.tag === 'drill_finding');
    expect(promoted).to.have.length(1); // ...but only the journaled one was promoted
    expect(promoted[0].concept).to.include('Brain was down');
  });

  it('the drill streams its own life: goals, phase starts/closes, offshoots', async function () {
    this.timeout(10000);
    const runtimePath = tempRuntime();
    const memory = makeMemory();
    const orchestrator = {
      logsDir: runtimePath,
      memory,
      _getEvents: () => ({ emitEvent: () => {} }),
      requestRunCompletion: () => true
    };
    let goals = 0;
    const client = {
      async createCompletion({ messages }) {
        const system = messages?.[0]?.content || '';
        if (/define research goals with concrete phases/i.test(system)) {
          goals += 1;
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  title: `Goal ${goals}: dig`,
                  why: 'keep drilling',
                  phases: [{ title: 'Only lane', mission: 'Dig the lane' }]
                })
              }
            }]
          };
        }
        if (/merge their results/i.test(system)) {
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  summary: 'Lane dug.',
                  gaps: ['the disputed venue origin']
                })
              }
            }]
          };
        }
        return { choices: [{ message: { role: 'assistant', content: '{}' } }] };
      }
    };
    const createWorker = (args) => ({
      drill: args.drill,
      plan: args.plan,
      turns: 1,
      running: false,
      started: false,
      finished: false,
      finishSummary: null,
      fatalError: null,
      evidence: { streamed: 0 },
      _promise: null,
      start() {
        this.running = true;
        this.started = true;
        this._promise = (async () => {
          await executeTool('remember', { content: `Found in cycle ${this.drill.cycle}` }, {
            runtimePath, logger, loop: this
          });
          await executeTool('write_file', {
            path: `lane-${this.drill.cycle}.md`,
            content: `# Lane\n\nFound in cycle ${this.drill.cycle}.`
          }, { runtimePath, logger, loop: this });
          this.finished = true;
          this.finishSummary = 'Wrote the lane up';
          this.running = false;
        })();
        return { started: true };
      },
      stop() { this.running = false; }
    });
    const drill = new DrillLoop({
      orchestrator,
      logger,
      client,
      createWorker,
      config: { logsDir: runtimePath, drill: { cycles: 2, maxConcurrent: 1, workerTurnsPerCycle: 4 } },
      plan: { shortPlan: { goal: 'Jerry Garcia anecdotes', constraints: [], deliverable: 'Write it.' } }
    });

    drill.start();
    await drill._promise;

    const kinds = new Set(streamAt(runtimePath).map((entry) => entry.kind));
    expect(kinds.has('goal')).to.equal(true);
    expect(kinds.has('phase')).to.equal(true);
    expect(kinds.has('offshoot')).to.equal(true);
    // The same stream reached the Brain live.
    expect(memory.added.some((node) => node.tag === 'drill_goal')).to.equal(true);
    expect(memory.added.some((node) => node.tag === 'drill_phase')).to.equal(true);
    expect(memory.added.some((node) => node.tag === 'drill_offshoot'
      && node.concept.includes('disputed venue'))).to.equal(true);
    // Offshoot provenance names the goal it branched from.
    const offshoot = streamAt(runtimePath).find((entry) => entry.kind === 'offshoot');
    expect(offshoot.goalNumber).to.equal(1);
  });
});

describe('Hidden work cannot close a phase — anything on the record can', () => {
  function makeOrchestrator(runtimePath) {
    const memory = makeMemory();
    const events = [];
    return {
      logsDir: runtimePath,
      memory,
      events,
      _getEvents: () => ({ emitEvent: (type, payload) => events.push({ type, payload }) }),
      requestRunCompletion: () => true
    };
  }

  function onePhaseClient() {
    let goals = 0;
    return {
      async createCompletion({ messages }) {
        const system = messages?.[0]?.content || '';
        if (/define research goals with concrete phases/i.test(system)) {
          goals += 1;
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  title: `Goal ${goals}: dig`,
                  why: 'keep drilling',
                  phases: [{ title: 'Only lane', mission: 'Dig the lane' }]
                })
              }
            }]
          };
        }
        return { choices: [{ message: { role: 'assistant', content: '{}' } }] };
      }
    };
  }

  function makeDrill(runtimePath, orchestrator, createWorker, cycles) {
    return new DrillLoop({
      orchestrator,
      logger,
      client: onePhaseClient(),
      createWorker,
      config: { logsDir: runtimePath, drill: { cycles, maxConcurrent: 1, workerTurnsPerCycle: 4 } },
      plan: { shortPlan: { goal: 'Jerry Garcia anecdotes', constraints: [], deliverable: 'Write it.' } }
    });
  }

  function fakeWorker(args, body) {
    const worker = {
      drill: args.drill,
      plan: args.plan,
      evidence: { streamed: Number(args.evidence?.streamed) || 0 },
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
          await body(this);
          this.running = false;
        })();
        return { started: true };
      },
      stop() { this.running = false; }
    };
    return worker;
  }

  it('the finish tool refuses a worker with nothing on the record', async () => {
    const runtimePath = tempRuntime();
    const loop = {
      evidence: { streamed: 0 },
      finished: false,
      markFinished(summary) { this.finished = true; this.summary = summary; }
    };
    const refused = await executeTool('finish', { summary: 'trust me' }, { runtimePath, logger, loop });
    const payload = JSON.parse(refused);
    expect(payload.finish).to.equal('refused');
    expect(payload.reason).to.equal('hidden_work');
    expect(loop.finished).to.equal(false);

    // A fetch puts work on the tape, but tape alone still cannot finish.
    await executeTool('run_command', {
      command: 'echo harvested https://archive.org/details/gd1972-wembley'
    }, { runtimePath, logger, loop });
    expect(loop.evidence.streamed).to.equal(1);
    const stillRefused = await executeTool('finish', { summary: 'tape only' }, { runtimePath, logger, loop });
    const missing = JSON.parse(stillRefused);
    expect(missing.finish).to.equal('refused');
    expect(missing.reason).to.equal('missing_writeup');
    expect(loop.finished).to.equal(false);

    await executeTool('write_file', {
      path: 'wembley.md',
      content: '# Wembley\n\nHarvested the 1972 show.'
    }, { runtimePath, logger, loop });
    const done = await executeTool('finish', { summary: 'writeup on disk' }, { runtimePath, logger, loop });
    expect(done).to.include('Research finished');
    expect(loop.finished).to.equal(true);
  });

  it('a worker that claims done with hidden dumps cannot close the phase — the drill refuses the settle', async function () {
    this.timeout(10000);
    const runtimePath = tempRuntime();
    const orchestrator = makeOrchestrator(runtimePath);
    const spawned = [];
    const createWorker = (args) => {
      // Raw files dumped OUTSIDE the harness (e.g. a scraper the worker ran
      // by hand) leave nothing on the record — that is the jerry-garcia-3
      // failure shape.
      const worker = fakeWorker(args, async () => {
        fs.writeFileSync(path.join(runtimePath, 'hidden-dump.json'), '{"raw":true}');
        worker.finished = true;
        worker.finishSummary = 'done (nothing on the record)';
      });
      spawned.push(worker);
      return worker;
    };
    const drill = makeDrill(runtimePath, orchestrator, createWorker, 2);

    drill.start();
    await drill._promise;

    // Both cycles ran the same phase; neither settle was accepted.
    expect(spawned).to.have.length(2);
    expect(drill.currentGoal.phases[0].status).to.not.equal('done');
    expect(drill.currentGoal.phases[0].rejections).to.equal(2);
    expect(drill.goalHistory.filter((goal) => goal.status === 'completed')).to.have.length(0);

    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const rejected = progress.filter((entry) => entry.type === 'cycle_completed' && entry.rejectedReason === 'hidden_work');
    expect(rejected).to.have.length(2);
    for (const entry of rejected) {
      expect(entry.workerFinished).to.equal(true);
      expect(entry.phaseDone).to.equal(false);
    }
    expect(orchestrator.events.some((event) => event.type === 'drill_phase_rejected')).to.equal(true);
    // The relaunched worker was told why.
    expect(JSON.stringify(spawned[1].plan)).to.include('nothing on the record');
  });

  it('a worker whose only record is a curl harvest CANNOT close the phase — writeup required', async function () {
    this.timeout(10000);
    const runtimePath = tempRuntime();
    const orchestrator = makeOrchestrator(runtimePath);
    const createWorker = (args) => fakeWorker(args, async (worker) => {
      await executeTool('run_command', {
        command: 'echo harvested https://archive.org/details/gd1972-wembley'
      }, { runtimePath, orchestrator, logger, loop: worker });
      worker.finished = true;
      worker.finishSummary = 'Harvest receipted and streamed';
    });
    const drill = makeDrill(runtimePath, orchestrator, createWorker, 1);

    drill.start();
    await drill._promise;

    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const settle = progress.find((entry) => entry.type === 'cycle_completed');
    expect(settle.phaseDone).to.equal(false);
    expect(settle.rejectedReason).to.equal('missing_writeup');
    // The harvest is still on every surface: receipt, tape, Brain.
    expect(sourcesAt(runtimePath)[0].tool).to.equal('run_command');
    expect(streamAt(runtimePath).some((entry) => entry.kind === 'harvest')).to.equal(true);
    expect(orchestrator.memory.added.some((node) => node.tag === 'drill_harvest')).to.equal(true);
  });

  it('evidence carries across cycles of the same phase — an earlier descent\'s record lets a later one close', async function () {
    this.timeout(10000);
    const runtimePath = tempRuntime();
    const orchestrator = makeOrchestrator(runtimePath);
    let descents = 0;
    const createWorker = (args) => {
      descents += 1;
      const isFirst = descents === 1;
      return fakeWorker(args, async (worker) => {
        if (isFirst) {
          // First descent puts work on the record but runs out of turns.
          await executeTool('remember', { content: 'Half the lane dug.' }, { runtimePath, logger, loop: worker });
          worker.finished = false;
        } else {
          // Second descent writes the missing writeup, then closes.
          await executeTool('write_file', {
            path: 'half-lane.md',
            content: '# Half the lane\n\nClosed on the earlier record.'
          }, { runtimePath, logger, loop: worker });
          worker.finished = true;
          worker.finishSummary = 'Closed with a writeup';
        }
      });
    };
    const drill = makeDrill(runtimePath, orchestrator, createWorker, 2);

    drill.start();
    await drill._promise;

    const progress = readJsonl(path.join(runtimePath, 'drill', 'progress.jsonl'));
    const settles = progress.filter((entry) => entry.type === 'cycle_completed');
    expect(settles).to.have.length(2);
    expect(settles[0].phaseDone).to.equal(false);
    expect(settles[0].rejectedReason).to.equal(null);
    expect(settles[1].phaseDone).to.equal(true);
    expect(settles[1].rejectedReason).to.equal(null);
  });
});

describe('The desk sees the tape', () => {
  it('the drill status endpoint serves the stream and never lists the tape as a writeup', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '../../../server/index.js'), 'utf8');
    expect(serverSource).to.match(/readJsonlTail\(path\.join\(runPath, 'outputs', 'stream\.jsonl'\)/);
    expect(serverSource).to.include('stream: stream.reverse()');
    expect(serverSource).to.include("entry.name !== 'stream.jsonl'");
  });

  it('the Brain panel renders the working stream, not only remember() candidates', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '../../../public/app.js'), 'utf8');
    expect(appSource).to.include('payload.stream');
    expect(appSource).to.include('stream-kind');
    expect(appSource).to.include('Nothing on the tape yet.');
    // Sources copy no longer implies search-only.
    expect(appSource).to.include('No fetches yet.');
    expect(appSource).to.not.include('No web searches yet.');
  });
});

describe('The tape itself is degraded-honest', () => {
  it('a Brain failure leaves the entry journaled on the tape, never dropped', async () => {
    const runtimePath = tempRuntime();
    const failing = { async addNode() { throw new Error('embedding backend down'); } };
    const result = await writeBrainStream(
      { runtimePath, memory: failing, logger },
      { kind: 'thought', content: 'still worth keeping', workerId: 'w1' }
    );
    expect(result.streamed).to.equal(true);
    expect(result.brain).to.equal('journaled');
    const taped = streamAt(runtimePath);
    expect(taped).to.have.length(1);
    expect(taped[0].brain).to.equal('journaled');
  });

  it('nothing to write is reported, not fabricated', async () => {
    const result = await writeBrainStream({ runtimePath: null }, { kind: 'thought', content: 'x' });
    expect(result.streamed).to.equal(false);
    expect(result.brain).to.equal('skipped');
  });
});
