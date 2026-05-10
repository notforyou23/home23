import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GoodLifeRegulator } = require('../../../engine/src/good-life/regulator.js');

function recoverObservation() {
  return {
    traceId: 'trace-good-life-1',
    channelId: 'domain.good-life',
    sourceRef: 'good-life:recover:2026-05-01T14:34:20.161Z',
    payload: {
      evaluatedAt: '2026-05-01T14:34:20.161Z',
      summary: 'recover - critical recovery drift',
      lanes: {
        viability: { status: 'healthy', reasons: [] },
        continuity: { status: 'strained', reasons: ['118 pending agenda item(s)'] },
        recovery: { status: 'critical', reasons: ['crash recovery is active'] },
      },
      policy: {
        mode: 'recover',
        reason: 'critical recovery drift',
        actionCard: {
          intent: 'recover',
          goodLifeLanes: ['continuity', 'recovery'],
          evidenceRequired: true,
          riskTier: 1,
          reversible: true,
        },
      },
    },
  };
}

function learnObservation() {
  const obs = recoverObservation();
  obs.sourceRef = 'good-life:learn:2026-05-01T15:00:00.000Z';
  obs.payload.evaluatedAt = '2026-05-01T15:00:00.000Z';
  obs.payload.summary = 'learn - no critical drift; pursue learning progress while staying useful';
  obs.payload.evidence = {
    liveProblems: { open: 0, chronic: 0, resolved: 3, unverifiable: 0 },
  };
  obs.payload.lanes = {
    viability: { status: 'healthy', reasons: ['core engine evidence is flowing'] },
    usefulness: { status: 'watch', reasons: ['usefulness must be proven by visible progress'] },
    recovery: { status: 'watch', reasons: ['recovery is available but not currently needed'] },
  };
  obs.payload.policy.mode = 'learn';
  obs.payload.policy.reason = 'no critical drift; pursue learning progress while staying useful';
  obs.payload.policy.actionCard.intent = 'learn';
  obs.payload.policy.actionCard.riskTier = 0;
  return obs;
}

test('GoodLifeRegulator routes recover policy through agenda and motor cortex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const added = [];
  const acted = [];
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    getAgendaStore: () => ({
      add(params) {
        added.push(params);
        return { id: 'ag-good-life-1', content: params.content, status: 'candidate' };
      },
    }),
    getMotorCortex: () => ({
      async actOnAgendaItem(item, context) {
        acted.push({ item, context });
        return { status: 'acted', agendaId: item.id, action: { action: 'diagnose_agenda' } };
      },
    }),
  });

  const result = await regulator.handleObservation(recoverObservation());

  assert.equal(result.status, 'acted');
  assert.equal(added.length, 1);
  assert.equal(added[0].sourceSignal, 'good-life');
  assert.match(added[0].content, /^Diagnose Good Life recovery drift/);
  assert.match(added[0].content, /Recommended worker: systems/);
  assert.equal(added[0].temporalContext.workerRoute.worker, 'systems');
  assert.equal(added[0].topicTags.includes('worker:systems'), true);
  assert.equal(acted.length, 1);
  assert.equal(acted[0].context.actor, 'good-life-regulator');
});

test('GoodLifeRegulator stales older Good Life agenda rows when AgendaStore is ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const added = [];
  const staleUpdates = [];
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    getAgendaStore: () => ({
      list(filter) {
        assert.deepEqual(filter.status, ['candidate', 'surfaced', 'acknowledged']);
        return [
          { id: 'ag-good-life-old', status: 'candidate', sourceSignal: 'good-life', topicTags: ['good-life'] },
          { id: 'ag-other', status: 'candidate', sourceSignal: 'anomaly', topicTags: ['cron'] },
        ];
      },
      updateStatus(id, status, opts) {
        staleUpdates.push({ id, status, opts });
        return { id, status };
      },
      add(params) {
        added.push(params);
        return { id: 'ag-good-life-new', content: params.content, status: 'candidate' };
      },
    }),
  });

  const result = await regulator.handleObservation(recoverObservation());

  assert.equal(result.status, 'queued_no_motor');
  assert.equal(staleUpdates.length, 1);
  assert.equal(staleUpdates[0].id, 'ag-good-life-old');
  assert.equal(staleUpdates[0].status, 'stale');
  assert.equal(staleUpdates[0].opts.actor, 'good-life-regulator');
  assert.equal(staleUpdates[0].opts.skipReconcile, true);
  assert.equal(added[0].temporalContext.staledPriorGoodLifeAgenda, 1);
});

