import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');
const { LiveProblemStore } = require('../../../engine/src/live-problems/store.js');

test('agenda Do it queues bounded operational items into live-problems diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-agenda-doit-'));
  try {
    const store = new LiveProblemStore({
      brainDir: dir,
      logger: { info() {}, warn() {}, error() {} },
    });
    const fake = {
      liveProblems: {
        store,
        processNow: async (id) => store.get(id),
      },
      isBoundedOperationalAgendaItem: Orchestrator.prototype.isBoundedOperationalAgendaItem,
      enqueueAgendaDiagnostic: Orchestrator.prototype.enqueueAgendaDiagnostic,
      inferAgendaAction: Orchestrator.prototype.inferAgendaAction,
    };

    const result = await Orchestrator.prototype.executeAgendaItem.call(fake, {
      id: 'ag-test',
      content: "Investigate why RECENT.md hasn't auto-generated in 9 days — is the generation trigger present but failing silently?",
    }, { actor: 'test' });

    assert.equal(result.action, 'diagnose_agenda');
    assert.equal(result.target, 'agenda_ag-test');

    const problem = store.get('agenda_ag-test');
    assert.ok(problem);
    assert.equal(problem.seedOrigin, 'agenda');
    assert.equal(problem.verifier.type, 'fix_recipe_recorded');
    assert.equal(problem.verifier.args.problemId, 'agenda_ag-test');
    assert.equal(problem.remediation[0].type, 'dispatch_to_agent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life agenda items route to governance disposition instead of live-problem diagnostics, without writing a receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-agenda-'));
  try {
    const store = new LiveProblemStore({
      brainDir: dir,
      logger: { info() {}, warn() {}, error() {} },
    });
    const fake = {
      logsDir: dir,
      liveProblems: {
        store,
        processNow: async (id) => store.get(id),
      },
      logger: { info() {}, warn() {} },
      recordGoodLifeAgendaAction: Orchestrator.prototype.recordGoodLifeAgendaAction,
      enqueueAgendaDiagnostic: Orchestrator.prototype.enqueueAgendaDiagnostic,
      inferAgendaAction: Orchestrator.prototype.inferAgendaAction,
    };

    const result = await Orchestrator.prototype.executeAgendaItem.call(fake, {
      id: 'ag-good-life',
      sourceSignal: 'good-life',
      content: 'Diagnose Good Life repair drift using instances/jerry/brain/good-life-state.json and engine logs.',
      temporalContext: {
        policy: 'repair',
        lanes: ['viability:critical'],
        usefulnessContract: { passes: true, category: 'resolves-drift' },
      },
    }, { actor: 'good-life-regulator', origin: 'good-life' });

    assert.equal(result.action, 'good_life_governance');
    assert.equal(result.status, 'recorded');
    assert.equal(result.directAction, true, 'must still signal a real disposition so motor-cortex marks the agenda item acted_on');
    // The whole point of this branch is to route away from the live-problem
    // diagnostic path -- that must still hold with the receipt write gone.
    assert.equal(store.all().length, 0);
    // A gate/disposition does not need a receipt: nothing in the codebase
    // ever reads good-life-actions.jsonl (grep confirmed it), so it must
    // not be written at all now.
    assert.equal(existsSync(join(dir, 'good-life-actions.jsonl')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
