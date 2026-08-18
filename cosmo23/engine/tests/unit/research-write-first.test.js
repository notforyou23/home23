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
  assessPhaseReceipt,
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
  FORCE_FINISH_AFTER_TURNS,
  writeNudgeMessage,
  LaunchLoop
} = require('../../src/agent/loop');
const { DrillLoop } = require('../../src/drill/drill-loop');
const { executeTool } = require('../../src/agent/tools');
const { toResponsesToolChoice } = require('../../src/core/gpt5-client');
const { RESEARCH_PRODUCT_LOOP } = require('../../../lib/research-launch');

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
    expect(isHiddenDumpPath(hidden, runtimePath)).to.equal(true);
    expect(isHiddenDumpPath(path.join(runtimePath, 'outputs', 'report.md'), runtimePath)).to.equal(false);
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

  it('turns a durable write-now operator note into an immediate write contract', () => {
    const runtimePath = tempRuntime();
    const drill = new DrillLoop({
      orchestrator: { logsDir: runtimePath },
      logger,
      config: { logsDir: runtimePath, drill: { cycles: 1 } },
      plan: { shortPlan: { goal: 'Hunter test', constraints: [] } }
    });
    const phase = {
      number: 1,
      title: 'Partnership evidence',
      mission: 'Land the partnership evidence.',
      status: 'pending',
      cyclesUsed: 0,
      evidence: { streamed: 0 },
      rejections: 0
    };
    const mission = drill.buildPhaseMission(
      { number: 1, title: 'Hunter test', phases: [phase] },
      phase,
      [{ id: 'n1', text: 'write files, remember, close with writeup' }]
    );

    expect(mission.writeFirst).to.equal(true);
    expect(mission.constraints).to.include('Operator note: write files, remember, close with writeup');
  });

  it('does not accept an IN PROGRESS stub as the named phase receipt', async () => {
    const runtimePath = tempRuntime();
    const loop = {
      drill: { goalNumber: 1, phaseNumber: 1 },
      plan: { shortPlan: { expectedOutput: 'outputs/garcia_interview_sources.md' } },
      expectedOutput: 'outputs/garcia_interview_sources.md',
      evidence: { streamed: 1 }
    };
    await executeTool('write_file', {
      path: 'garcia_interview_sources.md',
      content: '# Phase 1: Gather Quotes\n## Status: IN PROGRESS\n## Findings\n(To be populated with verbatim quotes as sources are retrieved)\n## Next Steps\n- Need to find working archive URLs'
    }, { runtimePath, logger, loop });

    expect(assessPhaseReceipt(runtimePath, loop.expectedOutput, {
      goalNumber: 1,
      phaseNumber: 1
    })).to.include({ accepted: false, reason: 'unfinished_receipt' });
  });

  it('does not accept empty findings or an empty in-progress JSON receipt', async () => {
    const markdownRun = tempRuntime();
    const markdownLoop = {
      drill: { goalNumber: 1, phaseNumber: 1 },
      expectedOutput: 'outputs/garcia_partnership.md',
      evidence: { streamed: 1 }
    };
    await executeTool('write_file', {
      path: 'garcia_partnership.md',
      content: '# Garcia and Hunter\n\n## Findings\n\n## Next Steps\n\nSearch the print archive.'
    }, { runtimePath: markdownRun, logger, loop: markdownLoop });
    expect(assessPhaseReceipt(markdownRun, markdownLoop.expectedOutput, {
      goalNumber: 1,
      phaseNumber: 1
    }).accepted).to.equal(false);

    const jsonRun = tempRuntime();
    const jsonLoop = {
      drill: { goalNumber: 1, phaseNumber: 2 },
      expectedOutput: 'outputs/garcia_book_sources.json',
      evidence: { streamed: 1 }
    };
    await executeTool('write_file', {
      path: 'garcia_book_sources.json',
      content: JSON.stringify({ entries: [], status: 'in-progress' })
    }, { runtimePath: jsonRun, logger, loop: jsonLoop });
    expect(assessPhaseReceipt(jsonRun, jsonLoop.expectedOutput, {
      goalNumber: 1,
      phaseNumber: 2
    })).to.include({ accepted: false, reason: 'unfinished_receipt' });
  });

  it('does not let phase-2-progress.md satisfy a different named receipt', async () => {
    const runtimePath = tempRuntime();
    const loop = {
      drill: { goalNumber: 1, phaseNumber: 2 },
      expectedOutput: 'outputs/garcia_book_sources.json',
      evidence: { streamed: 1 }
    };
    await executeTool('write_file', {
      path: 'drill/goal-1/phase-2-progress.md',
      content: '# Source shopping list\n\nStatus: still collecting interviews and print sources.'
    }, { runtimePath, logger, loop });

    expect(assessPhaseReceipt(runtimePath, loop.expectedOutput, {
      goalNumber: 1,
      phaseNumber: 2
    })).to.include({ accepted: false, reason: 'wrong_receipt' });
  });

  it('accepts finished work only at this phase named receipt', async () => {
    const runtimePath = tempRuntime();
    const expectedOutput = 'outputs/garcia_interview_sources.json';
    const wrongPhase = {
      drill: { goalNumber: 1, phaseNumber: 2 },
      expectedOutput,
      evidence: { streamed: 1 }
    };
    await executeTool('write_file', {
      path: 'garcia_interview_sources.json',
      content: JSON.stringify({
        entries: [{ quote: 'We wrote together by talking it through.', source: 'Interview transcript' }],
        status: 'complete'
      })
    }, { runtimePath, logger, loop: wrongPhase });

    expect(assessPhaseReceipt(runtimePath, expectedOutput, {
      goalNumber: 1,
      phaseNumber: 1
    }).accepted).to.equal(false);

    const rightPhase = {
      drill: { goalNumber: 1, phaseNumber: 1 },
      expectedOutput,
      evidence: { streamed: 1 }
    };
    await executeTool('write_file', {
      path: 'garcia_interview_sources.json',
      content: JSON.stringify({
        entries: [{ quote: 'Hunter and I worked by passing pages back and forth.', source: 'Published interview' }],
        status: 'complete'
      })
    }, { runtimePath, logger, loop: rightPhase });
    const accepted = assessPhaseReceipt(runtimePath, expectedOutput, {
      goalNumber: 1,
      phaseNumber: 1
    });
    expect(accepted).to.include({
      accepted: true,
      reason: 'finished_json',
      path: expectedOutput
    });
    expect(accepted.sha256).to.match(/^[a-f0-9]{64}$/);
  });

  it('does not let another phase overwrite satisfy a stale receipt', async () => {
    const runtimePath = tempRuntime();
    const expectedOutput = 'outputs/shared.json';
    await executeTool('write_file', {
      path: 'shared.json',
      content: JSON.stringify({ entries: [], status: 'in-progress' })
    }, {
      runtimePath,
      logger,
      loop: {
        drill: { goalNumber: 1, phaseNumber: 1 },
        expectedOutput,
        evidence: { streamed: 1 }
      }
    });
    await executeTool('write_file', {
      path: 'shared.json',
      content: JSON.stringify({
        entries: [{ quote: 'Finished by the wrong phase.' }],
        status: 'complete'
      })
    }, {
      runtimePath,
      logger,
      loop: {
        drill: { goalNumber: 1, phaseNumber: 2 },
        expectedOutput,
        evidence: { streamed: 1 }
      }
    });

    expect(assessPhaseReceipt(runtimePath, expectedOutput, {
      goalNumber: 1,
      phaseNumber: 1
    })).to.include({ accepted: false, reason: 'receipt_changed' });
  });

  it('does not treat zero counts or explicit incomplete flags as finished JSON', async () => {
    const cases = [
      { findings: [], count: 0, status: 'complete' },
      { findings: ['One draft quote'], complete: false },
      { findings: [], status: 'complete', generatedAt: '2026-08-18T16:00:00Z' },
      { findings: [], status: 'complete', note: 'Source collection was attempted.' },
      { findings: ['One quote'], finished: false },
      { findings: ['One quote'], success: false },
      { findings: ['One quote'], status: 'failed' },
      { findings: ['One quote'], failed: true },
      { findings: ['One quote'], error: 'network failure' }
    ];
    for (const [index, content] of cases.entries()) {
      const runtimePath = tempRuntime();
      const expectedOutput = `outputs/case-${index}.json`;
      await executeTool('write_file', {
        path: `case-${index}.json`,
        content: JSON.stringify(content)
      }, {
        runtimePath,
        logger,
        loop: {
          drill: { goalNumber: 1, phaseNumber: index + 1 },
          expectedOutput,
          evidence: { streamed: 1 }
        }
      });
      expect(assessPhaseReceipt(runtimePath, expectedOutput, {
        goalNumber: 1,
        phaseNumber: index + 1
      }).accepted).to.equal(false);
    }
  });
});