test('GoodLifeRegulator stales superseded repair work before self-maintenance budget blocks new work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  writeFileSync(join(dir, 'good-life-regulator-state.json'), JSON.stringify({
    daily: {
      date: new Date().toISOString().slice(0, 10),
      selfMaintenanceActions: 4,
      actions: [],
    },
  }));
  const staleUpdates = [];
  let added = 0;
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    getAgendaStore: () => ({
      list(filter) {
        assert.deepEqual(filter.status, ['candidate', 'surfaced', 'acknowledged']);
        return [
          {
            id: 'ag-repair-old',
            status: 'candidate',
            sourceSignal: 'good-life',
            topicTags: ['good-life', 'good-life:repair'],
            temporalContext: { policy: 'repair' },
          },
          {
            id: 'ag-learn-current',
            status: 'candidate',
            sourceSignal: 'good-life',
            topicTags: ['good-life', 'good-life:learn'],
            temporalContext: { policy: 'learn' },
          },
          {
            id: 'ag-other',
            status: 'candidate',
            sourceSignal: 'anomaly',
            topicTags: ['cron'],
          },
        ];
      },
      updateStatus(id, status, opts) {
        staleUpdates.push({ id, status, opts });
        return { id, status };
      },
      add() {
        added += 1;
        return { id: `ag-${added}`, status: 'candidate' };
      },
    }),
  });

  const result = await regulator.handleObservation(learnObservation());

  assert.equal(result.status, 'blocked_self_maintenance_budget');
  assert.equal(result.staledSupersededRepair, 1);
  assert.equal(added, 0);
  assert.deepEqual(staleUpdates.map((row) => row.id), ['ag-repair-old']);
  assert.equal(staleUpdates[0].status, 'stale');
  assert.equal(staleUpdates[0].opts.note, 'superseded by current Good Life state with no open live problems');
  assert.equal(staleUpdates[0].opts.skipReconcile, true);
});

test('GoodLifeRegulator stales cleared rest and help drift before budget blocks new work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  writeFileSync(join(dir, 'good-life-regulator-state.json'), JSON.stringify({
    daily: {
      date: new Date().toISOString().slice(0, 10),
      selfMaintenanceActions: 4,
      actions: [],
    },
  }));
  const staleUpdates = [];
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    getAgendaStore: () => ({
      list(filter) {
        assert.deepEqual(filter.status, ['candidate', 'surfaced', 'acknowledged']);
        return [
          {
            id: 'ag-rest-old',
            status: 'candidate',
            sourceSignal: 'good-life',
            topicTags: ['good-life', 'good-life:rest', 'good-life:friction-strained'],
            temporalContext: { policy: 'rest', lanes: ['usefulness:watch', 'friction:strained'] },
          },
          {
            id: 'ag-help-old',
            status: 'candidate',
            sourceSignal: 'good-life',
            topicTags: ['good-life', 'good-life:help', 'good-life:continuity-strained'],
            temporalContext: { policy: 'help', lanes: ['continuity:strained', 'usefulness:watch'] },
          },
          {
            id: 'ag-learn-current',
            status: 'candidate',
            sourceSignal: 'good-life',
            topicTags: ['good-life', 'good-life:learn'],
            temporalContext: { policy: 'learn', lanes: ['usefulness:watch'] },
          },
        ];
      },
      updateStatus(id, status, opts) {
        staleUpdates.push({ id, status, opts });
        return { id, status };
      },
    }),
  });

  const result = await regulator.handleObservation(learnObservation());

  assert.equal(result.status, 'blocked_self_maintenance_budget');
  assert.equal(result.staledSupersededDrift, 2);
  assert.deepEqual(staleUpdates.map((row) => row.id), ['ag-rest-old', 'ag-help-old']);
  assert.equal(staleUpdates[0].status, 'stale');
  assert.equal(staleUpdates[0].opts.note, 'superseded by current Good Life state with cleared drift lanes');
});

