import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationHistory } from '../../src/agent/history.js';
import { DurableExecutionSteering, createExecutionControlPort } from '../../src/agent/execution-control.js';

test('exact steering survives a lost reply, applies once, and never appears in sibling model history', () => {
  const root = mkdtempSync(join(tmpdir(), 'console-steer-'));
  try {
    const history = new ConversationHistory(root, 400_000, 'agent');
    const active = new Set(['t_one', 't_sibling']);
    const steering = new DurableExecutionSteering(history, (_chat, turn) => active.has(turn));
    const request = { chatId: 'shared', turnId: 't_one', idempotencyKey: 'note-1', text: 'inspect the exact source' };
    assert.equal(steering.enqueue(request).status, 'queued');
    assert.equal(steering.enqueue(request).status, 'queued');
    const inputs: string[] = [];
    steering.consume('shared', 't_sibling', value => inputs.push(value));
    assert.deepEqual(inputs, []);
    assert.deepEqual(history.load('shared'), []);
    steering.consume('shared', 't_one', value => inputs.push(value));
    steering.consume('shared', 't_one', value => inputs.push(value));
    assert.deepEqual(inputs, ['[Operator steer] inspect the exact source']);
    assert.deepEqual(history.load('shared'), [], 'applied note must not leak into the successor chat');
    const recovered = new DurableExecutionSteering(history, () => false);
    assert.equal(recovered.enqueue(request).status, 'applied');
    assert.equal(recovered.enqueue({ ...request, turnId: 't_sibling' }).reason, 'idempotency_conflict');
    const raw = history.loadRaw('shared') as Array<Record<string, unknown>>;
    assert.equal(raw.filter(record => record.role === 'user').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pending steer is not transferred to a later turn or asserted applied after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'console-steer-end-'));
  try {
    const history = new ConversationHistory(root, 400_000, 'agent');
    const request = { chatId: 'shared', turnId: 't_old', idempotencyKey: 'pending', text: 'keep this private to old' };
    new DurableExecutionSteering(history, () => true).enqueue(request);
    const restored = new DurableExecutionSteering(history, (_chat, turn) => turn === 't_new');
    assert.equal(restored.enqueue(request).status, 'not_applied');
    const inputs: string[] = [];
    restored.consume('shared', 't_new', text => inputs.push(text));
    assert.deepEqual(inputs, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime cancellation checks exact turn, persists idempotency, and does not stop a sibling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'console-cancel-'));
  try {
    const active = new Set(['t_old', 't_new']);
    const stops: string[] = [];
    const deps = { instanceDir: root, agent: {
      isTurnActive: (_chat: string, turn: string) => active.has(turn),
      executionTurnState: (_chat: string, turn: string) => active.has(turn) ? 'active' as const : 'terminal' as const,
      steerExecution: () => { throw new Error('not used'); },
      stop: (_chat: string, turn: string) => { stops.push(turn); active.delete(turn); return { stopped: true }; },
    } };
    const request = { operation: 'cancel' as const, chatId: 'shared', turnId: 't_old', expectedTurnId: 't_old', idempotencyKey: 'stop-1' };
    const first = await createExecutionControlPort(deps).execute(request);
    assert.equal(first.status, 'cancellation_requested');
    assert.equal((await createExecutionControlPort(deps).execute(request)).operationId, first.operationId);
    assert.deepEqual(stops, ['t_old']);
    assert.ok(active.has('t_new'));
    const conflict = await createExecutionControlPort(deps).execute({ ...request, turnId: 't_new', expectedTurnId: 't_new' });
    assert.equal(conflict.reason, 'idempotency_conflict');
    const mismatched = await createExecutionControlPort(deps).execute({ ...request, idempotencyKey: 'stop-2', expectedTurnId: 't_new' });
    assert.equal(mismatched.status, 'stale_target');
    assert.deepEqual(stops, ['t_old']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