describe('The product drill owns lifecycle limits', () => {
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

  it('the orchestrator returns into the drill lifecycle before legacy cycles run', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/core/orchestrator.js'), 'utf8');
    expect(source).to.include('await this.runProductDrillLifecycle()');
    expect(source).to.include('Product drills own the engine process while they run');
    expect(source).to.include('const launchLoopResult = await this.ensureResearchLaunchLoop()');
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

  it('forces the write stage at the hard turn limit even without streamed evidence', async () => {
    const runtimePath = tempRuntime();
    const calls = [];
    const loop = new LaunchLoop({
      logger,
      plan: { shortPlan: { goal: 'Write first', constraints: [], deliverable: 'Write it.' } },
      config: { models: { primary: 'test' }, logsDir: runtimePath },
      maxTurns: 24,
      client: {
        createCompletion: async options => {
          calls.push(options);
          return {
            choices: [{ message: { role: 'assistant', content: 'still fetching' } }]
          };
        }
      }
    });
    // Keep this fixture tape-free so FORCE_FINISH_AFTER_TURNS, rather than
    // streamed evidence, is what changes the policy.
    loop.streamThought = async () => {};

    loop.start();
    await loop._promise;

    expect(FORCE_FINISH_AFTER_TURNS).to.equal(8);
    expect(loop.turns).to.equal(FORCE_FINISH_AFTER_TURNS);
    expect(calls).to.have.length(FORCE_FINISH_AFTER_TURNS + 1);
    expect(calls.slice(-2).every(call =>
      call.tools.map(tool => tool.function.name).join(',') === 'write_file'
      && call.toolChoice?.function?.name === 'write_file'
    )).to.equal(true);
    expect(loop.getStatus().status).to.equal('error');
    expect(loop.protocolError).to.include('write_file');
  });

  it('adapts an exact Chat Completions function choice for Responses providers', () => {
    expect(toResponsesToolChoice({
      type: 'function',
      function: { name: 'write_file' }
    })).to.deep.equal({
      type: 'function',
      name: 'write_file'
    });
    expect(toResponsesToolChoice('required')).to.equal('required');
  });

  it('retries prose-only required stages with the exact function and never records the prose as work', async () => {
    const runtimePath = tempRuntime();
    const policies = [];
    const attempts = new Map();
    const loop = new LaunchLoop({
      logger,
      plan: {
        shortPlan: {
          goal: 'Land the work',
          constraints: [],
          deliverable: 'Write it.',
          writeupPath: 'drill/goal-1/phase-1-land-the-work.md'
        }
      },
      drill: { goalNumber: 1, phaseNumber: 1, workerId: 'w1', cycle: 1 },
      config: { models: { primary: 'test' }, logsDir: runtimePath },
      maxTurns: 10,
      client: {
        createCompletion: async options => {
          const names = (options.tools || []).map(tool => tool.function.name);
          policies.push({ names, toolChoice: options.toolChoice });
          if (names.length === 1) {
            const attempt = (attempts.get(names[0]) || 0) + 1;
            attempts.set(names[0], attempt);
            if (attempt === 1) {
              return {
                choices: [{
                  message: {
                    role: 'assistant',
                    content: `I drafted the ${names[0]} result but did not call it.`
                  }
                }]
              };
            }
          }
          if (names.length === 1 && names[0] === 'write_file') {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{
                    id: 'forced-write',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        path: 'drill/goal-1/phase-1-land-the-work.md',
                        content: '# Landed finding\n\nThe phase found and recorded a concrete result.'
                      })
                    }
                  }]
                }
              }]
            };
          }
          if (names.length === 1 && names[0] === 'finish') {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{
                    id: 'forced-finish',
                    function: {
                      name: 'finish',
                      arguments: JSON.stringify({ summary: 'Wrote the phase-bound writeup.' })
                    }
                  }]
                }
              }]
            };
          }
          if (names.length === 1 && names[0] === 'remember') {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{
                    id: 'forced-remember',
                    function: {
                      name: 'remember',
                      arguments: JSON.stringify({ content: 'The phase landed a concrete result.' })
                    }
                  }]
                }
              }]
            };
          }
          return { choices: [{ message: { role: 'assistant', content: 'I am writing now.' } }] };
        }
      }
    });

    loop.start();
    await loop._promise;

    expect(policies.some(policy => policy.toolChoice?.function?.name === 'write_file'
      && policy.names.join(',') === 'write_file')).to.equal(true);
    expect(policies.some(policy => policy.toolChoice?.function?.name === 'remember'
      && policy.names.join(',') === 'remember')).to.equal(true);
    expect(policies.some(policy => policy.toolChoice?.function?.name === 'finish'
      && policy.names.join(',') === 'finish')).to.equal(true);
    expect(attempts.get('write_file')).to.equal(2);
    expect(attempts.get('remember')).to.equal(2);
    expect(attempts.get('finish')).to.equal(2);
    expect(loop.messages.some(message =>
      String(message.content).includes('did not call it')
    )).to.equal(false);
    expect(loop.finished).to.equal(true);
    expect(fs.existsSync(path.join(
      runtimePath,
      'outputs',
      'drill',
      'goal-1',
      'phase-1-land-the-work.md'
    ))).to.equal(true);
  });

  it('takes a drafted writeup out of model prose and lands it at the phase path', async () => {
    const runtimePath = tempRuntime();
    const writeupPath = 'drill/goal-3/phase-2-partnership.md';
    const draftedWriteup = [
      '# Garcia partnership',
      '',
      ...Array.from(
        { length: 260 },
        (_, index) => `## Evidence ${index + 1}\n\nDocumented partnership finding ${index + 1} with source context and analysis.`
      )
    ].join('\n');
    const stages = [];
    const loop = new LaunchLoop({
      logger,
      plan: {
        shortPlan: {
          goal: 'Land the partnership paper',
          constraints: [],
          deliverable: 'Write the phase paper.',
          writeupPath,
          writeFirst: true
        }
      },
      drill: { goalNumber: 3, phaseNumber: 2, workerId: 'w10', cycle: 1 },
      config: { models: { primary: 'test' }, logsDir: runtimePath },
      maxTurns: 24,
      client: {
        createCompletion: async options => {
          const allowed = (options.tools || []).map(tool => tool.function.name);
          stages.push(allowed.join(','));
          if (allowed.join(',') === 'write_file') {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: draftedWriteup
                }
              }]
            };
          }
          if (allowed.join(',') === 'remember') {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  tool_calls: [{
                    id: 'remember-drafted-paper',
                    function: {
                      name: 'remember',
                      arguments: JSON.stringify({ content: 'The partnership paper landed with evidence.' })
                    }
                  }]
                }
              }]
            };
          }
          return {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'finish-drafted-paper',
                  function: {
                    name: 'finish',
                    arguments: JSON.stringify({ summary: 'Partnership paper landed.' })
                  }
                }]
              }
            }]
          };
        }
      }
    });

    loop.start();
    await loop._promise;

    expect(stages).to.deep.equal(['write_file', 'remember', 'finish']);
    expect(loop.finished).to.equal(true);
    expect(fs.readFileSync(path.join(runtimePath, 'outputs', writeupPath), 'utf8')).to.equal(draftedWriteup);
    const stream = fs.readFileSync(path.join(runtimePath, 'outputs', 'stream.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(stream.some(entry => entry.kind === 'writeup')).to.equal(true);
    expect(stream.some(entry => entry.kind === 'thought'
      && String(entry.content).includes('Documented partnership finding'))).to.equal(false);
  });

  it('takes an earlier full drafted thought back off the phase tape when write becomes required', async () => {
    const runtimePath = tempRuntime();
    const writeupPath = 'drill/goal-3/phase-2-tape-paper.md';
    const draftedWriteup = [
      '# Tape-owned paper',
      '',
      ...Array.from(
        { length: 220 },
        (_, index) => `Evidence paragraph ${index + 1}: the archive record supports the phase conclusion in detail.`
      )
    ].join('\n\n');
    const stages = [];
    const loop = new LaunchLoop({
      logger,
      plan: {
        shortPlan: {
          goal: 'Research, then land the paper',
          constraints: [],
          deliverable: 'Write the phase paper.',
          writeupPath
        }
      },
      drill: { goalNumber: 3, phaseNumber: 2, workerId: 'w8', cycle: 1 },
      config: { models: { primary: 'test' }, logsDir: runtimePath },
      maxTurns: 7,
      client: {
        createCompletion: async options => {
          const allowed = (options.tools || []).map(tool => tool.function.name);
          stages.push(allowed);
          if (allowed.length > 1) {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: draftedWriteup
                }
              }]
            };
          }
          if (allowed[0] === 'write_file') {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'I am writing now.'
                }
              }]
            };
          }
          if (allowed[0] === 'remember') {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  tool_calls: [{
                    id: 'remember-tape-paper',
                    function: {
                      name: 'remember',
                      arguments: JSON.stringify({ content: 'The tape-owned paper landed.' })
                    }
                  }]
                }
              }]
            };
          }
          return {
            choices: [{
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'finish-tape-paper',
                  function: {
                    name: 'finish',
                    arguments: JSON.stringify({ summary: 'Tape-owned paper landed.' })
                  }
                }]
              }
            }]
          };
        }
      }
    });

    loop.start();
    await loop._promise;

    expect(stages.map(names => names.length === 1 ? names[0] : 'research'))
      .to.deep.equal(['research', 'write_file', 'remember', 'finish']);
    expect(loop.finished).to.equal(true);
    expect(fs.readFileSync(path.join(runtimePath, 'outputs', writeupPath), 'utf8')).to.equal(draftedWriteup);
    const stream = fs.readFileSync(path.join(runtimePath, 'outputs', 'stream.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const draftedThought = stream.find(entry => entry.kind === 'thought');
    expect(draftedThought.content).to.equal(draftedWriteup);
    expect(stream.some(entry => entry.kind === 'writeup')).to.equal(true);
  });

  it('fails the worker after one same-turn retry when write_file is still refused', async () => {
    const runtimePath = tempRuntime();
    const calls = [];
    const loop = new LaunchLoop({
      logger,
      plan: {
        shortPlan: {
          goal: 'Land the work',
          constraints: [],
          deliverable: 'Write it.',
          writeFirst: true
        }
      },
      config: { models: { primary: 'test' }, logsDir: runtimePath },
      maxTurns: 24,
      client: {
        createCompletion: async options => {
          calls.push(options);
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: 'Here is a long draft that is not a tool call.'
              }
            }]
          };
        }
      }
    });

    loop.start();
    await loop._promise;

    expect(calls).to.have.length(2);
    expect(loop.turns).to.equal(1);
    expect(loop.finished).to.equal(false);
    expect(loop.getStatus().status).to.equal('error');
    expect(loop.protocolError).to.include('write_file');
    expect(loop.messages.some(message => message.role === 'assistant')).to.equal(false);
    expect(fs.existsSync(path.join(runtimePath, 'outputs', 'stream.jsonl'))).to.equal(false);
  });

  it('forces a later taped worker to write on its first model turn', () => {
    const runtimePath = tempRuntime();
    const loop = new LaunchLoop({
      logger,
      plan: {
        shortPlan: {
          goal: 'Stop the talk tax',
          constraints: ['WRITE FIRST'],
          deliverable: 'Land the writeup.',
          writeupPath: 'drill/goal-1/phase-1-stop-talk.md',
          writeFirst: true
        }
      },
      drill: { goalNumber: 1, phaseNumber: 1, workerId: 'w2', cycle: 2 },
      evidence: { streamed: 380 },
      config: { models: { primary: 'test' }, logsDir: runtimePath },
      maxTurns: 24
    });

    loop.turns = 1;
    expect(loop.toolPolicy()).to.deep.include({
      allowedNames: ['write_file'],
      toolChoice: 'required',
      stage: 'write'
    });
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

  it('does not let one phase close on another phase writeup', async () => {
    const runtimePath = tempRuntime();
    const phaseOne = {
      drill: { goalNumber: 1, phaseNumber: 1, workerId: 'w1', cycle: 1 },
      expectedOutput: 'outputs/drill/goal-1/phase-1.md',
      evidence: { streamed: 1 },
      finished: false,
      markFinished(summary) { this.finished = true; this.summary = summary; }
    };
    const phaseTwo = {
      drill: { goalNumber: 1, phaseNumber: 2, workerId: 'w2', cycle: 2 },
      expectedOutput: 'outputs/drill/goal-1/phase-2.md',
      evidence: { streamed: 1 },
      finished: false,
      markFinished(summary) { this.finished = true; this.summary = summary; }
    };
    await executeTool('write_file', {
      path: 'drill/goal-1/phase-1.md',
      content: '# Phase one\n\nA concrete phase-one finding is on disk.'
    }, { runtimePath, logger, loop: phaseOne });

    const refused = JSON.parse(await executeTool(
      'finish',
      { summary: 'Phase two done' },
      { runtimePath, logger, loop: phaseTwo }
    ));
    expect(refused.reason).to.equal('missing_receipt');
    expect(phaseTwo.finished).to.equal(false);

    await executeTool(
      'finish',
      { summary: 'Phase one done' },
      { runtimePath, logger, loop: phaseOne }
    );
    expect(phaseOne.finished).to.equal(true);
  });

  it('does not let a file written to another run close this run', async () => {
    const correctRun = tempRuntime('cosmo-correct-run-');
    const wrongRun = tempRuntime('cosmo-wrong-run-');
    const provenance = {
      drill: { goalNumber: 2, phaseNumber: 1, workerId: 'w10', cycle: 10 },
      expectedOutput: 'outputs/garcia_partnership.md',
      evidence: { streamed: 4 },
      finished: false,
      markFinished(summary) { this.finished = true; this.summary = summary; }
    };
    await executeTool('write_file', {
      path: 'garcia_partnership.md',
      content: '# Garcia partnership\n\nThis file landed in the wrong run.'
    }, { runtimePath: wrongRun, logger, loop: provenance });

    const refused = JSON.parse(await executeTool(
      'finish',
      { summary: 'Partnership phase done' },
      { runtimePath: correctRun, logger, loop: provenance }
    ));
    expect(refused.reason).to.equal('missing_receipt');
    expect(provenance.finished).to.equal(false);
    expect(fs.existsSync(path.join(correctRun, 'outputs', 'garcia_partnership.md'))).to.equal(false);
    expect(fs.existsSync(path.join(wrongRun, 'outputs', 'garcia_partnership.md'))).to.equal(true);
  });
});