test('GoodLifeRegulator appends agenda event when AgendaStore is not ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const regulator = new GoodLifeRegulator({ brainDir: dir, throttleMs: 1 });

  const result = await regulator.handleObservation(recoverObservation());
  const agenda = readFileSync(join(dir, 'agenda.jsonl'), 'utf8').trim();

  assert.equal(result.status, 'queued_no_motor');
  assert.match(agenda, /Good Life recovery drift/);
  assert.match(agenda, /Recommended worker: systems/);
  assert.match(agenda, /"sourceSignal":"good-life"/);
  assert.match(agenda, /"workerRoute":\{"worker":"systems"/);
});

test('GoodLifeRegulator maps continuity help drift to memory worker route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const added = [];
  const obs = recoverObservation();
  obs.payload.summary = 'help - strained continuity drift';
  obs.payload.policy.mode = 'help';
  obs.payload.policy.reason = 'strained continuity drift';
  obs.payload.policy.actionCard.intent = 'help';
  obs.payload.policy.actionCard.riskTier = 0;
  obs.payload.lanes = {
    continuity: { status: 'strained', reasons: ['open agenda rows'] },
    usefulness: { status: 'watch', reasons: ['visible progress required'] },
  };
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    getAgendaStore: () => ({
      add(params) {
        added.push(params);
        return { id: 'ag-good-life-help', content: params.content, status: 'candidate' };
      },
    }),
  });

  const result = await regulator.handleObservation(obs);

  assert.equal(result.status, 'queued_no_motor');
  assert.equal(added[0].temporalContext.workerRoute.worker, 'memory');
  assert.match(added[0].temporalContext.workerRoute.reason, /memory, agenda, and receipt inspection/);
  assert.equal(added[0].topicTags.includes('worker:memory'), true);
});

test('GoodLifeRegulator maps viability repair drift to systems worker route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const added = [];
  const obs = recoverObservation();
  obs.payload.summary = 'repair - critical viability drift';
  obs.payload.policy.mode = 'repair';
  obs.payload.policy.reason = 'critical viability drift';
  obs.payload.policy.actionCard.intent = 'repair';
  obs.payload.lanes = {
    viability: { status: 'critical', reasons: ['engine evidence missing'] },
    usefulness: { status: 'watch', reasons: ['visible progress required'] },
  };
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    getAgendaStore: () => ({
      add(params) {
        added.push(params);
        return { id: 'ag-good-life-repair', content: params.content, status: 'candidate' };
      },
    }),
  });

  const result = await regulator.handleObservation(obs);

  assert.equal(result.status, 'queued_no_motor');
  assert.equal(added[0].temporalContext.workerRoute.worker, 'systems');
  assert.match(added[0].temporalContext.workerRoute.reason, /host\/process evidence/);
  assert.equal(added[0].topicTags.includes('worker:systems'), true);
});

test('GoodLifeRegulator maps friction rest drift to systems worker route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const added = [];
  const obs = learnObservation();
  obs.payload.summary = 'rest - strained friction drift';
  obs.payload.policy.mode = 'rest';
  obs.payload.policy.reason = 'strained friction drift';
  obs.payload.policy.actionCard.intent = 'rest';
  obs.payload.policy.actionCard.riskTier = 0;
  obs.payload.lanes = {
    usefulness: { status: 'watch', reasons: ['visible progress evidence needed'] },
    friction: { status: 'strained', reasons: ['maintenance ratio is high'] },
    recovery: { status: 'watch', reasons: ['recovery is available'] },
  };
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    getAgendaStore: () => ({
      add(params) {
        added.push(params);
        return { id: 'ag-good-life-rest', content: params.content, status: 'candidate' };
      },
    }),
  });

  const result = await regulator.handleObservation(obs);

  assert.equal(result.status, 'queued');
  assert.equal(added[0].temporalContext.workerRoute.worker, 'systems');
  assert.match(added[0].content, /Recommended worker: systems/);
  assert.equal(added[0].topicTags.includes('worker:systems'), true);
});

test('GoodLifeRegulator uses the current agent brain path and worker route for learn agenda', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const brainDir = join(dir, 'instances', 'forrest', 'brain');
  mkdirSync(brainDir, { recursive: true });
  const added = [];
  const regulator = new GoodLifeRegulator({
    brainDir,
    getAgendaStore: () => ({
      add(params) {
        added.push(params);
        return { id: 'ag-good-life-learn', content: params.content, status: 'candidate' };
      },
    }),
  });

  const result = await regulator.handleObservation(learnObservation());

  assert.equal(result.status, 'queued');
  assert.match(added[0].content, /instances\/forrest\/brain\/good-life-state\.json/);
  assert.doesNotMatch(added[0].content, /instances\/jerry\/brain/);
  assert.equal(added[0].temporalContext.workerRoute.worker, 'freshness');
  assert.match(added[0].temporalContext.workerRoute.reason, /learning progress/);
  assert.equal(added[0].topicTags.includes('worker:freshness'), true);
});

