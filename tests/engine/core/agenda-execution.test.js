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
    assert.equal(problem.problemKind, 'agenda_handoff');
    assert.equal(problem.handoff.status, 'pending');
    assert.equal(
      Date.parse(problem.handoff.deadlineAt) - Date.parse(problem.handoff.startedAt),
      4 * 60 * 60 * 1000,
    );
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

test('real agenda routing keeps undispatched work active and records dispatch separately from its result', async () => {
  const { AgendaStore } = require('../../../engine/src/cognition/agenda-store.js');
  const { MotorCortex } = require('../../../engine/src/cognition/motor-cortex.js');
  const dir = mkdtempSync(join(tmpdir(), 'home23-agenda-routing-'));
  try {
    const logger = { info() {}, warn() {}, error() {} };
    const store = new LiveProblemStore({ brainDir: dir, logger });
    const agendaStore = new AgendaStore({ brainDir: dir, logger });
    const orchestrator = Object.create(Orchestrator.prototype);
    orchestrator.logger = logger;
    orchestrator.agendaStore = agendaStore;
    orchestrator.liveProblems = { store, processNow: async id => store.get(id) };
    const item = agendaStore.add({
      content: 'Investigate why RECENT.md has not regenerated in 9 days.', kind: 'question', topicTags: ['ops'],
    });
    assert.ok(item);
    const motor = new MotorCortex({
      logger, agendaStore,
      canAct: item => Boolean(orchestrator.inferAgendaAction(item) || orchestrator.isBoundedOperationalAgendaItem(item)),
      executeAgendaItem: (item, opts) => orchestrator.executeAgendaItem(item, opts),
    });
    const queued = await motor.actOnAgendaItem(item);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.action.turnId, null);
    assert.ok(['candidate', 'surfaced'].includes(agendaStore.get(item.id).status));
    assert.equal(agendaStore.get(item.id).history.some(row => row.status === 'acted_on'), false);
    assert.ok(store.get(queued.action.problemId));

    // The actual admin endpoint must preserve this distinction too.
    const { RealtimeServer } = require('../../../engine/src/realtime/websocket-server.js');
    const server = Object.create(RealtimeServer.prototype);
    server.orchestrator = orchestrator;
    server._readJsonBody = async () => ({ status: 'acted_on', actor: 'owner' });
    let response;
    await server._handleAgendaAdmin({ method: 'POST', url: `/admin/agenda/${item.id}/status` }, {
      writeHead(code) { assert.equal(code, 200); }, end(body) { response = JSON.parse(body); },
    });
    assert.equal(response.execution.disposition, 'queued');
    assert.notEqual(response.item.status, 'acted_on');

    orchestrator.liveProblems.processNow = async id => ({ ...store.get(id), dispatchedTurnId: 'actual-dispatch-receipt' });
    const dispatched = await motor.actOnAgendaItem(item);
    assert.equal(dispatched.status, 'dispatched');
    assert.equal(agendaStore.get(item.id).status, 'acted_on');
    assert.match(agendaStore.get(item.id).history.at(-1).note, /result pending/);
    assert.equal(store.get(queued.action.problemId).handoff.status, 'pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('action dispatch failures and dry runs do not close an agenda item', async () => {
  const { MotorCortex } = require('../../../engine/src/cognition/motor-cortex.js');
  const changes = [];
  const opts = {
    logger: { info() {}, warn() {}, error() {} },
    canAct: () => true,
    agendaStore: { updateStatus(...args) { changes.push(args); } },
  };
  const item = { id: 'pending', content: 'Refresh the weather sensor.' };
  const failed = await new MotorCortex({ ...opts, executeAgendaItem: async () => { throw new Error('route unavailable'); } }).actOnAgendaItem(item);
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail, /route unavailable/);
  const simulated = await new MotorCortex({ ...opts, executeAgendaItem: async () => ({ action: 'refresh_sensor', target: 'weather', directAction: true, status: 'dry_run' }) }).actOnAgendaItem(item);
  assert.equal(simulated.status, 'simulated');
  assert.deepEqual(changes, []);
});