describe('write_file deliverable protection', () => {
  it('normalizes a mission-style outputs/ prefix without nesting outputs twice', async () => {
    const runtimePath = tempRuntime();
    const args = {
      path: 'outputs/drill/goal-3/phase-2.md',
      content: '# Phase two\n\nThe partnership analysis is landed.'
    };

    const result = await executeTool('write_file', args, { runtimePath, logger });

    expect(result).to.match(/^File written: outputs\/drill\/goal-3\/phase-2\.md/);
    expect(args.path).to.equal('drill/goal-3/phase-2.md');
    expect(fs.existsSync(path.join(runtimePath, 'outputs', 'drill', 'goal-3', 'phase-2.md'))).to.equal(true);
    expect(fs.existsSync(path.join(runtimePath, 'outputs', 'outputs'))).to.equal(false);
  });

  it('refuses to replace a substantive markdown writeup with a thin same-path write', async () => {
    const runtimePath = tempRuntime();
    const writePath = 'garcia_partnership.md';
    const substantive = `# Garcia partnership\n\n${'Documented evidence and analysis. '.repeat(220)}`;
    const thin = '# Garcia partnership\n\nThin replacement.';

    const first = await executeTool('write_file', {
      path: writePath,
      content: substantive
    }, { runtimePath, logger });
    const second = await executeTool('write_file', {
      path: writePath,
      content: thin
    }, { runtimePath, logger });

    expect(first).to.match(/^File written:/);
    expect(second).to.include('Refusing to replace substantive');
    expect(fs.readFileSync(path.join(runtimePath, 'outputs', writePath), 'utf8')).to.equal(substantive);
  });
});
