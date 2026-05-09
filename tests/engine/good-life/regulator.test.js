import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.equal(acted.length, 1);
  assert.equal(acted[0].context.actor, 'good-life-regulator');
});

test('GoodLifeRegulator appends agenda event when AgendaStore is not ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-regulator-'));
  const regulator = new GoodLifeRegulator({ brainDir: dir, throttleMs: 1 });

  const result = await regulator.handleObservation(recoverObservation());
  const agenda = readFileSync(join(dir, 'agenda.jsonl'), 'utf8').trim();

  assert.equal(result.status, 'queued_no_motor');
  assert.match(agenda, /Good Life recovery drift/);
  assert.match(agenda, /"sourceSignal":"good-life"/);
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
