import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryObjectStore } from '../../src/agent/memory-objects.js';
import { promoteToMemoryTool, flushMemorySeedProjections } from '../../src/agent/tools/promote.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-memory-projection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(workspacePath);
  const store = new MemoryObjectStore(path.join(root, 'brain'));
  const ctx = { workspacePath, chatId: 'chat:owner', memoryObjectStore: store, agentName: 'resident' } as any;
  const input = { type: 'observation', domain: 'personal', title: 'Replacement vehicle',
    statement: 'The owner leased an blue Atlas pickup and still enjoys an earlier electric car.',
    before: 'Replacement vehicle was unresolved.', after: 'Atlas lease confirmed; the earlier car remains available.',
    why: 'The owner explained the replacement in conversation.', trigger_keywords: 'Atlas,electric car',
    applies_to: 'personal,vehicles', excludes: 'routine machine contact' };
  return { root, store, ctx, input };
}

test('a new personal fact retains its before/after and scope without becoming conduct feedback', async t => {
  const { root, ctx, input } = fixture(t);
  const result = await promoteToMemoryTool.execute(input, ctx);
  assert.equal(result.is_error, undefined, result.content);
  assert.match(result.content, /Memory stored; source projection=projected; Seed application=not yet confirmed/);
  const events = fs.readFileSync(path.join(root, 'brain', 'memory-objects.events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 1);
  const { payload } = events[0];
  assert.equal(payload.type, 'memory_promotion');
  assert.equal(payload.memory_type, 'observation');
  assert.equal(payload.learningVersion, 2);
  assert.equal(payload.learning, undefined);
  assert.equal(payload.state_delta.before.state, input.before);
  assert.equal(payload.state_delta.after.state, input.after);
  assert.deepEqual(payload.scope.excludes, ['routine machine contact']);
});

test('failed promotion projection remains retryable in the same store and deduplicates a crash boundary', async t => {
  const { root, ctx, input } = fixture(t);
  const events = path.join(root, 'brain', 'memory-objects.events.jsonl');
  fs.mkdirSync(events);
  const result = await promoteToMemoryTool.execute(input, ctx);
  assert.equal(result.is_error, undefined, 'the memory exists even when projection is pending');
  assert.match(result.content, /Memory stored; source projection=pending/);
  const objectsFile = path.join(root, 'brain', 'memory-objects.json');
  assert.equal(JSON.parse(fs.readFileSync(objectsFile, 'utf8')).objects.length, 1);
  const original = JSON.parse(fs.readFileSync(objectsFile, 'utf8'));
  original.objects[0].updated_at = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(objectsFile, JSON.stringify(original));
  fs.rmdirSync(events);
  const restarted = { ...ctx, memoryObjectStore: new MemoryObjectStore(path.join(root, 'brain')) };
  assert.deepEqual(await flushMemorySeedProjections(restarted), { projected: 1, pending: 0 });
  const disk = JSON.parse(fs.readFileSync(objectsFile, 'utf8'));
  assert.equal(disk.objects[0].updated_at, '2026-01-01T00:00:00.000Z', 'transport acknowledgement cannot make an old fact fresh');
  disk.objects[0].seed_projection.status = 'pending';
  fs.writeFileSync(objectsFile, JSON.stringify(disk));
  // The original instance was constructed before the pending projection.
  // A fresh disk read, not its stale cache, must find and acknowledge it.
  assert.deepEqual(await flushMemorySeedProjections(ctx), { projected: 1, pending: 0 });
  assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(await flushMemorySeedProjections(ctx), { projected: 0, pending: 0 });
});