test('GoodLifeRegulator falls back to absolute brain paths outside the Home23 root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const brainDir = join(dir, 'brain');
  const regulator = new GoodLifeRegulator({ brainDir });

  assert.match(regulator._evidenceBaseText(), new RegExp(`${brainDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/good-life-state\\.json`));
});

test('GoodLifeRegulator fallback stales older Good Life agenda rows before appending a new one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const regulator = new GoodLifeRegulator({ brainDir: dir, throttleMs: 1 });

  await regulator.handleObservation(recoverObservation());
  writeFileSync(join(dir, 'good-life-regulator-state.json'), '{}');
  await regulator.handleObservation(recoverObservation());

  const rows = readFileSync(join(dir, 'agenda.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const adds = rows.filter((row) => row.type === 'add');
  const staleRows = rows.filter((row) => row.type === 'status' && row.status === 'stale');

  assert.equal(adds.length, 2);
  assert.equal(staleRows.length, 1);
  assert.equal(staleRows[0].id, adds[0].id);
  assert.equal(staleRows[0].actor, 'good-life-regulator');
});

test('GoodLifeRegulator throttles repeated equivalent policy pulses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  let added = 0;
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    throttleMs: 60 * 60 * 1000,
    getAgendaStore: () => ({
      add(params) {
        added++;
        return { id: `ag-${added}`, content: params.content, status: 'candidate' };
      },
    }),
  });

  assert.equal((await regulator.handleObservation(recoverObservation())).status, 'queued_no_motor');
  assert.equal((await regulator.handleObservation(recoverObservation())).status, 'throttled');
  assert.equal(added, 1);
});

test('GoodLifeRegulator blocks modes without a usefulness contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const regulator = new GoodLifeRegulator({ brainDir: dir });
  const obs = recoverObservation();
  obs.payload.policy.mode = 'observe';

  const result = await regulator.handleObservation(obs);
  assert.equal(result.status, 'ignored');
});

test('GoodLifeRegulator caps repeated self-maintenance actions per day', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  writeFileSync(join(dir, 'good-life-regulator-state.json'), JSON.stringify({
    daily: {
      date: new Date().toISOString().slice(0, 10),
      selfMaintenanceActions: 4,
      actions: [],
    },
  }));
  let added = 0;
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    getAgendaStore: () => ({
      add(params) {
        added++;
        return { id: `ag-${added}`, content: params.content, status: 'candidate' };
      },
    }),
  });

  const blocked = await regulator.handleObservation(recoverObservation());
  assert.equal(blocked.status, 'blocked_self_maintenance_budget');
  assert.equal(added, 0);
});

test('GoodLifeRegulator does not let repair/help bypasses inflate self-maintenance budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, 'good-life-regulator-state.json'), JSON.stringify({
    daily: {
      date: today,
      selfMaintenanceActions: 7,
      actions: [
        { at: `${today}T00:00:00.000Z`, agendaId: 'ag-learn-1', mode: 'learn', category: 'grounded-learning' },
        { at: `${today}T00:05:00.000Z`, agendaId: 'ag-repair-1', mode: 'repair', category: 'resolves-drift' },
        { at: `${today}T00:10:00.000Z`, agendaId: 'ag-help-1', mode: 'help', category: 'visible-progress' },
      ],
    },
  }));
  let added = 0;
  const regulator = new GoodLifeRegulator({
    brainDir: dir,
    getAgendaStore: () => ({
      list() { return []; },
      add(params) {
        added++;
        return { id: `ag-${added}`, content: params.content, status: 'candidate' };
      },
    }),
  });

  const result = await regulator.handleObservation(learnObservation());
  assert.equal(result.status, 'queued');
  assert.equal(added, 1);

  const state = JSON.parse(readFileSync(join(dir, 'good-life-regulator-state.json'), 'utf8'));
  assert.equal(state.daily.selfMaintenanceActions, 2);
  assert.equal(state.daily.actions.at(-1).budgetedSelfMaintenance, true);
});
