'use strict';

/**
 * Write-first close, persisted operator notes, leftover engine limits.
 *
 * hunter-glm-1 harvested for 14 cycles with 104 source receipts and 380
 * tape entries, then closed nothing: no markdown writeup, no findings.
 * These tests lock the product law that cut was missing.
 */

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  listWriteups,
  hasPhaseWriteup,
  isHiddenDumpPath,
  buildHarvestDigest,
  isProductDrillRunning,
  shouldHonorLeftoverEngineLimits,
  readPersistedNotes
} = require('../../src/drill/writeup-gate');
const {
  WRITE_NUDGE_AFTER_TURNS,
  WRITE_NUDGE_TAIL_TURNS,
  writeNudgeMessage,
  LaunchLoop
} = require('../../src/agent/loop');
const { executeTool } = require('../../src/agent/tools');
const { RESEARCH_PRODUCT_LOOP } = require('../../../lib/research-launch');
const { shouldHonorLeftoverEngineLimits: leftoverFromOrchestrator } = require('../../src/core/orchestrator');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tempRuntime(prefix = 'cosmo-write-first-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Writeup gate', () => {
  it('counts markdown under outputs/ and ignores tapes, journals, and /tmp dumps', () => {
    const runtimePath = tempRuntime();
    fs.mkdirSync(path.join(runtimePath, 'outputs', 'candidates'), { recursive: true });
    fs.writeFileSync(path.join(runtimePath, 'outputs', 'stream.jsonl'), '{}\n');
    fs.writeFileSync(path.join(runtimePath, 'outputs', 'sources.jsonl'), '{}\n');
    fs.writeFileSync(path.join(runtimePath, 'outputs', 'candidates', 'findings.jsonl'), '{}\n');
    fs.writeFileSync(path.join(runtimePath, 'outputs', 'report.md'), '# Report\nA real writeup.');
    const hidden = path.join(os.tmpdir(), `not-a-writeup-${Date.now()}.md`);
    fs.writeFileSync(hidden, '# Hidden\n');

    expect(hasPhaseWriteup(runtimePath)).to.equal(true);
    expect(listWriteups(runtimePath)).to.include('outputs/report.md');
    expect(listWriteups(runtimePath).some((file) => file.includes('stream.jsonl'))).to.equal(false);
    expect(isHiddenDumpPath(hidden)).to.equal(true);
    expect(isHiddenDumpPath(path.join(runtimePath, 'outputs', 'report.md'))).to.equal(false);
  });

  it('builds a short harvest digest from this phase\'s stream', () => {
    const runtimePath = tempRuntime();
    fs.mkdirSync(path.join(runtimePath, 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(runtimePath, 'outputs', 'stream.jsonl'), [
      JSON.stringify({ kind: 'harvest', content: 'Fetched via curl: https://archive.org/details/gd1972', goalNumber: 1, phaseNumber: 1 }),
      JSON.stringify({ kind: 'finding', content: 'Wembley soundboard exists', goalNumber: 1, phaseNumber: 1 }),
      JSON.stringify({ kind: 'harvest', content: 'Other phase noise', goalNumber: 1, phaseNumber: 2 })
    ].join('\n') + '\n');

    const digest = buildHarvestDigest(runtimePath, { goalNumber: 1, phaseNumber: 1 });
    expect(digest).to.include('Fetched via curl');
    expect(digest).to.include('Wembley soundboard');
    expect(digest).to.not.include('Other phase noise');
  });

  it('reads every persisted operator note — not a one-shot consume', async () => {
    const runtimePath = tempRuntime();
    const notesPath = path.join(runtimePath, 'drill', 'notes.jsonl');
    fs.mkdirSync(path.join(runtimePath, 'drill'), { recursive: true });
    fs.writeFileSync(notesPath, [
      JSON.stringify({ id: 'n1', text: 'Stay on 1973' }),
      JSON.stringify({ id: 'n2', text: 'Prefer primary sources' })
    ].join('\n') + '\n');

    const first = await readPersistedNotes(notesPath);
    const second = await readPersistedNotes(notesPath);
    expect(first.map((note) => note.text)).to.deep.equal(['Stay on 1973', 'Prefer primary sources']);
    expect(second.map((note) => note.text)).to.deep.equal(first.map((note) => note.text));
  });
});

describe('Leftover engine limits cannot stop a product drill', () => {
  it('skips leftover maxCycles/maxRuntime while the drill is running', () => {
    const runningDrill = {
      launchLoop: {
        running: true,
        productLoop: RESEARCH_PRODUCT_LOOP,
        budgetExhaustedReason: () => null
      }
    };
    expect(isProductDrillRunning(runningDrill)).to.equal(true);
    expect(shouldHonorLeftoverEngineLimits(runningDrill)).to.equal(false);
    expect(leftoverFromOrchestrator(runningDrill)).to.equal(false);
  });

  it('honors leftover limits when no product drill is running', () => {
    expect(shouldHonorLeftoverEngineLimits({})).to.equal(true);
    expect(shouldHonorLeftoverEngineLimits({
      launchLoop: { running: false, productLoop: RESEARCH_PRODUCT_LOOP, budgetExhaustedReason: () => 'cycles_exhausted' }
    })).to.equal(true);
    expect(shouldHonorLeftoverEngineLimits({
      launchLoop: { running: true, productLoop: 'interactive' }
    })).to.equal(true);
  });

  it('the orchestrator loop wires the leftover-limit skip', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/core/orchestrator.js'), 'utf8');
    expect(source).to.include('shouldHonorLeftoverEngineLimits(this) && maxCycles');
    expect(source).to.include('shouldHonorLeftoverEngineLimits(this) && maxRuntimeMinutes');
    expect(source).to.include('The drill owns cycles and time while it is running');
  });
});

