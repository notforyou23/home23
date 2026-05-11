import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator');

function makeHarness(dir, processAction) {
  const logs = [];
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.config = { logsDir: dir };
  orchestrator.cycleCount = 42;
  orchestrator.processAction = processAction;
  orchestrator.logger = {
    info: (message, meta) => logs.push({ level: 'info', message, meta }),
    warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
    error: (message, meta) => logs.push({ level: 'error', message, meta }),
  };
  return { orchestrator, logs };
}

test('pollActionQueue writes completion receipts and skips duplicate idempotency keys', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-actions-'));
  const queuePath = path.join(dir, 'actions-queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({
    actions: [
      { actionId: 'a1', idempotencyKey: 'complete_task:t1', type: 'complete_task', status: 'pending' },
      { actionId: 'a2', idempotencyKey: 'complete_task:t1', type: 'complete_task', status: 'pending' },
    ],
  }), 'utf8');

  let calls = 0;
  const { orchestrator } = makeHarness(dir, async () => { calls++; });
  await orchestrator.pollActionQueue();

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(calls, 1);
  assert.equal(queue.actions[0].status, 'completed');
  assert.equal(queue.actions[1].status, 'completed');
  assert.equal(queue.actions[1].completedViaReceipt, true);

  const receipts = fs.readFileSync(path.join(dir, 'actions-receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].actionId, 'a1');
  assert.equal(receipts[0].idempotencyKey, 'complete_task:t1');
});

test('pollActionQueue records phase transition proof for shared queue mutation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-actions-'));
  const queuePath = path.join(dir, 'actions-queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({
    actions: [
      { actionId: 'a1', idempotencyKey: 'complete_task:t1', type: 'complete_task', status: 'pending' },
      { actionId: 'a2', idempotencyKey: 'complete_task:t2', type: 'complete_task', status: 'pending' },
    ],
  }), 'utf8');

  const { orchestrator } = makeHarness(dir, async () => {});
  await orchestrator.pollActionQueue();

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const receipts = fs.readFileSync(path.join(dir, 'actions-receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const receipt = receipts.find((entry) => entry.actionId === 'a1');

  assert.equal(receipt.phaseTransition.schema, 'home23.phase-transition.v1');
  assert.equal(receipt.phaseTransition.sourceIssues.includes(92), true);
  assert.equal(receipt.phaseTransition.crossing, 'action_queue_pending_to_completed');
  assert.equal(receipt.phaseTransition.priorRead.path, queuePath);
  assert.equal(receipt.phaseTransition.priorRead.pendingCount, 2);
  assert.equal(receipt.phaseTransition.mutation.scope, 'single_action_status_transition');
  assert.deepEqual(receipt.phaseTransition.mutation.fieldsChanged, ['status', 'completedAt', 'completedCycle']);
  assert.equal(receipt.phaseTransition.postCheck.actionStatus, 'completed');
  assert.equal(receipt.phaseTransition.postCheck.queueReadBack, true);
  assert.equal(receipt.phaseTransition.postCheck.receiptAppended, true);
  assert.equal(receipt.phaseTransition.proof.afterQueueSha256.length, 64);
  assert.equal(receipt.phaseTransition.remaining.pendingActions, 0);
  assert.equal(queue.actions.every((action) => action.status === 'completed'), true);
});

test('pollActionQueue skips stale pending actions already present in receipt log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-actions-'));
  const queuePath = path.join(dir, 'actions-queue.json');
  const receiptsPath = path.join(dir, 'actions-receipts.jsonl');
  fs.writeFileSync(receiptsPath, JSON.stringify({
    at: '2026-04-24T12:00:00Z',
    actionId: 'a1',
    idempotencyKey: 'complete_plan:p1',
    type: 'complete_plan',
    status: 'completed',
  }) + '\n', 'utf8');
  fs.writeFileSync(queuePath, JSON.stringify({
    actions: [
      { actionId: 'a1', idempotencyKey: 'complete_plan:p1', type: 'complete_plan', status: 'pending' },
    ],
  }), 'utf8');

  let calls = 0;
  const { orchestrator } = makeHarness(dir, async () => { calls++; });
  await orchestrator.pollActionQueue();

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(calls, 0);
  assert.equal(queue.actions[0].status, 'completed');
  assert.equal(queue.actions[0].completedViaReceipt, true);
});