describe('Research worker write nudges', () => {
  it('nudges after ~6 turns and in the last 5 turns: stop fetching, write, remember, finish', () => {
    expect(WRITE_NUDGE_AFTER_TURNS).to.equal(6);
    expect(WRITE_NUDGE_TAIL_TURNS).to.equal(5);
    expect(writeNudgeMessage(3, 24)).to.include('Continue. Use tools');
    expect(writeNudgeMessage(6, 24)).to.include('Stop fetching');
    expect(writeNudgeMessage(20, 24)).to.include('write_file a markdown writeup');
    expect(writeNudgeMessage(1, 5)).to.include('remember() the findings');
  });

  it('the live worker loop injects the write nudge after six harvest turns', async () => {
    const runtimePath = tempRuntime();
    const loop = new LaunchLoop({
      logger,
      plan: { shortPlan: { goal: 'Write first', constraints: [], deliverable: 'Write it.' } },
      config: { models: { primary: 'test' }, logsDir: runtimePath },
      maxTurns: 8,
      client: {
        createCompletion: async () => ({
          choices: [{ message: { role: 'assistant', content: 'still fetching' } }]
        })
      }
    });

    loop.start();
    await loop._promise;

    const nudges = loop.messages.filter((msg) => msg.role === 'user' && String(msg.content).includes('Stop fetching'));
    expect(nudges.length).to.be.greaterThan(0);
    expect(loop.turns).to.equal(8);
  });
});

describe('finish refuses tape-only and /tmp-only closes', () => {
  it('refuses finish when the only markdown lives in /tmp', async () => {
    const runtimePath = tempRuntime();
    const loop = {
      evidence: { streamed: 2 },
      finished: false,
      markFinished(summary) { this.finished = true; this.summary = summary; }
    };
    fs.writeFileSync(path.join(os.tmpdir(), `phase-dump-${Date.now()}.md`), '# tmp\n');
    const refused = await executeTool('finish', { summary: 'dumped' }, { runtimePath, logger, loop });
    const payload = JSON.parse(refused);
    expect(payload.reason).to.equal('missing_writeup');
    expect(loop.finished).to.equal(false);
  });
});
